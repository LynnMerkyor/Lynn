import { describe, expect, it, vi } from "vitest";

import {
  executeStockMarketTool,
  fetchForKind,
  withTimeout,
} from "../server/chat/report-research-fetch.js";
import { buildDirectResearchAnswer } from "../server/chat/report-research-answer.js";

describe("report research fetch module", () => {
  it("supports wrapper-injected realtime tools for isolated fetch tests", async () => {
    const realtimeInfo = vi.fn().mockResolvedValue({
      content: [{ text: "杭州 current weather\n- 天气: Cloudy\n- 温度: 19°C" }],
    });

    const context = await fetchForKind("weather", null, {
      userPrompt: "杭州明天天气",
      toolWrappers: {
        realtimeInfo,
      },
    });

    expect(realtimeInfo).toHaveBeenCalledWith("weather", "lynn-local-prefetch", {
      query: "杭州明天天气",
      location: "杭州",
    });
    expect(context).toContain("【天气工具资料】");
    expect(context).toContain("Cloudy");
  });

  it("keeps stock market calls injectable instead of binding tests to the full tool stack", async () => {
    const stockMarket = vi.fn().mockResolvedValue({ content: [{ text: "AAPL 273.05 USD" }] });

    const result = await executeStockMarketTool({ query: "AAPL 最新价" }, {
      timeoutMs: 100,
      toolWrappers: {
        stockMarket,
      },
    });

    expect(result.content[0].text).toBe("AAPL 273.05 USD");
    expect(stockMarket).toHaveBeenCalledWith("lynn-local-prefetch", { query: "AAPL 最新价" });
  });

  it("surfaces timeout failures with the original label", async () => {
    await expect(withTimeout(new Promise(() => {}), 1, "test_tool"))
      .rejects
      .toThrow("test_tool timeout after 1ms");
  });

  it("checks the real Lynn download page before reporting reachability", async () => {
    const webFetch = vi.fn().mockResolvedValue({ text: "<!doctype html><title>Lynn 下载</title>" });
    const prompt = "download.merkyorlynn.com 的下载页能打开吗？只总结状态";

    const context = await fetchForKind("public_data", null, {
      userPrompt: prompt,
      toolWrappers: { webFetch },
    });
    const answer = buildDirectResearchAnswer("public_data", context, prompt);

    expect(webFetch).toHaveBeenCalledWith("https://download.merkyorlynn.com/download.html", 1600);
    expect(context).toContain("状态: reachable");
    expect(answer).toContain("可以打开：https://download.merkyorlynn.com/download.html。本轮已成功读取页面正文。");
    expect(answer).toContain("参考来源：gitee.com、download.merkyorlynn.com");
    expect(answer).not.toContain("应显示");
  });
});
