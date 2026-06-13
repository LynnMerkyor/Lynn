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
    expect(buildToolCompletionSummary({ successfulToolCount: 1 })).toContain("已执行 1 个操作");
    expect(buildToolCompletionSummary({ successfulToolCount: 1 })).toContain("没有返回总结回复");
    const three = buildToolCompletionSummary({ successfulToolCount: 3 });
    expect(three).toContain("已执行 3 个操作");
    expect(three).toContain("没有返回总结回复");
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

    expect(out).toContain("工具已经返回资料");
    expect(out).toContain("网页搜索");
    expect(out).toContain("Mexico beat South Africa 2-0");
    expect(out).toContain("网页抓取");
    expect(out).toContain("Canada drew Bosnia and Herzegovina 1-1");
    expect(out).not.toContain("已执行 2 个操作");
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
    expect(out).not.toContain("extra");
  });

  it("counts at least one failure even when names were not captured", () => {
    const out = buildToolCompletionSummary({ successfulToolCount: 0, hasFailedTool: true, lastFailedTools: [] });
    expect(out).toContain("1 个失败");
  });
});
