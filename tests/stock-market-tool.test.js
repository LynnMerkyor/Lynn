import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const webSearchMock = vi.hoisted(() => ({
  runSearchQuery: vi.fn(),
}));

const webFetchMock = vi.hoisted(() => ({
  fetchWebContent: vi.fn(),
}));

vi.mock("../lib/tools/web-search.js", () => ({
  runSearchQuery: webSearchMock.runSearchQuery,
}));

vi.mock("../lib/tools/web-fetch.js", () => ({
  fetchWebContent: webFetchMock.fetchWebContent,
}));

import { createStockMarketTool } from "../lib/tools/stock-market.js";
import { detectKind } from "../lib/tools/stock-market-core.js";

// [v0.76.7] stock-market.js 加了 gold-api.com / open.er-api.com 兜底网络请求,
// test 必须 stub global fetch 拦截这些 URL,否则会真打外网拿实时价格,
// 测试 expectation 跟实时价格不匹配 → 失败。
function makeGlobalFetchStub() {
  return vi.fn(async (url) => {
    const u = String(url);
    if (u.includes("api.gold-api.com/price/XAU")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ price: 3386.4, currency: "USD", priceGram24k: 108.84 }),
        text: async () => "",
      };
    }
    if (u.includes("api.gold-api.com/price/XAG")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ price: 31.2, currency: "USD" }),
        text: async () => "",
      };
    }
    if (u.includes("open.er-api.com")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ rates: { CNY: 7.20, EUR: 0.92, JPY: 156.0 } }),
        text: async () => "",
      };
    }
    if (u.includes("api.coinbase.com/v2/exchange-rates")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { currency: "BTC", rates: { USD: "63984.10", CNY: "460685.52" } } }),
        text: async () => "",
      };
    }
    // 其他 URL fail-fast,确保测试不依赖意外真实网络
    return {
      ok: false,
      status: 503,
      json: async () => ({}),
      text: async () => "",
    };
  });
}

describe("stock market tool", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    webSearchMock.runSearchQuery.mockReset();
    webFetchMock.fetchWebContent.mockReset();
    vi.stubGlobal("fetch", makeGlobalFetchStub());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("classifies explicit index-point prompts as index instead of a Nasdaq stock basket", () => {
    expect(detectKind("纳斯达克指数最新点位是多少？")).toBe("index");
    expect(detectKind("纳指科技股今天表现")).toBe("stock");
  });

  it("classifies bitcoin price prompts as crypto market lookups", async () => {
    expect(detectKind("比特币现在价格大概多少？")).toBe("crypto");

    const tool = createStockMarketTool();
    const res = await tool.execute("test", { query: "比特币现在价格大概多少？" });
    const text = res.content?.[0]?.text || "";

    expect(text).toContain("BTC 最近可用行情");
    expect(text).toContain("63984.1 USD");
    expect(text).toContain("Coinbase exchange-rates");
    expect(res.details?.kind).toBe("crypto");
    expect(webSearchMock.runSearchQuery).not.toHaveBeenCalled();
  });

  it("returns numeric gold prices instead of generic evidence-needed fallback", async () => {
    webSearchMock.runSearchQuery.mockResolvedValue({
      provider: "duckduckgo-html",
      plan: { scene: "finance" },
      results: [
        {
          title: "今日金价 (实时更新),黄金价格, 最新国际黄金价格走势图_汇率表",
          url: "https://www.huilvbiao.com/gold",
          snippet: "黄金价格汇总",
        },
      ],
    });
    webFetchMock.fetchWebContent.mockResolvedValue({
      text: [
        "各品牌黄金首饰金店报价",
        "中国黄金 (/gold/p_zhongguo)",
        "1423",
        "700",
        "-",
        "元/克",
        "2026-04-21",
        "六福珠宝 (/gold/p_liufu)",
        "1465",
        "811",
        "1285",
        "元/克",
        "2026-04-21",
        "银行投资金条价格",
        "农行传世之宝金条 (/gold/tz_nyjt)",
        "1070.7",
        "工商银行如意金条 (/gold/tz_ruyi)",
        "1077.66",
        "今日黄金回收价格",
        "黄金回收 (/gold/hs_huangjin)",
        "1046.0",
        "元/克",
        "2026-04-21",
      ].join("\n"),
    });

    const tool = createStockMarketTool();
    const res = await tool.execute("test", { query: "今天金价如何" });
    const text = res.content?.[0]?.text || "";

    expect(text).toContain("黄金价格快照");
    expect(text).toContain("国际现货黄金（XAU/USD）");
    expect(text).toContain("783.9 元/克");
    expect(webSearchMock.runSearchQuery).not.toHaveBeenCalled();
    expect(webFetchMock.fetchWebContent).not.toHaveBeenCalled();
    expect(res.details?.kind).toBe("gold");
  });

  it("extracts SGE, ShuiBei, and spot gold lines for gold queries", async () => {
    webSearchMock.runSearchQuery.mockResolvedValue({
      provider: "duckduckgo-html",
      plan: { scene: "finance" },
      results: [
        {
          title: "今日黄金行情汇总",
          url: "https://example.com/gold",
          snippet: "上海黄金交易所与水贝黄金报价",
        },
      ],
    });
    webFetchMock.fetchWebContent.mockResolvedValue({
      text: [
        "2026-04-21 黄金行情",
        "上海黄金交易所 Au99.99 789.12 元/克",
        "Au9999 789.58 元/克",
        "深圳水贝黄金 756.5-768.8 元/克",
        "XAU/USD 3386.4 美元/盎司",
      ].join("\n"),
    });

    const tool = createStockMarketTool();
    const res = await tool.execute("test", { query: "今天上金所和水贝黄金价格如何" });
    const text = res.content?.[0]?.text || "";

    expect(text).toContain("上海黄金交易所 Au99.99 789.12 元/克");
    expect(text).toContain("上海黄金交易所 Au9999 789.58 元/克");
    expect(text).toContain("深圳水贝黄金 756.5-768.8 元/克");
    // [v0.76.7] production 输出从 "XXX 美元/盎司" 改为 "YYY 元/克（约 XXX 美元/盎司, USD/CNY Z.Z）"
    // 主报价单位变成元/克更符合中国用户习惯; 美元/盎司变成括号内换算说明
    expect(text).toMatch(/国际现货黄金（XAU\/USD）\s*[\d.]+\s*元\/克/);
    expect(text).toContain("3386.4 美元/盎司");
  });

  it("falls back to targeted gold searches when the first broad query has no usable gold evidence", async () => {
    webSearchMock.runSearchQuery
      .mockResolvedValueOnce({
        provider: "duckduckgo-html",
        plan: { scene: "finance" },
        results: [
          {
            title: "人民币汇率页面",
            url: "https://example.com/fx",
            snippet: "美元/人民币 7.20，欧元/人民币 7.88",
          },
        ],
      })
      .mockResolvedValueOnce({
        provider: "duckduckgo-html",
        plan: { scene: "finance" },
        results: [
          {
            title: "上海黄金交易所 Au99.99 今日行情",
            url: "https://example.com/sge",
            snippet: "Au99.99 今日价格",
          },
        ],
      });
    webFetchMock.fetchWebContent
      .mockResolvedValueOnce({
        text: "美元/人民币 7.20\n欧元/人民币 7.88",
      })
      .mockResolvedValueOnce({
        text: "2026-04-21\n上海黄金交易所 Au99.99 788.66 元/克\n深圳水贝黄金 758-766 元/克",
      });

    const tool = createStockMarketTool();
    const res = await tool.execute("test", { query: "今天上金所和水贝金价如何" });
    const text = res.content?.[0]?.text || "";

    expect(webSearchMock.runSearchQuery).toHaveBeenCalledTimes(2);
    expect(text).toContain("上海黄金交易所 Au99.99 788.66 元/克");
    expect(text).toContain("深圳水贝黄金 758-766 元/克");
  });

  it("returns direct stock quotes when Stooq quote fetch succeeds", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      if (String(url).includes("stooq.com")) {
        return {
          ok: true,
          status: 200,
          text: async () => [
            "Symbol,Date,Time,Open,High,Low,Close,Volume",
            "AAPL.US,2026-04-17,22:00:09,209.12,212.35,208.41,211.48,52633774",
          ].join("\n"),
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    }));

    const tool = createStockMarketTool();
    const res = await tool.execute("test", { query: "AAPL 最新股价" });
    const text = res.content?.[0]?.text || "";

    expect(text).toContain("AAPL 最近可用行情");
    expect(text).toContain("价格: 211.48");
    expect(text).toContain("Stooq");
    expect(res.details?.directQuotes?.[0]?.symbol).toBe("AAPL");
  });

  it("resolves Chinese NVIDIA quote prompts through structured US quotes before web search", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const href = String(url);
      if (href.includes("qt.gtimg.cn/q=usNVDA")) {
        const body = 'v_usNVDA="200~NVIDIA~NVDA.OQ~205.19~204.87~204.86~112345314~0~0~205.42~800~0~0~0~0~0~0~0~0~205.44~2100~0~0~0~0~0~0~0~0~~2026-06-12 16:00:01~0.32~0.16~207.07~203.44~USD~112345314~23043334162";';
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => Buffer.from(body, "utf8"),
          text: async () => body,
        };
      }
      throw new Error(`unexpected fetch: ${href}`);
    }));

    const tool = createStockMarketTool();
    const res = await tool.execute("test", { query: "英伟达收盘价" });
    const text = res.content?.[0]?.text || "";

    expect(webSearchMock.runSearchQuery).not.toHaveBeenCalled();
    expect(webFetchMock.fetchWebContent).not.toHaveBeenCalled();
    expect(text).toContain("NVDA 最近可用行情");
    expect(text).toContain("NVIDIA");
    expect(text).toContain("价格: 205.19 USD");
    expect(text).toContain("腾讯财经");
    expect(res.details?.provider).toBe("腾讯财经");
    expect(res.details?.directQuotes?.[0]?.symbol).toBe("NVDA");
  });

  it("returns direct Nasdaq index quotes without falling back to stock baskets", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const href = String(url);
      if (href.includes("qt.gtimg.cn/q=usIXIC")) {
        const body = 'v_usIXIC="200~Nasdaq Composite~.IXIC~26166.60~26517.93~26561.12~123456789~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~~2026-06-22 17:15:59~-351.33~-1.32~26561.12~26125.48~USD~123456789~0";';
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => Buffer.from(body, "utf8"),
          text: async () => body,
        };
      }
      throw new Error(`unexpected fetch: ${href}`);
    }));

    const tool = createStockMarketTool();
    const res = await tool.execute("test", { query: "纳斯达克指数最新点位是多少？", kind: "index" });
    const text = res.content?.[0]?.text || "";

    expect(webSearchMock.runSearchQuery).not.toHaveBeenCalled();
    expect(webFetchMock.fetchWebContent).not.toHaveBeenCalled();
    expect(res.details?.kind).toBe("index");
    expect(res.details?.provider).toBe("腾讯财经");
    expect(res.details?.directQuotes?.[0]?.symbol).toBe("IXIC");
    expect(res.details?.directQuotes?.[0]?.name).toBe("纳斯达克指数");
    expect(text).toContain("IXIC 最近可用行情");
    expect(text).toContain("纳斯达克指数");
    expect(text).toMatch(/26166\.6(?:0)? USD/);
    expect(text).not.toContain("AAPL");
  });

  it("returns direct FX rates instead of fetching garbled forex pages", async () => {
    const tool = createStockMarketTool();
    const res = await tool.execute("test", { query: "美元人民币汇率" });
    const text = res.content?.[0]?.text || "";

    expect(webSearchMock.runSearchQuery).not.toHaveBeenCalled();
    expect(webFetchMock.fetchWebContent).not.toHaveBeenCalled();
    expect(res.details?.kind).toBe("fx");
    expect(res.details?.provider).toBe("open.er-api.com");
    expect(text).toContain("USD/CNY");
    expect(text).toContain("1 USD = 7.2 CNY");
    expect(text).not.toContain("���");
  });

  it("keeps search-result URLs out of gold snapshots while preserving snippets", async () => {
    webSearchMock.runSearchQuery.mockResolvedValue({
      provider: "lynn-brain/glm",
      plan: { scene: "finance" },
      results: [
        {
          title: "金价大跳水！跌破900元克价大关",
          url: "https://www.baidu.com/s?wd=%E9%87%91%E4%BB%B7",
          snippet: "上海黄金交易所 Au99.99 788.66 元/克，深圳水贝黄金 758-766 元/克",
        },
      ],
    });

    const tool = createStockMarketTool();
    const res = await tool.execute("test", { query: "今天上金所和水贝金价如何" });
    const text = res.content?.[0]?.text || "";

    expect(webFetchMock.fetchWebContent).not.toHaveBeenCalledWith(
      expect.stringContaining("baidu.com"),
      expect.anything(),
    );
    expect(text).toContain("上海黄金交易所 Au99.99 788.66 元/克");
    expect(text).toContain("深圳水贝黄金 758-766 元/克");
    expect(text).not.toContain("https://www.baidu.com/s");
  });
});
