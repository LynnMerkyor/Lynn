// issue #72 第三类(GUI 变体)回归网:工具都执行完、模型没给收尾文本时,
// turn 不许静默结束 —— 必须有一行基于真实 tool_end 计数的事实反馈。
import { describe, expect, it } from "vitest";
import { buildToolCompletionSummary } from "../server/chat/tool-turn-finalizer.js";

describe("buildToolCompletionSummary (silent tool-turn close fix)", () => {
  it("returns empty when no tools ran (keeps V0.79 no-synthetic-text rule)", () => {
    expect(buildToolCompletionSummary({ successfulToolCount: 0 })).toBe("");
    expect(buildToolCompletionSummary(null)).toBe("");
  });

  it("summarizes an all-success tool turn factually", () => {
    expect(buildToolCompletionSummary({ successfulToolCount: 1 })).toContain("本轮完成 1 个操作");
    expect(buildToolCompletionSummary({ successfulToolCount: 1 })).toContain("没有可见结果摘要");
    const three = buildToolCompletionSummary({ successfulToolCount: 3 });
    expect(three).toContain("本轮完成 3 个操作");
    expect(three).toContain("没有可见结果摘要");
  });

  it("uses realtime evidence previews when search/fetch tools succeeded but the model gave no final text", () => {
    const out = buildToolCompletionSummary({
      successfulToolCount: 2,
      lastSuccessfulTools: [
        {
          name: "web_search",
          outputPreview: "Mexico beat South Africa 2-0; South Korea beat Czechia 2-1.",
        },
        {
          name: "web_fetch",
          outputPreview: "World Cup day two schedule and results: Canada drew Bosnia and Herzegovina 1-1.",
        },
      ],
    });

    expect(out).toContain("根据本轮已执行工具返回的证据");
    expect(out).toContain("网页搜索");
    expect(out).toContain("Mexico beat South Africa 2-0");
    expect(out).toContain("网页抓取");
    expect(out).toContain("Canada drew Bosnia and Herzegovina 1-1");
    expect(out).not.toContain("已执行 2 个操作");
  });

  it("uses generic tool evidence for complex tools when available", () => {
    const out = buildToolCompletionSummary({
      successfulToolCount: 3,
      lastSuccessfulTools: [
        {
          name: "image_analyze",
          outputPreview: "检测到 2 张截图,其中一张包含报错提示。",
        },
        {
          name: "bash",
          command: "python analyze.py",
          outputPreview: "summary.csv written",
        },
      ],
    });

    expect(out).toContain("根据本轮已执行操作返回的可见结果");
    expect(out).toContain("image_analyze");
    expect(out).toContain("检测到 2 张截图");
    expect(out).toContain("bash");
    expect(out).toContain("python analyze.py");
    expect(out).not.toContain("已执行 3 个操作");
  });

  it("surfaces failures with tool names (capped at 3)", () => {
    const out = buildToolCompletionSummary({
      successfulToolCount: 2,
      hasFailedTool: true,
      lastFailedTools: ["bash", "write_file", "grep", "extra"],
    });
    expect(out).toContain("2 个成功");
    expect(out).toContain("4 个失败");
    expect(out).toContain("bash、write_file、grep");
    expect(out).not.toContain("没有返回总结回复");
    expect(out).not.toContain("extra");
  });

  it("keeps successful realtime evidence visible when a later duplicate tool fails", () => {
    const out = buildToolCompletionSummary({
      successfulToolCount: 1,
      hasFailedTool: true,
      lastFailedTools: ["stock_market"],
      lastSuccessfulTools: [
        {
          name: "stock_market",
          outputPreview: "国际现货黄金（XAU/USD） 907.29 元/克（约 4156.7 美元/盎司，USD/CNY 6.7890）",
        },
      ],
    });

    expect(out).toContain("根据本轮已执行工具返回的证据");
    expect(out).toContain("行情");
    expect(out).toContain("907.29 元/克");
    expect(out).toContain("后续工具失败");
    expect(out).not.toContain("请查看上方工具卡片中的失败项");
  });

  it("counts at least one failure even when names were not captured", () => {
    const out = buildToolCompletionSummary({ successfulToolCount: 0, hasFailedTool: true, lastFailedTools: [] });
    expect(out).toContain("1 个失败");
  });
});
