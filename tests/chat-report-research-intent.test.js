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

  it("routes daily public-policy and travel requirements into evidence-backed public data", () => {
    expect(inferReportResearchKind("个人所得税专项附加扣除最新规则有哪些需要注意？请查来源")).toBe("public_data");
    expect(inferReportResearchKind("查一下中国游客去日本旅行签证最新材料要求，列来源和不确定点")).toBe("public_data");
    expect(inferReportResearchKind("访问 example.com 并用一句话概括页面内容")).toBe("public_data");
  });

  it("does not collapse agriculture weather plus commodity price checks into plain weather", () => {
    expect(inferReportResearchKind("种植户要看明天降雨和近期玉米价格，帮我查证后给风险提示")).toBe("public_data");
  });

  it("does not treat personal budget math as public-data research just because it asks how much", () => {
    expect(inferReportResearchKind("我月收入 18000，房租 5200，固定支出 3800，想 8 个月攒 60000，帮我算每月该存多少并给建议")).toBe("");
  });
});
