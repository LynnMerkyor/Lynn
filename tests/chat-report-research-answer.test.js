import { describe, expect, it } from "vitest";

import {
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
});
