import { describe, expect, it } from "vitest";

import {
  extractStockTargetForResearch,
  inferKind,
  inferReportResearchKind,
} from "../server/chat/report-research-intent.js";

describe("report research intent module", () => {
  it("keeps stock target extraction isolated from fetch and answer logic", () => {
    expect(extractStockTargetForResearch("华丰科技怎么看")).toEqual({
      name: "华丰科技",
      code: "688629",
    });
  });

  it("returns structured metadata for composite market and weather prompts", () => {
    const intent = inferKind("请同时看一下今天 AAPL 最新价、上证指数最新点位、以及明天上海白天的天气，然后给出我明早去浦东机场时的出行与着装建议。");

    expect(intent.kind).toBe("market_weather_brief");
    expect(intent.ticker).toBe("AAPL");
    expect(intent.indexTarget?.label).toBe("上证指数");
    expect(intent.weatherLocation).toBe("上海");
  });

  it("preserves the public kind classifier used by chat routing", () => {
    expect(inferReportResearchKind("上海明天下雨吗？")).toBe("weather");
    expect(inferReportResearchKind("今天金价如何")).toBe("market");
    expect(inferReportResearchKind("帮我研究一下这个品牌在日本市场的竞品和价格区间")).toBe("generic");
  });
});
