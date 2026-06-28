// issue #72 第三类(GUI 变体)回归网:工具都执行完、模型没给收尾文本时,
// turn 不许静默结束 —— 必须有一行基于真实 tool_end 计数的事实反馈。
import { describe, expect, it } from "vitest";
import {
  buildDirectWebFetchEvidenceAnswer,
  buildToolCompletionSummary,
  selectToolEvidenceVisibleText,
} from "../server/chat/tool-turn-finalizer.js";

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

    expect(out).toContain("这轮检索拿到的可核验线索有限");
    expect(out).toContain("网页搜索");
    expect(out).toContain("Mexico beat South Africa 2-0");
    expect(out).toContain("网页抓取");
    expect(out).toContain("Canada drew Bosnia and Herzegovina 1-1");
    expect(out).not.toContain("已执行 2 个操作");
  });

  it("scrubs internal research scaffolding from realtime evidence fallbacks", () => {
    const out = buildToolCompletionSummary({
      successfulToolCount: 1,
      lastSuccessfulTools: [{
        name: "web_search",
        outputPreview: [
          "【研究资料】",
          "【补充搜索线索】",
          "查询：查一下深圳 2026 年社保缴费政策有没有最新变化 最新 资料 数据 来源",
          "来源：深圳市人力资源和社会保障局",
          "摘要：2026 年缴费基数上下限以官方公告为准。",
        ].join("\n"),
      }],
    });

    expect(out).toContain("深圳市人力资源和社会保障局");
    expect(out).toContain("2026 年缴费基数上下限");
    expect(out).not.toContain("【研究资料】");
    expect(out).not.toContain("【补充搜索线索】");
    expect(out).not.toContain("最新 资料 数据 来源");
  });

  it("does not present query-only realtime scaffolding as evidence", () => {
    const out = buildToolCompletionSummary({
      successfulToolCount: 1,
      lastSuccessfulTools: [{
        name: "web_search",
        outputPreview: "【研究资料】 【补充搜索线索】 查询：查一下深圳 2026 年社保缴费政策有没有最新变化 最新 资料 数据 来源 查询：深圳社保 官方 公告 报告 文档",
      }],
    });

    expect(out).toContain("这轮检索没有拿到可核验内容");
    expect(out).not.toContain("【研究资料】");
    expect(out).not.toContain("查询：");
    expect(out).not.toContain("已执行 1 个操作");
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

    expect(out).toContain("这轮操作已有可见结果");
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

  it("turns realtime sports failures into user-facing data-source boundaries", () => {
    const out = buildToolCompletionSummary({
      originalPromptText: "今晚世界杯有几场比赛",
      successfulToolCount: 0,
      hasFailedTool: true,
      lastFailedTools: ["sports_score"],
    });

    expect(out).toContain("体育比分数据源本轮暂时不可用");
    expect(out).toContain("赛程或对阵");
    expect(out).toContain("不会把泛搜索摘要");
    expect(out).not.toContain("工具执行包含");
    expect(out).not.toContain("请查看上方工具卡片");
  });

  it("turns realtime search failures into actionable source-check guidance", () => {
    const out = buildToolCompletionSummary({
      originalPromptText: "查一下深圳 2026 年社保缴费政策有没有最新变化，给来源和不确定点",
      successfulToolCount: 0,
      hasFailedTool: true,
      lastFailedTools: ["web_search"],
    });

    expect(out).toContain("网页搜索数据源本轮暂时不可用");
    expect(out).toContain("下一步建议");
    expect(out).toContain("官方页面");
    expect(out).toContain("发布日期");
    expect(out).toContain("适用地区");
    expect(out).not.toContain("工具执行包含");
  });

  it("turns parallel research all-failures into actionable source-check guidance", () => {
    const out = buildToolCompletionSummary({
      originalPromptText: "种植户要看明天降雨和近期玉米价格，帮我查证后给风险提示",
      successfulToolCount: 0,
      hasFailedTool: true,
      lastFailedTools: ["web_search", "parallel_research"],
    });

    expect(out).toContain("网页搜索");
    expect(out).toContain("并行检索");
    expect(out).toContain("没能形成可核验结论");
    expect(out).not.toContain("工具执行包含");
    expect(out).not.toContain("工具卡片");
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

    expect(out).toContain("这轮检索拿到的可核验线索有限");
    expect(out).toContain("行情");
    expect(out).toContain("907.29 元/克");
    expect(out).toContain("后续操作失败");
    expect(out).not.toContain("请查看上方工具卡片中的失败项");
  });

  it("counts at least one failure even when names were not captured", () => {
    const out = buildToolCompletionSummary({ successfulToolCount: 0, hasFailedTool: true, lastFailedTools: [] });
    expect(out).toContain("1 个失败");
  });

  it("turns useful web_fetch evidence into a direct answer when the model dismisses it", () => {
    const state = {
      originalPromptText: "访问 example.com 并用一句话概括页面内容",
      successfulToolCount: 1,
      lastSuccessfulTools: [{
        name: "webfetch",
        outputPreview: [
          "来源: example.com/ (html→text)",
          "",
          "Example Domain",
          "",
          "This domain is for use in documentation examples without needing permission. Avoid use in operations.",
          "",
          "Learn more (https://iana.org/domains/example)",
        ].join("\n"),
      }],
    };

    expect(buildDirectWebFetchEvidenceAnswer(state)).toContain("用于文档示例");
    const selected = selectToolEvidenceVisibleText(
      state,
      "工具已经返回内容，但没有提取到足够可靠的事实来直接回答。",
    );
    expect(selected).toContain("example.com 页面");
    expect(selected).toContain("用于文档示例");
    expect(selected).not.toContain("没有提取到足够可靠");
    expect(selected).not.toContain("这轮检索拿到的可核验线索有限");
  });

  it("does not turn web_fetch errors into page summaries", () => {
    const state = {
      originalPromptText: "查一下中国游客去日本旅行签证最新材料要求，列来源和不确定点",
      successfulToolCount: 1,
      lastSuccessfulTools: [{
        name: "webfetch",
        outputPreview: "来源: example.gov\n抓取出错: 抓取失败: HTTP 403 Forbidden",
      }],
    };

    expect(buildDirectWebFetchEvidenceAnswer(state)).toBe("");
    const selected = selectToolEvidenceVisibleText(
      state,
      "页面：抓取出错: 抓取失败: HTTP 403 Forbidden\n要点：抓取出错: 抓取失败: HTTP 403 Forbidden",
    );
    expect(selected).not.toContain("HTTP 403");
    expect(selected).not.toContain("抓取出错");
  });

  it("replaces model text that leaks internal research scaffolding after web tools", () => {
    const state = {
      originalPromptText: "查一下深圳 2026 年社保缴费政策有没有最新变化，给来源和不确定点",
      successfulToolCount: 1,
      lastSuccessfulTools: [{
        name: "web_search",
        outputPreview: "【研究资料】 【补充搜索线索】 查询：深圳社保 2026 最新 资料 数据 来源 查询：深圳社保 官方 公告 报告 文档",
      }],
    };

    const selected = selectToolEvidenceVisibleText(
      state,
      "针对“【研究资料】 【补充搜索线索】 查询：深圳社保 2026 最新 资料 数据 来源”，目前可以回答如下。",
    );

    expect(selected).toContain("这轮检索没有拿到可核验内容");
    expect(selected).toContain("下一步建议");
    expect(selected).not.toContain("【研究资料】");
    expect(selected).not.toContain("查询：深圳社保");
  });

  it("replaces the internal tool-evidence confirmation template after web tools", () => {
    const state = {
      originalPromptText: "查一下深圳 2026 年社保缴费政策有没有最新变化，给来源和不确定点",
      successfulToolCount: 1,
      lastSuccessfulTools: [{
        name: "web_search",
        outputPreview: "来源：深圳市人力资源和社会保障局\n摘要：2026 年社保缴费基数口径以官方公告为准。",
      }],
    };

    const selected = selectToolEvidenceVisibleText(
      state,
      "针对“查一下深圳 2026 年社保缴费政策有没有最新变化，给来源和不确定点”，我能从工具证据中确认：- 北京2023年的最低工资标准为2320元。",
    );

    expect(selected).toContain("这轮检索拿到的可核验线索有限");
    expect(selected).toContain("深圳市人力资源和社会保障局");
    expect(selected).not.toContain("工具证据中确认");
    expect(selected).not.toContain("北京2023");
  });
});
