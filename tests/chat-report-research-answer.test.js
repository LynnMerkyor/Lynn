import { describe, expect, it } from "vitest";

import {
  appendEvidenceBlock,
  buildAnswer,
  buildDirectResearchAnswer,
  parseWeatherSnapshot,
} from "../server/chat/report-research-answer.js";

describe("report research answer module", () => {
  it("keeps the direct-answer adapter equivalent to the legacy public function", () => {
    const context = [
      "【系统已完成行情工具预取】",
      "可核验到的黄金价格（2026-04-21）：",
      "- 上海黄金交易所 Au99.99 789.12 元/克",
      "- 国际现货黄金（XAU/USD） 3386.4 美元/盎司",
    ].join("\n");

    expect(buildAnswer("market", context, { userPrompt: "今天金价如何" }))
      .toBe(buildDirectResearchAnswer("market", context, "今天金价如何"));
  });

  it("parses weather tool snapshots without depending on network fetch code", () => {
    const result = {
      content: [{
        text: [
          "杭州 current weather",
          "- 天气: Patchy rain nearby",
          "- 温度: 18°C",
          "未来几天预报：",
          "- 2026-05-26: 小雨 18~24°C 降雨概率 80% 可能下雨",
        ].join("\n"),
      }],
    };

    const snapshot = parseWeatherSnapshot(result, "杭州明天下雨吗", "杭州");
    expect(snapshot.location).toBe("杭州");
    expect(snapshot.date).toBe("2026-05-26");
    expect(snapshot.desc).toContain("小雨");
    expect(snapshot.tempRange).toBe("18~24 C");
  });

  it("keeps sports no-match fallback inside the requested competition context", () => {
    const context = [
      "体育查询结果",
      "matched: 0",
      "league: FIFA World Cup",
      "dateRange: 2026/06/27",
      "source: https://www.espn.com/soccer/scoreboard",
    ].join("\n");

    const answer = buildDirectResearchAnswer("sports", context, "昨晚世界杯最新的比赛结果");

    expect(answer).toContain("最新赛果或比分");
    expect(answer).not.toContain("总决赛已打场次");
    expect(answer).not.toContain("总比分");
  });

  it("renders evidence blocks as user-facing source notes instead of internal tool labels", () => {
    const answer = appendEvidenceBlock("今日金价按最近可用报价整理如下。", {
      kind: "market",
      userPrompt: "今日金价是多少？",
    });

    expect(answer).toContain("来源与核验");
    expect(answer).toContain("数据源：行情报价");
    expect(answer).not.toContain("数据来源/判断依据");
    expect(answer).not.toContain("工具：");
    expect(answer).not.toContain("stock_market");
  });

  it("labels A-share anomaly results as a representative sample", () => {
    const context = [
      "1. 300308.SZ 最近可用行情",
      "- 名称: 中际旭创",
      "- 价格: 943.00 CNY",
      "- 涨跌/涨跌幅: 38.80 / 4.29%",
      "- 时间戳: 20260821161442",
      "来源: 腾讯行情",
      "https://gu.qq.com/sz300308/gp",
      "2. 600519.SH 最近可用行情",
      "- 名称: 贵州茅台",
      "- 价格: 1272.83 CNY",
      "- 涨跌/涨跌幅: -18.67 / -1.45%",
      "- 时间戳: 20260821161449",
      "来源: 腾讯行情",
      "https://gu.qq.com/sh600519/gp",
    ].join("\n");

    const answer = buildDirectResearchAnswer("market", context, "今天 A 股有什么异动？");
    expect(answer).toContain("2 只 A 股代表性样本");
    expect(answer).toContain("不是全市场异动榜");
    expect(answer).toContain("中际旭创（300308.SZ，+4.29%）");
    expect(answer).toContain("贵州茅台（600519.SH，-1.45%）");
  });
});
