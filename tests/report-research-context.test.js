import { describe, expect, it } from "vitest";

import {
  buildReportResearchContext,
  buildDirectResearchAnswer,
  extractStockTargetForResearch,
  inferReportResearchKind,
} from "../server/chat/report-research-context.js";

describe("report research context intent", () => {
  it("detects composite market plus weather prompts that need a direct snapshot answer", () => {
    expect(
      inferReportResearchKind("请同时看一下今天 AAPL 最新价、上证指数最新点位、以及明天上海白天的天气，然后给出我明早去浦东机场时的出行与着装建议。"),
    ).toBe("market_weather_brief");
  });

  it("detects named-stock research prompts without an explicit stock code", () => {
    expect(inferReportResearchKind("华丰科技怎么看")).toBe("stock");
    expect(inferReportResearchKind("帮我深入调研一下华丰科技的压力位支撑位")).toBe("stock");
  });

  it("extracts known stock target aliases for hidden prefetch", () => {
    expect(extractStockTargetForResearch("华丰科技怎么看")).toEqual({
      name: "华丰科技",
      code: "688629",
    });
  });

  it("uses recent context to identify follow-up technical-analysis requests", () => {
    const context = [
      "assistant: 标的：华丰科技（688629）",
      "user: 我希望你深入调研一下压力位支撑位",
    ].join("\n");

    expect(inferReportResearchKind(context)).toBe("stock");
  });

  it("detects non-stock evidence-chain research as generic instead of forcing a fixed template", () => {
    expect(inferReportResearchKind("帮我研究一下这个品牌在日本市场的竞品和价格区间")).toBe("generic");
    expect(inferReportResearchKind("中国主要私董会的人数和收费大概多少？")).toBe("public_data");
  });

  it("does not classify local code prompts that mention counts as public data", () => {
    expect(inferReportResearchKind("写一个 Node.js 脚本读取 JSON 并输出 keys 数量")).toBe("");
  });

  it("prefetches OpenAI model-release questions with one official-domain search", async () => {
    const calls = [];
    const context = await buildReportResearchContext("查一下 OpenAI 最近发布了什么新模型，给一句摘要", {
      toolWrappers: {
        webSearch: async (query, limit, options) => {
          calls.push({ query, limit, options });
          return {
            provider: "mock-search",
            results: [{
              title: "Model Release Notes | OpenAI Help Center",
              url: "https://help.openai.com/en/articles/9624314-model-release-notes",
              snippet: "Official model release notes list recent model updates. Verify the newest model on the original page.",
            }],
          };
        },
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].query).toContain("site:openai.com");
    expect(context).toContain("【OpenAI 官方模型发布资料】");
    expect(context).toContain("Model Release Notes");
  });

  it("builds a bounded OpenAI model-release answer from official context", () => {
    const context = [
      "【OpenAI 官方模型发布资料】",
      "查询：site:openai.com OpenAI latest model release GPT model 2026",
      "1. Model Release Notes | OpenAI Help Center",
      "来源: help.openai.com",
      "检索窗口: OpenAI 官方资料",
      "URL: https://help.openai.com/en/articles/9624314-model-release-notes",
      "摘要: Official model release notes list recent model updates. Verify the newest model on the original page.",
    ].join("\n");

    const answer = buildDirectResearchAnswer("news", context, "查一下 OpenAI 最近发布了什么新模型，给一句摘要");
    expect(answer).toContain("没有拿到可核验的 OpenAI 官方新模型发布结论");
    expect(answer).toContain("https://help.openai.com/en/articles/9624314-model-release-notes");
    expect(answer).not.toContain("GPT-5.5");
  });

  it("short-circuits broad today tech news when no dated source is available", async () => {
    const calls = [];
    const prompt = "今天科技新闻有什么重要更新？";
    const context = await buildReportResearchContext(prompt, {
      toolWrappers: {
        realtimeInfo: async () => {
          calls.push("live_news");
          return { content: [{ text: "should not be called" }] };
        },
      },
    });

    const answer = buildDirectResearchAnswer("news", context, prompt);
    expect(calls).toHaveLength(0);
    expect(answer).toContain("没有拿到日期明确匹配今天的可核验科技新闻条目");
    expect(answer).not.toContain("should not be called");
  });

  it("builds a direct DGX Spark versus Mac Studio positioning answer", async () => {
    const prompt = "比较 DGX Spark 和 Mac Studio 做本地 AI 的定位差异";
    const context = await buildReportResearchContext(prompt);
    const answer = buildDirectResearchAnswer("public_data", context, prompt);

    expect(answer).toContain("DGX Spark 和 Mac Studio 不是同一类本地 AI 设备");
    expect(answer).toContain("NVIDIA DGX Spark");
    expect(answer).toContain("Mac Studio");
    expect(answer).toContain("https://www.nvidia.com/en-us/products/workstations/dgx-spark/");
  });

  it("answers Anthropic Claude Code docs checks from official docs context", async () => {
    const prompt = "查 Anthropic docs 是否提到 Claude Code";
    expect(inferReportResearchKind(prompt)).toBe("public_data");

    const context = await buildReportResearchContext(prompt);
    const answer = buildDirectResearchAnswer("public_data", context, prompt);

    expect(answer).toContain("Anthropic 官方文档中有 Claude Code 文档入口");
    expect(answer).toContain("https://docs.anthropic.com/en/docs/claude-code/overview");
    expect(answer).not.toContain("根据本轮已执行工具返回的证据");
  });

  it("answers latest Claude public model generation from official model docs context", async () => {
    const prompt = "Claude 最新公开模型是哪一代？";
    expect(inferReportResearchKind(prompt)).toBe("public_data");

    const context = await buildReportResearchContext(prompt);
    const answer = buildDirectResearchAnswer("public_data", context, prompt);

    expect(answer).toContain("Claude 4 系列");
    expect(answer).toContain("https://docs.anthropic.com/en/docs/about-claude/models/overview");
    expect(answer).not.toContain("Fable");
    expect(answer).not.toContain("Mythos");
  });

  it("answers Apple notarization purpose from Apple Developer context", async () => {
    const prompt = "查 Apple 开发者文档里 notarization 的用途";
    expect(inferReportResearchKind(prompt)).toBe("public_data");

    const context = await buildReportResearchContext(prompt);
    const answer = buildDirectResearchAnswer("public_data", context, prompt);

    expect(answer).toContain("Apple notarization 的用途");
    expect(answer).toContain("Gatekeeper");
    expect(answer).toContain("https://developer.apple.com/documentation/security/notarizing_macos_software_before_distribution");
  });

  it("answers Microsoft Windows on Arm developer page summaries from official context", async () => {
    const prompt = "查 Microsoft Windows on Arm 最新开发者页面一句摘要";
    expect(inferReportResearchKind(prompt)).toBe("public_data");

    const context = await buildReportResearchContext(prompt);
    const answer = buildDirectResearchAnswer("public_data", context, prompt);

    expect(answer).toContain("Microsoft Windows on Arm 开发者页面一句话摘要");
    expect(answer).toContain("https://developer.microsoft.com/windows/arm/");
    expect(answer).not.toContain("根据搜索结果");
  });

  it("builds a direct gold answer when market prefetch already contains prices", () => {
    const context = [
      "【系统已完成行情工具预取】",
      "可核验到的黄金价格（2026-04-21）：",
      "- 上海黄金交易所 Au99.99 789.12 元/克",
      "- 深圳水贝黄金 756.5-768.8 元/克",
      "- 国际现货黄金（XAU/USD） 3386.4 美元/盎司",
      "- 品牌金店首饰金价：1423-1469 元/克（中国黄金 ~ 周生生）",
      "- 银行投资金条：1070.7-1077.66 元/克（农行传世之宝金条 ~ 工商银行如意金条）",
      "- 黄金回收：约 1046 元/克",
      "- 示例品牌：周生生 1469，老凤祥 1465，周六福 1460，中国黄金 1423 元/克",
    ].join("\n");

    const answer = buildDirectResearchAnswer("market", context, "今天金价如何");
    expect(answer).toContain("2026-04-21");
    expect(answer).toContain("上海黄金交易所 Au99.99 789.12 元/克");
    expect(answer).toContain("深圳水贝黄金 756.5-768.8 元/克");
    expect(answer).toContain("国际现货黄金（XAU/USD） 3386.4 美元/盎司");
    expect(answer).toContain("1423-1469 元/克");
    expect(answer).toContain("1070.7-1077.66 元/克");
    expect(answer).toContain("1046 元/克");
  });

  it("builds a direct FX answer when market prefetch contains an exchange rate", () => {
    const context = [
      "【行情工具资料】",
      "财经/行情快照（via open.er-api.com）",
      "查询：美元人民币汇率现在多少？",
      "类型：fx",
      "",
      "1. USD/CNY 汇率",
      "来源：open.er-api.com",
      "https://open.er-api.com/v6/latest/USD",
      "- USD/CNY：1 USD = 6.7890 CNY",
      "- CNY/USD：1 CNY = 0.147297 USD",
      "- 更新时间：Sun, 21 Jun 2026 00:02:31 +0000",
    ].join("\n");

    const answer = buildDirectResearchAnswer("market", context, "美元人民币汇率现在多少？");
    expect(answer).toContain("1 USD = 6.7890 CNY");
    expect(answer).toContain("1 CNY = 0.147297 USD");
    expect(answer).toContain("最近可用汇率快照");
  });

  it("builds a bounded public-data answer for private-board pricing questions", () => {
    const context = [
      "【研究资料】",
      "查询：中国主要私董会的人数和收费大概多少？ 最新 资料 数据 来源",
      "1. 领教工坊私董会",
      "摘要: 每组 10-20 人，年费约 10万-20万元。",
      "2. 正和岛会员",
      "摘要: 小组 8-16 人，入会费 3万-20万元。",
    ].join("\n");

    const answer = buildDirectResearchAnswer("public_data", context, "中国主要私董会的人数和收费大概多少？");
    expect(answer).toContain("10-20 人/组");
    expect(answer).toContain("8万-20万元/年");
    expect(answer).toContain("公开资料里私董会的收费通常不透明");
    expect(answer).toContain("本轮搜索中可参考的数字线索");
  });

  it("builds a direct sports answer from ESPN scoreboard context", () => {
    const context = [
      "【体育比分工具资料】",
      "",
      "体育查询结果 (ESPN scoreboard)",
      "provider: espn_scoreboard",
      "league: FIFA World Cup",
      "source: https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=20260621-20260622",
      "时间口径: 北京时间",
      "匹配比赛: 4 场",
      "",
      "- 2026/06/22 00:00 Spain vs Saudi Arabia (Scheduled)",
      "- 2026/06/22 03:00 Belgium vs Iran (Scheduled)",
    ].join("\n");

    const answer = buildDirectResearchAnswer("sports", context, "今晚世界杯有几场比赛");
    expect(answer).toContain("共 4 场");
    expect(answer).toContain("Spain vs Saudi Arabia");
    expect(answer).toContain("来源：https://site.api.espn.com");
  });

  it("builds a direct sports table when the user asks for table output", () => {
    const context = [
      "【体育比分工具资料】",
      "",
      "体育查询结果 (ESPN scoreboard)",
      "provider: espn_scoreboard",
      "league: FIFA World Cup",
      "source: https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=20260621-20260622",
      "时间口径: 北京时间",
      "匹配比赛: 4 场",
      "",
      "- 2026/06/22 00:00 Spain vs Saudi Arabia (Scheduled)",
      "- 2026/06/22 03:00 Belgium vs Iran (Scheduled)",
    ].join("\n");

    const answer = buildDirectResearchAnswer("sports", context, "查询今晚世界杯赛程，并最后用一个小表格输出");
    expect(answer).toContain("| 时间（北京时间） | 对阵/比分 | 状态 |");
    expect(answer).toContain("| 2026/06/22 00:00 | Spain vs Saudi Arabia | Scheduled |");
    expect(answer).toContain("来源：https://site.api.espn.com");
  });

  it("closes sports answers with an explicit no-evidence boundary when ESPN has no match", () => {
    const context = [
      "【体育比分工具资料】",
      "",
      "体育查询结果 (ESPN scoreboard)",
      "provider: espn_scoreboard",
      "league: NBA",
      "source: https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=20260614-20260622",
      "dateRange: 20260614-20260622",
      "时间口径: 北京时间",
      "matched: 0",
    ].join("\n");

    const answer = buildDirectResearchAnswer("sports", context, "今年 NBA 马刺夺冠了吗，还是尼克斯？");
    expect(answer).toContain("没有匹配到 NBA");
    expect(answer).toContain("不能确认马刺或尼克斯");
    expect(answer).toContain("不会用猜测补答案");
  });

  it("closes sports direct-source failures without using generic search evidence", () => {
    const context = [
      "【体育比分工具资料】",
      "",
      "体育查询结果 (ESPN scoreboard)",
      "provider: espn_scoreboard",
      "query: 昨晚世界杯最新的比赛结果",
      "directSourceStatus: unavailable",
      "error: ESPN scoreboard HTTP 503",
      "matched: 0",
    ].join("\n");

    const answer = buildDirectResearchAnswer("sports", context, "昨晚世界杯最新的比赛结果");
    expect(answer).toContain("专用体育比分源返回失败");
    expect(answer).toContain("ESPN scoreboard HTTP 503");
    expect(answer).toContain("不会用泛搜索摘要");
    expect(answer).not.toContain("百度百科");
  });

  it("builds a sports score prediction when schedule rows are available", () => {
    const context = [
      "【体育比分工具资料】",
      "",
      "体育查询结果 (ESPN scoreboard)",
      "provider: espn_scoreboard",
      "directSourceStatus: fallback_static_schedule",
      "league: FIFA World Cup",
      "source: builtin:fifa-world-cup-2026-schedule:20260621-20260622",
      "dateRange: 20260621-20260622",
      "时间口径: 北京时间",
      "匹配比赛: 4 场",
      "",
      "- 2026/06/22 00:00 Spain vs Saudi Arabia (Scheduled)",
      "- 2026/06/22 03:00 Belgium vs Iran (Scheduled)",
      "- 2026/06/22 06:00 Uruguay vs Cape Verde (Scheduled)",
      "- 2026/06/22 09:00 New Zealand vs Egypt (Scheduled)",
    ].join("\n");

    const answer = buildDirectResearchAnswer("sports", context, "你能预测今晚的比分么？");
    expect(answer).toContain("我的预测比分");
    expect(answer).toContain("Spain 2-0 Saudi Arabia");
    expect(answer).toContain("Belgium 2-1 Iran");
    expect(answer).toContain("Uruguay 2-0 Cape Verde");
    expect(answer).toContain("New Zealand 0-2 Egypt");
    expect(answer).not.toContain("暂未形成可核验");
  });

  it("builds a direct market answer with multiple US tickers instead of only the first quote", () => {
    const context = [
      "【系统已完成行情工具预取】",
      "财经/行情快照（via Stooq）",
      "查询：查最近可用的 AAPL 和 TSLA 行情，给时间戳和来源，并明确这不构成投资建议。",
      "类型：stock",
      "",
      "1. AAPL 最近可用行情",
      "来源：Stooq",
      "https://stooq.com/q/?s=aapl.us",
      "- 价格: 269.5501 USD",
      "- 时间戳: 2026-04-28 17:54:35",
      "- 开盘/最高/最低: 272.335 / 273.22 / 268.66",
      "",
      "2. TSLA 最近可用行情",
      "来源：Stooq",
      "https://stooq.com/q/?s=tsla.us",
      "- 价格: 374.66 USD",
      "- 时间戳: 2026-04-28 17:54:37",
      "- 开盘/最高/最低: 374.675 / 382.29 / 372.5508",
    ].join("\n");

    const answer = buildDirectResearchAnswer(
      "market",
      context,
      "查最近可用的 AAPL 和 TSLA 行情，给时间戳和来源，并明确这不构成投资建议。",
    );

    expect(answer).toContain("**AAPL**");
    expect(answer).toContain("**TSLA**");
    expect(answer).toContain("269.5501 USD");
    expect(answer).toContain("374.66 USD");
  });

  it("keeps explicitly requested US tickers visible when one quote is missing", () => {
    const context = [
      "【系统已完成行情工具预取】",
      "财经/行情快照（via Stooq）",
      "查询：查最近可用的 AAPL 和 TSLA 行情，给时间戳和来源，并明确这不构成投资建议。",
      "类型：stock",
      "",
      "1. TSLA 最近可用行情",
      "来源：Stooq",
      "https://stooq.com/q/?s=tsla.us",
      "- 价格: 374.66 USD",
      "- 时间戳: 2026-04-28 17:54:37",
    ].join("\n");

    const answer = buildDirectResearchAnswer(
      "market",
      context,
      "【TOOL-02】查最近可用的 AAPL 和 TSLA 行情，给时间戳和来源，并明确这不构成投资建议。",
    );

    expect(answer).toContain("**TSLA**");
    expect(answer).toContain("374.66 USD");
    expect(answer).toContain("**AAPL**");
    expect(answer).toContain("未检索到明确");
  });

  it("builds an index answer without leaking a default stock quote", () => {
    const context = [
      "【行情工具资料】",
      "【指数快照】",
      "- 指数: 纳斯达克指数",
      "- 最新点位: 18865.37",
      "- 涨跌幅: +0.42%",
      "- 查询日期: 2026-06-23",
      "- 来源: 新浪财经",
      "- 链接: https://finance.sina.com.cn/",
    ].join("\n");

    const answer = buildDirectResearchAnswer("market", context, "纳斯达克指数最新点位是多少？");

    expect(answer).toContain("纳斯达克指数");
    expect(answer).toContain("18865.37 点");
    expect(answer).not.toContain("AAPL");
  });

  it("builds a direct composite answer for market plus weather commute prompts", () => {
    const context = [
      "【系统已完成综合工具预取】",
      "【美股快照】",
      "- 标的: AAPL",
      "- 最新价: $273.05",
      "- 时间戳: 2026-04-20 22:00:18",
      "- 来源: Stooq",
      "- 链接: https://stooq.com/q/?s=aapl.us",
      "【指数快照】",
      "- 指数: 上证指数",
      "- 最新点位: 4082.13",
      "- 涨跌幅: 0.76%",
      "- 查询日期: 2026-04-21",
      "- 来源: 新浪财经",
      "- 链接: https://finance.sina.com.cn/realstock/company/sh000001/nc.shtml",
      "【天气快照】",
      "- 地点: 上海",
      "- 日期: 2026-04-22",
      "- 天气: Patchy rain nearby",
      "- 温度: 22~27 C",
    ].join("\n");

    const answer = buildDirectResearchAnswer(
      "market_weather_brief",
      context,
      "请同时看一下今天 AAPL 最新价、上证指数最新点位、以及明天上海白天的天气，然后给出我明早去浦东机场时的出行与着装建议。",
    );

    expect(answer).toContain("数据快照");
    expect(answer).toContain("AAPL：$273.05");
    expect(answer).toContain("上证指数：4082.13 点");
    expect(answer).toContain("上海 2026-04-22");
    expect(answer).toContain("行动建议");
    expect(answer).toContain("浦东机场");
    expect(answer).toContain("不构成投资建议");
  });
});
