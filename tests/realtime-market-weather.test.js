import { afterEach, describe, expect, it, vi } from "vitest";
import iconv from "iconv-lite";

const searchMock = vi.hoisted(() => ({
  runSearchQuery: vi.fn(),
}));

const fetchContentMock = vi.hoisted(() => ({
  fetchWebContent: vi.fn(),
}));

vi.mock("../lib/tools/web-search.js", () => searchMock);
vi.mock("../lib/tools/web-fetch.js", () => fetchContentMock);

import { createStockMarketTool } from "../lib/tools/stock-market.js";
import { createLiveNewsTool, createSportsScoreTool, createWeatherTool, extractWeatherLocation } from "../lib/tools/realtime-info.js";
import { buildDirectResearchAnswer, inferReportResearchKind } from "../server/chat/report-research-context.js";

function jsonResponse(data) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function gbkTextResponse(text) {
  return new Response(iconv.encode(String(text || ""), "gbk"), {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}

function sinaHkQuote({ name, previous, open, high, low, close, change, pct }) {
  const hk = Array.from({ length: 76 }, () => "");
  hk[1] = name;
  hk[2] = previous;
  hk[3] = open;
  hk[4] = high;
  hk[5] = low;
  hk[6] = close;
  hk[7] = change;
  hk[8] = pct;
  hk[17] = "2026/04/24";
  hk[18] = "16:08:34";
  return hk.join(",");
}

function tencentAQuote({ code, name, price, previous = "10.00", change = "0.10", pct = "1.00" }) {
  const fields = Array.from({ length: 50 }, () => "");
  fields[1] = name;
  fields[2] = code;
  fields[3] = price;
  fields[4] = previous;
  fields[5] = previous;
  fields[30] = "20260424161451";
  fields[31] = change;
  fields[32] = pct;
  fields[33] = price;
  fields[34] = price;
  fields[36] = "123456";
  fields[37] = "12345";
  fields[38] = "2.34";
  fields[39] = "42.0";
  return fields.join("~");
}

describe("realtime market/weather tools", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    searchMock.runSearchQuery.mockReset();
    fetchContentMock.fetchWebContent.mockReset();
  });

  it("routes common realtime prompts into deterministic prefetch kinds", () => {
    expect(inferReportResearchKind("今天金价如何")).toBe("market");
    expect(inferReportResearchKind("今天布伦特石油价格，请给美元/桶")).toBe("market");
    expect(inferReportResearchKind("比特币现在价格大概多少？")).toBe("market");
    expect(inferReportResearchKind("雪人集团002639现在股价多少？只给价格、涨跌幅和来源。")).toBe("market");
    expect(inferReportResearchKind("雪人集团002639支撑位和压力位怎么看？")).toBe("stock");
    expect(inferReportResearchKind("恒生科技成分股今天表现")).toBe("market");
    expect(inferReportResearchKind("纳指科技股今天表现")).toBe("market");
    expect(inferReportResearchKind("创业板科技股今天表现")).toBe("market");
    expect(inferReportResearchKind("DeepSeek概念股今天表现")).toBe("market");
    expect(inferReportResearchKind("上海明天下雨吗？")).toBe("weather");
    expect(inferReportResearchKind("查一下 OpenAI 最近发布了什么新模型，给一句摘要")).toBe("news");
    expect(inferReportResearchKind("查一下深圳今天有没有暴雨预警")).toBe("weather");
  });

  it("uses a single official-domain search for OpenAI model-release live news", async () => {
    searchMock.runSearchQuery.mockResolvedValue({
      provider: "mock-search",
      results: [{
        title: "Model Release Notes | OpenAI Help Center",
        url: "https://help.openai.com/en/articles/9624314-model-release-notes",
        snippet: "Official model release notes list recent model updates.",
      }],
    });

    const result = await createLiveNewsTool().execute("test", {
      query: "查一下 OpenAI 最近发布了什么新模型，给一句摘要",
      maxResults: 5,
    });
    const text = result.content.map((item) => item.text).join("\n");

    expect(searchMock.runSearchQuery).toHaveBeenCalledTimes(1);
    expect(searchMock.runSearchQuery.mock.calls[0][0]).toContain("site:openai.com");
    expect(fetchContentMock.fetchWebContent).not.toHaveBeenCalled();
    expect(text).toContain("OpenAI 官方模型发布资料");
    expect(text).toContain("Model Release Notes");
    expect(text).not.toContain("GPT-5.5");
    expect(result.details.fastPath).toBe("openai_model_release");
  });

  it("uses Shenzhen official alert data for rainstorm warning questions", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      expect(String(url)).toContain("weather.121.com.cn/data_cache/szWeather/alarm/szAlarm.js");
      return new Response([
        "/*@cdate:2026-06-21 17:14:00*/",
        "try{ var SZ121_AlarmInfo = {",
        "\"warnpre\":{\"flagindex\":0},",
        "\"subAlarm\":[],",
        "\"sshzqAlarm\":[],",
        "\"alarmInfo\":\"【深圳市解除雷电预警信号】雷暴云团已减弱，深圳市气象台2026年06月19日14时30分解除全市雷电预警信号。\",",
        "\"alarmSSInfo\":\"【深汕特别合作区解除雷雨大风黄色预警和暴雨橙色预警信号】 雷暴云团已移出。\",",
        "\"ingnalNum\":\"0\"",
        "};}catch(e){}",
      ].join(""));
    }));

    expect(extractWeatherLocation("查一下深圳今天有没有暴雨预警")).toBe("深圳");
    const result = await createWeatherTool().execute("test", {
      query: "查一下深圳今天有没有暴雨预警",
    });
    const text = result.content.map((item) => item.text).join("\n");
    const answer = buildDirectResearchAnswer("weather", text, "查一下深圳今天有没有暴雨预警");

    expect(text).toContain("当前深圳生效预警: 0");
    expect(text).toContain("暴雨预警: 未检出深圳当前生效暴雨预警");
    expect(result.details.provider).toBe("weather.121.com.cn");
    expect(answer).toContain("未检出当前生效的暴雨预警");
    expect(answer).toContain("官方数据更新时间：2026-06-21 17:14:00");
    expect(answer).toContain("weather.121.com.cn/data_cache/szWeather/alarm/szAlarm.js");
    expect(answer).not.toContain("有暴雨橙色预警");
  });

  it("uses Gold-API direct quotes before search snippets for gold queries", async () => {
    const goldPageText = [
      "各品牌黄金首饰金店报价",
      "中国黄金 1401 700 - 元/克 2026-04-24",
      "老凤祥 1445 850 1288 元/克 2026-04-24",
      "六福珠宝 1442 782 1265 元/克 2026-04-24",
      "银行投资金条价格",
      "农行传世之宝金条 1046.29",
      "工商银行如意金条 1057.0",
      "今日黄金回收价格",
      "黄金回收 1027.0 元/克 2026-04-24",
    ].join("\n");

    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const href = String(url);
      if (href.includes("/price/XAU")) {
        return jsonResponse({
          symbol: "XAU",
          price: 4724.6,
          updatedAt: "2026-04-24T08:20:00Z",
        });
      }
      if (href.includes("/price/XAG")) {
        return jsonResponse({
          symbol: "XAG",
          price: 75.1,
          updatedAt: "2026-04-24T08:20:00Z",
        });
      }
      if (href.includes("open.er-api.com")) {
        return jsonResponse({
          rates: { CNY: 6.84 },
          time_last_update_utc: "Fri, 24 Apr 2026 00:00:00 +0000",
        });
      }
      throw new Error(`unexpected fetch ${href}`);
    }));

    searchMock.runSearchQuery.mockResolvedValue({
      provider: "mock-search",
      plan: { scene: "finance" },
      results: [{ title: "今日黄金价格", url: "https://www.huilvbiao.com/gold", snippet: "金价" }],
    });
    fetchContentMock.fetchWebContent.mockResolvedValue({ text: goldPageText });

    const result = await createStockMarketTool().execute("test", { query: "今天金价如何" });
    const text = result.content[0].text;

    expect(result.details.kind).toBe("gold");
    expect(result.details.evidence.some((item) => item.type === "source" && item.source)).toBe(true);
    expect(text).toContain("黄金价格快照");
    expect(text).toContain("国际现货黄金（XAU/USD）");
    expect(text).toContain("元/克");
    expect(searchMock.runSearchQuery).not.toHaveBeenCalled();
    expect(fetchContentMock.fetchWebContent).not.toHaveBeenCalled();
  });

  it("uses Sina direct quotes for Brent oil queries", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const href = String(url);
      if (href.includes("hq.sinajs.cn/list=hf_OIL")) {
        return gbkTextResponse('var hq_str_hf_OIL="100.88,,,,101.20,99.50,15:30,99.35,,,,,2026-04-24,布伦特原油";');
      }
      throw new Error(`unexpected fetch ${href}`);
    }));

    searchMock.runSearchQuery.mockResolvedValue({
      provider: "mock-search",
      plan: { scene: "finance" },
      results: [],
    });

    const result = await createStockMarketTool().execute("test", { query: "今天布伦特石油价格是多少？请给美元/桶和涨跌。" });
    const text = result.content[0].text;

    expect(result.details.kind).toBe("oil");
    expect(result.details.evidence.some((item) => item.source === "新浪财经")).toBe(true);
    expect(text).toContain("布伦特原油：100.88 美元/桶");
  });

  it("uses Tencent direct quote for simple A-share price queries", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const href = String(url);
      if (href.includes("qt.gtimg.cn/q=sz002639")) {
        return gbkTextResponse('v_sz002639="51~雪人集团~002639~18.04~18.37~18.11~413968~176083~237885~18.04~1248~18.03~793~18.02~225~18.01~255~18.00~1337~18.05~504~18.06~266~18.07~310~18.08~1740~18.09~986~~20260424161451~-0.33~-1.80~18.46~17.86~18.04/413968/749021964~413968~74902~6.36~335.20";');
      }
      throw new Error(`unexpected fetch ${href}`);
    }));

    searchMock.runSearchQuery.mockResolvedValue({
      provider: "mock-search",
      plan: { scene: "finance" },
      results: [],
    });

    const result = await createStockMarketTool().execute("test", {
      query: "雪人集团002639现在股价多少？只给价格、涨跌幅和来源。",
    });
    const text = result.content[0].text;

    expect(result.details.kind).toBe("stock");
    expect(result.details.provider).toBe("腾讯行情");
    expect(result.details.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "quote",
        symbol: "002639.SZ",
        value: "18.04",
        source: "腾讯行情",
      }),
    ]));
    expect(text).toContain("002639.SZ 最近可用行情");
    expect(text).toContain("雪人集团");
    expect(text).toContain("18.04 CNY");
    expect(text).toContain("-0.33 / -1.80%");
    expect(text).toContain("成交额: 7.49 亿元");
    expect(text).toContain("换手率: 6.36%");
    expect(searchMock.runSearchQuery).not.toHaveBeenCalled();
  });

  it("uses direct HK and US price queries", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const href = String(url);
      if (href.includes("hq.sinajs.cn/list=rt_hk00700")) {
        return gbkTextResponse(`var hq_str_rt_hk00700="${sinaHkQuote({
          name: "腾讯控股",
          previous: "495.200",
          open: "492.000",
          high: "495.000",
          low: "487.000",
          close: "493.400",
          change: "-1.800",
          pct: "-0.36",
        })}";`);
      }
      if (href.includes("stooq.com")) {
        return new Response("Symbol,Date,Time,Open,High,Low,Close,Volume\nAAPL.US,2026-04-24,22:00:07,270.00,273.06,269.65,271.06,38135000\n", {
          status: 200,
          headers: { "content-type": "text/csv" },
        });
      }
      throw new Error(`unexpected fetch ${href}`);
    }));

    searchMock.runSearchQuery.mockResolvedValue({
      provider: "mock-search",
      plan: { scene: "finance" },
      results: [],
    });

    const prompt = "查询 AAPL 和腾讯控股 0700.HK 最新股价，只要价格和涨跌幅。";
    const result = await createStockMarketTool().execute("test", { query: prompt });
    const text = result.content[0].text;

    expect(inferReportResearchKind(prompt)).toBe("market");
    expect(result.details.kind).toBe("stock");
    expect(text).toContain("AAPL");
    expect(text).toContain("271.06 USD");
    expect(text).toContain("腾讯控股");
    expect(text).toContain("493.400 HKD");
    expect(text).toContain("-1.800 / -0.36%");
    expect(searchMock.runSearchQuery).not.toHaveBeenCalled();
  });

  it("expands HK tech sector queries into direct basket quotes", async () => {
    const quoteMap = new Map([
      ["00700", { name: "腾讯控股", close: "480.400", change: "-13.000", pct: "-2.64" }],
      ["09988", { name: "阿里巴巴-W", close: "118.200", change: "-4.000", pct: "-3.27" }],
      ["03690", { name: "美团-W", close: "101.700", change: "-2.800", pct: "-2.68" }],
      ["01810", { name: "小米集团-W", close: "45.300", change: "-0.900", pct: "-1.95" }],
      ["01024", { name: "快手-W", close: "74.500", change: "-1.100", pct: "-1.46" }],
      ["09618", { name: "京东集团-SW", close: "130.800", change: "-2.400", pct: "-1.80" }],
    ]);

    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const href = String(url);
      const match = href.match(/rt_hk(\d{5})/);
      if (match && quoteMap.has(match[1])) {
        const item = quoteMap.get(match[1]);
        return gbkTextResponse(`var hq_str_rt_hk${match[1]}="${sinaHkQuote({
          name: item.name,
          previous: "500.000",
          open: item.close,
          high: item.close,
          low: item.close,
          close: item.close,
          change: item.change,
          pct: item.pct,
        })}";`);
      }
      throw new Error(`unexpected fetch ${href}`);
    }));

    searchMock.runSearchQuery.mockResolvedValue({
      provider: "mock-search",
      plan: { scene: "finance" },
      results: [],
    });

    const prompt = "恒生科技成分股今天表现";
    const result = await createStockMarketTool().execute("test", { query: prompt });
    const text = result.content[0].text;

    expect(inferReportResearchKind(prompt)).toBe("market");
    expect(result.details.kind).toBe("stock");
    expect(result.details.provider).toBe("新浪财经");
    expect(result.details.directQuotes).toHaveLength(6);
    expect(text).toContain("00700.HK 最近可用行情");
    expect(text).toContain("腾讯控股");
    expect(text).toContain("09988.HK 最近可用行情");
    expect(text).toContain("阿里巴巴-W");
    expect(text).toContain("03690.HK 最近可用行情");
    expect(text).toContain("美团-W");
    expect(searchMock.runSearchQuery).not.toHaveBeenCalled();
  });

  it("expands A-share and US sector queries into representative direct baskets", async () => {
    const aShareMap = new Map([
      ["688629", { name: "华丰科技", price: "125.57" }],
      ["300308", { name: "中际旭创", price: "388.00" }],
      ["300502", { name: "新易盛", price: "299.00" }],
      ["002230", { name: "科大讯飞", price: "60.00" }],
      ["000977", { name: "浪潮信息", price: "55.00" }],
      ["688981", { name: "中芯国际", price: "120.00" }],
    ]);
    const usMap = new Map([
      ["aapl.us", ["AAPL.US", "271.06"]],
      ["msft.us", ["MSFT.US", "512.20"]],
      ["nvda.us", ["NVDA.US", "190.10"]],
      ["googl.us", ["GOOGL.US", "310.00"]],
      ["amzn.us", ["AMZN.US", "235.00"]],
      ["meta.us", ["META.US", "755.00"]],
      ["tsla.us", ["TSLA.US", "470.00"]],
    ]);

    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const href = String(url);
      const aMatch = href.match(/qt\.gtimg\.cn\/q=(?:sh|sz)(\d{6})/);
      if (aMatch && aShareMap.has(aMatch[1])) {
        const item = aShareMap.get(aMatch[1]);
        return gbkTextResponse(`v_${aMatch[1]}="${tencentAQuote({
          code: aMatch[1],
          name: item.name,
          price: item.price,
        })}";`);
      }
      const sMatch = href.match(/s=([^&]+)/);
      const stooqKey = decodeURIComponent(sMatch?.[1] || "").toLowerCase();
      if (usMap.has(stooqKey)) {
        const [symbol, close] = usMap.get(stooqKey);
        return new Response(`Symbol,Date,Time,Open,High,Low,Close,Volume\n${symbol},2026-04-24,22:00:07,100.00,110.00,99.00,${close},1000000\n`, {
          status: 200,
          headers: { "content-type": "text/csv" },
        });
      }
      throw new Error(`unexpected fetch ${href}`);
    }));

    searchMock.runSearchQuery.mockResolvedValue({
      provider: "mock-search",
      plan: { scene: "finance" },
      results: [],
    });

    const aResult = await createStockMarketTool().execute("test", { query: "创业板科技股今天表现" });
    const aText = aResult.content[0].text;
    expect(aResult.details.directQuotes.length).toBeGreaterThanOrEqual(5);
    expect(aText).toContain("688629.SH 最近可用行情");
    expect(aText).toContain("华丰科技");
    expect(aText).toContain("300308.SZ 最近可用行情");
    expect(searchMock.runSearchQuery).not.toHaveBeenCalled();

    const usResult = await createStockMarketTool().execute("test", { query: "美股七姐妹今天表现" });
    const usText = usResult.content[0].text;
    expect(usResult.details.directQuotes.length).toBe(7);
    expect(usText).toContain("AAPL");
    expect(usText).toContain("NVDA");
    expect(usText).toContain("MSFT");
    expect(searchMock.runSearchQuery).not.toHaveBeenCalled();
  });

  it("resolves open-ended concept-stock queries through search before direct quotes", async () => {
    const aShareMap = new Map([
      ["002261", { name: "拓维信息", price: "28.60" }],
      ["300766", { name: "每日互动", price: "38.20" }],
      ["600633", { name: "浙数文化", price: "18.88" }],
    ]);
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const href = String(url);
      const aMatch = href.match(/qt\.gtimg\.cn\/q=(?:sh|sz)(\d{6})/);
      if (aMatch && aShareMap.has(aMatch[1])) {
        const item = aShareMap.get(aMatch[1]);
        return gbkTextResponse(`v_${aMatch[1]}="${tencentAQuote({
          code: aMatch[1],
          name: item.name,
          price: item.price,
        })}";`);
      }
      throw new Error(`unexpected fetch ${href}`);
    }));

    searchMock.runSearchQuery.mockResolvedValue({
      provider: "mock-search",
      plan: { scene: "finance" },
      results: [{
        title: "DeepSeek概念股龙头名单",
        url: "https://example.com/deepseek-stocks",
        snippet: "DeepSeek概念股包括拓维信息(002261)、每日互动(300766)、浙数文化(600633)等。",
      }],
    });

    const result = await createStockMarketTool().execute("test", { query: "DeepSeek概念股今天表现" });
    const text = result.content[0].text;

    expect(result.details.kind).toBe("stock");
    expect(result.details.directQuotes).toHaveLength(3);
    expect(text).toContain("002261.SZ 最近可用行情");
    expect(text).toContain("拓维信息");
    expect(text).toContain("300766.SZ 最近可用行情");
    expect(text).toContain("每日互动");
    expect(text).toContain("600633.SH 最近可用行情");
    expect(text).toContain("浙数文化");
    expect(searchMock.runSearchQuery).toHaveBeenCalled();
  });

  it("does not treat finance source brands as concept constituents", async () => {
    const aShareMap = new Map([
      ["002261", { name: "拓维信息", price: "28.60" }],
      ["300766", { name: "每日互动", price: "38.20" }],
    ]);
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const href = String(url);
      const aMatch = href.match(/qt\.gtimg\.cn\/q=(?:sh|sz)(\d{6})/);
      if (aMatch && aShareMap.has(aMatch[1])) {
        const item = aShareMap.get(aMatch[1]);
        return gbkTextResponse(`v_${aMatch[1]}="${tencentAQuote({
          code: aMatch[1],
          name: item.name,
          price: item.price,
        })}";`);
      }
      throw new Error(`unexpected fetch ${href}`);
    }));

    searchMock.runSearchQuery.mockResolvedValue({
      provider: "mock-search",
      plan: { scene: "finance" },
      results: [{
        title: "DeepSeek概念股 东方财富 股票代码 中信证券研报",
        url: "https://data.eastmoney.com/concept/deepseek",
        snippet: "东方财富整理 DeepSeek 概念股名单，中信证券研报点评；相关标的包括拓维信息(002261)、每日互动(300766)。",
      }],
    });
    fetchContentMock.fetchWebContent.mockResolvedValue({ text: "页面导航：东方财富 数据中心 中信证券研报。DeepSeek概念股包括拓维信息(002261)、每日互动(300766)。" });

    const result = await createStockMarketTool().execute("test", { query: "DeepSeek概念股今天表现" });
    const symbols = result.details.directQuotes.map((item) => item.symbol);

    expect(symbols).toEqual(expect.arrayContaining(["002261.SZ", "300766.SZ"]));
    expect(symbols).not.toContain("300059.SZ");
    expect(symbols).not.toContain("600030.SH");
  });

  it("does not repeat dynamic concept resolution after an empty first attempt", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      throw new Error(`unexpected direct quote fetch ${String(url)}`);
    }));

    searchMock.runSearchQuery.mockResolvedValue({
      provider: "mock-search",
      plan: { scene: "finance" },
      results: [{
        title: "DeepSeek 行业新闻",
        url: "https://example.com/deepseek-news",
        snippet: "OPEN DEEP BANK GROW 都只是普通英文词，这里没有股票代码。",
      }],
    });
    fetchContentMock.fetchWebContent.mockResolvedValue({
      text: "这是一篇行业新闻，没有 A 股代码、港股代码或美股 ticker。",
    });

    await createStockMarketTool().execute("test", { query: "DeepSeek概念股今天表现" });

    // Two concept-search queries plus one final general fallback search.
    // The old path retried concept resolution a second time and inflated this to five calls.
    expect(searchMock.runSearchQuery).toHaveBeenCalledTimes(3);
  });

  it("uses ESPN scoreboard directly for World Cup tonight queries", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-06-21T15:30:00+08:00"));
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
        events: [
          {
            date: "2026-06-21T04:00Z",
            status: { type: { completed: true, shortDetail: "FT" } },
            competitions: [{ competitors: [
              { homeAway: "home", score: "4", team: { displayName: "Japan" } },
              { homeAway: "away", score: "0", team: { displayName: "Tunisia" } },
            ] }],
          },
          {
            date: "2026-06-21T16:00Z",
            status: { type: { completed: false, shortDetail: "Scheduled" } },
            competitions: [{ competitors: [
              { homeAway: "home", score: "0", team: { displayName: "Spain" } },
              { homeAway: "away", score: "0", team: { displayName: "Saudi Arabia" } },
            ] }],
          },
          {
            date: "2026-06-21T19:00Z",
            status: { type: { completed: false, shortDetail: "Scheduled" } },
            competitions: [{ competitors: [
              { homeAway: "home", score: "0", team: { displayName: "Belgium" } },
              { homeAway: "away", score: "0", team: { displayName: "Iran" } },
            ] }],
          },
          {
            date: "2026-06-21T22:00Z",
            status: { type: { completed: false, shortDetail: "Scheduled" } },
            competitions: [{ competitors: [
              { homeAway: "home", score: "0", team: { displayName: "Uruguay" } },
              { homeAway: "away", score: "0", team: { displayName: "Cape Verde" } },
            ] }],
          },
          {
            date: "2026-06-22T01:00Z",
            status: { type: { completed: false, shortDetail: "Scheduled" } },
            competitions: [{ competitors: [
              { homeAway: "home", score: "0", team: { displayName: "New Zealand" } },
              { homeAway: "away", score: "0", team: { displayName: "Egypt" } },
            ] }],
          },
          {
            date: "2026-06-22T17:00Z",
            status: { type: { completed: false, shortDetail: "Scheduled" } },
            competitions: [{ competitors: [
              { homeAway: "home", score: "0", team: { displayName: "Argentina" } },
              { homeAway: "away", score: "0", team: { displayName: "Austria" } },
            ] }],
          },
        ],
      })));

      const pending = createSportsScoreTool().execute("test", {
        query: "今晚世界杯有几场比赛",
        maxResults: 5,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await pending;
      const text = result.content[0].text;

      expect(searchMock.runSearchQuery).not.toHaveBeenCalled();
      expect(result.details.provider).toBe("espn_scoreboard");
      expect(text).toContain("匹配比赛: 4 场");
      expect(text).toContain("北京时间");
      expect(text).toContain("Spain vs Saudi Arabia");
      expect(text).toContain("Belgium vs Iran");
      expect(text).toContain("Uruguay vs Cape Verde");
      expect(text).toContain("New Zealand vs Egypt");
      expect(text).not.toContain("Japan 4-0 Tunisia");
      expect(text).not.toContain("Argentina vs Austria");
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries transient ESPN scoreboard failures before deferring World Cup schedule answers", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-06-23T16:54:00+08:00"));
      const fetchMock = vi.fn(async () => {
        if (fetchMock.mock.calls.length === 1) {
          return new Response("temporary", { status: 503 });
        }
        return jsonResponse({
          events: [
            {
              date: "2026-06-23T17:00:00Z",
              status: { type: { completed: false, shortDetail: "Scheduled" } },
              season: { slug: "group-stage" },
              competitions: [{ competitors: [
                { homeAway: "home", score: "0", team: { displayName: "Portugal" } },
                { homeAway: "away", score: "0", team: { displayName: "Uzbekistan" } },
              ] }],
            },
          ],
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      const pending = createSportsScoreTool().execute("test", {
        query: "今晚世界杯有几场比赛？",
        maxResults: 5,
      });
      await vi.advanceTimersByTimeAsync(500);
      const result = await pending;
      const text = result.content[0].text;
      const answer = buildDirectResearchAnswer("sports", `【体育比分工具资料】\n\n${text}`, "今晚世界杯有几场比赛？");

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.details.provider).toBe("espn_scoreboard");
      expect(text).toContain("匹配比赛: 1 场");
      expect(text).toContain("Portugal vs Uzbekistan");
      expect(answer).toContain("共 1 场");
      expect(answer).not.toContain("专用体育比分源返回失败");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps World Cup tonight match-count answers inside the Beijing tonight window", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-06-25T20:20:00+08:00"));
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
        events: [
          {
            date: "2026-06-20T17:00:00Z",
            status: { type: { completed: true, shortDetail: "FT" } },
            competitions: [{ competitors: [
              { homeAway: "home", score: "5", team: { displayName: "Netherlands" } },
              { homeAway: "away", score: "1", team: { displayName: "Sweden" } },
            ] }],
          },
          {
            date: "2026-06-25T20:00:00Z",
            status: { type: { completed: false, shortDetail: "Scheduled" } },
            competitions: [{ competitors: [
              { homeAway: "home", score: "0", team: { displayName: "Curaçao" } },
              { homeAway: "away", score: "0", team: { displayName: "Ivory Coast" } },
            ] }],
          },
          {
            date: "2026-06-25T20:00:00Z",
            status: { type: { completed: false, shortDetail: "Scheduled" } },
            competitions: [{ competitors: [
              { homeAway: "home", score: "0", team: { displayName: "Ecuador" } },
              { homeAway: "away", score: "0", team: { displayName: "Germany" } },
            ] }],
          },
          {
            date: "2026-06-25T23:00:00Z",
            status: { type: { completed: false, shortDetail: "Scheduled" } },
            competitions: [{ competitors: [
              { homeAway: "home", score: "0", team: { displayName: "Japan" } },
              { homeAway: "away", score: "0", team: { displayName: "Sweden" } },
            ] }],
          },
          {
            date: "2026-06-25T23:00:00Z",
            status: { type: { completed: false, shortDetail: "Scheduled" } },
            competitions: [{ competitors: [
              { homeAway: "home", score: "0", team: { displayName: "Tunisia" } },
              { homeAway: "away", score: "0", team: { displayName: "Netherlands" } },
            ] }],
          },
          {
            date: "2026-06-26T02:00:00Z",
            status: { type: { completed: false, shortDetail: "Scheduled" } },
            competitions: [{ competitors: [
              { homeAway: "home", score: "0", team: { displayName: "Paraguay" } },
              { homeAway: "away", score: "0", team: { displayName: "Australia" } },
            ] }],
          },
          {
            date: "2026-06-26T02:00:00Z",
            status: { type: { completed: false, shortDetail: "Scheduled" } },
            competitions: [{ competitors: [
              { homeAway: "home", score: "0", team: { displayName: "Türkiye" } },
              { homeAway: "away", score: "0", team: { displayName: "United States" } },
            ] }],
          },
        ],
      })));

      const prompt = "今晚世界杯几场比赛帮我查一下";
      expect(inferReportResearchKind(prompt)).toBe("sports");
      const result = await createSportsScoreTool().execute("test", {
        query: prompt,
        maxResults: 5,
      });
      const text = result.content[0].text;
      const answer = buildDirectResearchAnswer("sports", `【体育比分工具资料】\n\n${text}`, prompt);

      expect(result.details.provider).toBe("espn_scoreboard");
      expect(text).toContain("dateRange: 20260625-20260626");
      expect(text).toContain("匹配比赛: 6 场");
      expect(text).toContain("Curaçao vs Ivory Coast");
      expect(text).toContain("Türkiye vs United States");
      expect(text).not.toContain("Netherlands 5-1 Sweden");
      expect(answer).toContain("共 6 场");
      expect(answer).not.toContain("2026/06/21");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps expanded sports search queries from widening tonight into tournament-history scores", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-06-25T20:20:00+08:00"));
      const fetchMock = vi.fn(async () => jsonResponse({
        events: [
          {
            date: "2026-06-20T17:00:00Z",
            status: { type: { completed: true, shortDetail: "FT" } },
            competitions: [{ competitors: [
              { homeAway: "home", score: "5", team: { displayName: "Netherlands" } },
              { homeAway: "away", score: "1", team: { displayName: "Sweden" } },
            ] }],
          },
          {
            date: "2026-06-25T20:00:00Z",
            status: { type: { completed: false, shortDetail: "Scheduled" } },
            competitions: [{ competitors: [
              { homeAway: "home", score: "0", team: { displayName: "Curaçao" } },
              { homeAway: "away", score: "0", team: { displayName: "Ivory Coast" } },
            ] }],
          },
          {
            date: "2026-06-25T20:00:00Z",
            status: { type: { completed: false, shortDetail: "Scheduled" } },
            competitions: [{ competitors: [
              { homeAway: "home", score: "0", team: { displayName: "Ecuador" } },
              { homeAway: "away", score: "0", team: { displayName: "Germany" } },
            ] }],
          },
          {
            date: "2026-06-25T23:00:00Z",
            status: { type: { completed: false, shortDetail: "Scheduled" } },
            competitions: [{ competitors: [
              { homeAway: "home", score: "0", team: { displayName: "Japan" } },
              { homeAway: "away", score: "0", team: { displayName: "Sweden" } },
            ] }],
          },
          {
            date: "2026-06-25T23:00:00Z",
            status: { type: { completed: false, shortDetail: "Scheduled" } },
            competitions: [{ competitors: [
              { homeAway: "home", score: "0", team: { displayName: "Tunisia" } },
              { homeAway: "away", score: "0", team: { displayName: "Netherlands" } },
            ] }],
          },
          {
            date: "2026-06-26T02:00:00Z",
            status: { type: { completed: false, shortDetail: "Scheduled" } },
            competitions: [{ competitors: [
              { homeAway: "home", score: "0", team: { displayName: "Paraguay" } },
              { homeAway: "away", score: "0", team: { displayName: "Australia" } },
            ] }],
          },
          {
            date: "2026-06-26T02:00:00Z",
            status: { type: { completed: false, shortDetail: "Scheduled" } },
            competitions: [{ competitors: [
              { homeAway: "home", score: "0", team: { displayName: "Türkiye" } },
              { homeAway: "away", score: "0", team: { displayName: "United States" } },
            ] }],
          },
          {
            date: "2026-06-26T15:00:00Z",
            status: { type: { completed: false, shortDetail: "Scheduled" } },
            competitions: [{ competitors: [
              { homeAway: "home", score: "0", team: { displayName: "Brazil" } },
              { homeAway: "away", score: "0", team: { displayName: "Morocco" } },
            ] }],
          },
        ],
      }));
      vi.stubGlobal("fetch", fetchMock);

      const result = await createSportsScoreTool().execute("test", {
        query: "2026世界杯 6月25日 赛程 今晚比赛 比分 赛果",
        maxResults: 5,
      });
      const text = result.content[0].text;

      expect(String(fetchMock.mock.calls[0][0])).toContain("dates=20260624-20260627");
      expect(text).toContain("dateRange: 20260625-20260626");
      expect(text).toContain("匹配比赛: 6 场");
      expect(text).toContain("Curaçao vs Ivory Coast");
      expect(text).toContain("Türkiye vs United States");
      expect(text).not.toContain("Netherlands 5-1 Sweden");
      expect(text).not.toContain("Brazil vs Morocco");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not use stale bundled World Cup rows for explicit dates outside the fallback table", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-06-25T20:20:00+08:00"));
      vi.stubGlobal("fetch", vi.fn(async () => {
        throw new Error("fetch failed");
      }));

      const pending = createSportsScoreTool().execute("test", {
        query: "2026世界杯 6月30日 赛程",
        maxResults: 5,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await pending;
      const text = result.content[0].text;

      expect(text).toContain("directSourceStatus: unavailable");
      expect(text).not.toContain("fallback_static_schedule");
      expect(text).not.toContain("2026/06/21");
      expect(text).not.toContain("Netherlands 5-1 Sweden");
    } finally {
      vi.useRealTimers();
    }
  });

  it("filters World Cup scoreboard by mentioned teams before answering match-existence questions", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-06-21T15:30:00+08:00"));
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
        events: [
          {
            date: "2026-06-21T16:00Z",
            status: { type: { completed: false, shortDetail: "Scheduled" } },
            competitions: [{ competitors: [
              { homeAway: "home", score: "0", team: { displayName: "Spain" } },
              { homeAway: "away", score: "0", team: { displayName: "Saudi Arabia" } },
            ] }],
          },
          {
            date: "2026-06-17T19:00Z",
            status: { type: { completed: true, shortDetail: "FT" } },
            competitions: [{ competitors: [
              { homeAway: "home", score: "4", team: { displayName: "England" } },
              { homeAway: "away", score: "2", team: { displayName: "Croatia" } },
            ] }],
          },
        ],
      })));

      const prompt = "查一下今晚英格兰与克罗地亚是否有比赛";
      expect(inferReportResearchKind(prompt)).toBe("sports");
      const result = await createSportsScoreTool().execute("test", {
        query: prompt,
        maxResults: 5,
      });
      const text = result.content[0].text;
      const answer = buildDirectResearchAnswer("sports", `【体育比分工具资料】\n\n${text}`, prompt);

      expect(searchMock.runSearchQuery).not.toHaveBeenCalled();
      expect(result.details.provider).toBe("espn_scoreboard");
      expect(text).toContain("matched: 0");
      expect(answer).toContain("今晚没有世界杯比赛");
      expect(answer).toContain("按北京时间口径返回 0 场");
      expect(answer).not.toContain("不等于赛事数量为 0");
      expect(answer).not.toContain("Spain vs Saudi Arabia");
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses ESPN scoreboard directly for World Cup semifinal dates", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      events: [
        {
          date: "2026-07-14T19:00Z",
          status: { type: { completed: false, shortDetail: "Scheduled" } },
          competitions: [{ competitors: [
            { homeAway: "home", score: "0", team: { displayName: "Quarterfinal 1 Winner" } },
            { homeAway: "away", score: "0", team: { displayName: "Quarterfinal 2 Winner" } },
          ] }],
        },
        {
          date: "2026-07-15T19:00Z",
          status: { type: { completed: false, shortDetail: "Scheduled" } },
          competitions: [{ competitors: [
            { homeAway: "home", score: "0", team: { displayName: "Quarterfinal 3 Winner" } },
            { homeAway: "away", score: "0", team: { displayName: "Quarterfinal 4 Winner" } },
          ] }],
        },
      ],
    })));

    const result = await createSportsScoreTool().execute("test", {
      query: "世界杯半决赛在哪一天？",
      maxResults: 5,
    });
    const text = result.content[0].text;

    expect(searchMock.runSearchQuery).not.toHaveBeenCalled();
    expect(result.details.provider).toBe("espn_scoreboard");
    expect(text).toContain("2026/07/15");
    expect(text).toContain("2026/07/16");
    expect(text).toContain("Quarterfinal 1 Winner vs Quarterfinal 2 Winner");
  });

  it("uses the built-in World Cup fixture fallback when semifinal scoreboard fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("fetch failed");
    }));

    const result = await createSportsScoreTool().execute("test", {
      query: "世界杯半决赛在哪一天？",
      maxResults: 5,
    });
    const text = result.content[0].text;

    expect(searchMock.runSearchQuery).not.toHaveBeenCalled();
    expect(result.details.provider).toBe("espn_scoreboard");
    expect(text).toContain("directSourceStatus: fallback_static_schedule");
    expect(text).toContain("2026/07/15");
    expect(text).toContain("2026/07/16");
    expect(text).toContain("Quarterfinal 1 Winner vs Quarterfinal 2 Winner");
    expect(text).not.toContain("directSourceStatus: unavailable");
  });

  it("uses the built-in World Cup fixture fallback when tonight scoreboard fetch fails", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-06-28T20:20:00+08:00"));
      vi.stubGlobal("fetch", vi.fn(async () => {
        throw new Error("fetch failed");
      }));

      const pending = createSportsScoreTool().execute("test", {
        query: "今晚世界杯有几场比赛",
        maxResults: 5,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await pending;
      const text = result.content[0].text;

      expect(result.details.provider).toBe("espn_scoreboard");
      expect(text).toContain("directSourceStatus: fallback_static_schedule");
      expect(text).toContain("2026/06/29 03:00 Group stage: South Africa vs Canada");
      expect(text).not.toContain("directSourceStatus: unavailable");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not inject weak HTML fallback results as sports score evidence", async () => {
    searchMock.runSearchQuery.mockResolvedValue({
      provider: "bing-html",
      plan: { scene: "sports" },
      results: [{
        title: "今晚7:35，武汉吃黄鳝",
        url: "https://example.com/local-league",
        snippet: "地方联赛新闻，不是中超赛程。",
      }],
    });

    const result = await createSportsScoreTool().execute("test", {
      query: "中超今天有什么比赛吗",
      maxResults: 5,
    });
    const text = result.content[0].text;

    expect(searchMock.runSearchQuery).not.toHaveBeenCalled();
    expect(result.details.provider).toBe("espn_scoreboard");
    expect(result.details.directSourceStatus).toBe("unavailable");
    expect(text).toContain("体育查询结果");
    expect(text).toContain("directSourceStatus: unavailable");
    expect(text).not.toContain("武汉吃黄鳝");
    expect(text).not.toContain("地方联赛新闻");
  });

  it("does not expose or fetch search-result page urls from Brain sports summaries", async () => {
    searchMock.runSearchQuery.mockResolvedValue({
      provider: "lynn-brain/glm",
      plan: { scene: "sports" },
      results: [{
        title: "世界杯6连败终结！加拿大队1-1波黑队！",
        url: "https://www.baidu.com/s?wd=%E4%B8%96%E7%95%8C%E6%9D%AF",
        snippet: "2026美加墨世界杯小组赛B组首轮，加拿大队1-1战平波黑队。",
      }],
    });

    const result = await createSportsScoreTool().execute("test", {
      query: "中超今天有什么比赛吗",
      maxResults: 5,
    });
    const text = result.content[0].text;

    expect(searchMock.runSearchQuery).not.toHaveBeenCalled();
    expect(fetchContentMock.fetchWebContent).not.toHaveBeenCalled();
    expect(result.details.provider).toBe("espn_scoreboard");
    expect(text).toContain("directSourceStatus: unavailable");
    expect(text).not.toContain("加拿大队1-1战平波黑队");
    expect(text).not.toContain("https://www.baidu.com/s");
  });

  it("uses Open-Meteo forecast data with temperature and rain probability", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const href = String(url);
      if (href.includes("geocoding-api.open-meteo.com")) {
        return jsonResponse({
          results: [{
            name: "深圳",
            admin1: "广东",
            latitude: 22.54554,
            longitude: 114.0683,
            timezone: "Asia/Shanghai",
          }],
        });
      }
      if (href.includes("api.open-meteo.com")) {
        return jsonResponse({
          current: {
            temperature_2m: 22.2,
            apparent_temperature: 24.1,
            relative_humidity_2m: 80,
            precipitation: 0.1,
            weather_code: 3,
            wind_speed_10m: 9.2,
          },
          daily: {
            time: ["2026-04-24", "2026-04-25"],
            weather_code: [61, 3],
            temperature_2m_min: [20.1, 21.0],
            temperature_2m_max: [26.6, 28.0],
            precipitation_probability_max: [80, 25],
            precipitation_sum: [3.2, 0.1],
          },
        });
      }
      throw new Error(`unexpected fetch ${href}`);
    }));

    const result = await createWeatherTool().execute("test", {
      query: "深圳明天天气如何？给温度区间和降雨概率",
    });
    const text = result.content[0].text;

    expect(result.details.provider).toBe("open-meteo");
    expect(result.details.location).toBe("深圳");
    expect(result.details.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "weather",
        source: "open-meteo",
        location: "深圳",
        fallback: true,
      }),
    ]));
    expect(text).toContain("深圳 · 广东");
    expect(text).toContain("问题匹配日期：明天");
    expect(text).toContain("明天 2026-04-25");
    expect(text).toContain("21~28°C");
    expect(text).toContain("降雨概率 25%");
    expect(text).toContain("降雨判断: 有降雨可能");
  });

  it("uses Open-Meteo air quality data for AQI questions", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const href = String(url);
      if (href.includes("air-quality-api.open-meteo.com")) {
        expect(decodeURIComponent(href)).toContain("latitude=39.9042");
        return jsonResponse({
          current: {
            time: "2026-06-21T16:00",
            us_aqi: 42,
            pm2_5: 8.1,
            pm10: 21.4,
            ozone: 82.5,
            nitrogen_dioxide: 13.2,
          },
        });
      }
      throw new Error(`unexpected fetch ${href}`);
    }));

    const result = await createWeatherTool().execute("test", {
      query: "北京今天空气质量怎么样？",
    });
    const text = result.content[0].text;

    expect(result.details.provider).toBe("open-meteo-air-quality");
    expect(result.details.location).toBe("北京");
    expect(text).toContain("北京 · 北京 当前空气质量");
    expect(text).toContain("AQI(US): 42（优）");
    expect(text).toContain("PM2.5: 8.1");

    const answer = buildDirectResearchAnswer("weather", text, "北京今天空气质量怎么样？");
    expect(answer).toContain("北京空气质量");
    expect(answer).toContain("AQI(US) 42");
    expect(answer).toContain("PM2.5 8.1");
  });

  it("extracts the city from spoken ASR filler before weather lookup", async () => {
    expect(extractWeatherLocation("嗯，我要查的是什我要查的是深圳天气。")).toBe("深圳");
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const href = String(url);
      if (href.includes("wttr.in")) throw new Error("wttr unavailable");
      if (href.includes("geocoding-api.open-meteo.com")) {
        expect(decodeURIComponent(href)).toContain("深圳");
        expect(decodeURIComponent(href)).not.toContain("我要查的是");
        return jsonResponse({
          results: [{
            name: "深圳",
            admin1: "广东",
            latitude: 22.54554,
            longitude: 114.0683,
            timezone: "Asia/Shanghai",
          }],
        });
      }
      if (href.includes("api.open-meteo.com")) {
        return jsonResponse({
          current: {
            temperature_2m: 24,
            relative_humidity_2m: 70,
            precipitation: 0,
            weather_code: 2,
            wind_speed_10m: 8,
          },
          daily: {
            time: ["2026-05-01", "2026-05-02"],
            weather_code: [2, 61],
            temperature_2m_min: [21, 22],
            temperature_2m_max: [27, 26],
            precipitation_probability_max: [10, 50],
          },
        });
      }
      throw new Error(`unexpected fetch ${href}`);
    }));

    const result = await createWeatherTool().execute("test", {
      query: "嗯，我要查的是什我要查的是深圳天气。",
    });

    expect(result.details.location).toBe("深圳");
    expect(result.content[0].text).toContain("深圳 · 广东");
    expect(result.content[0].text).not.toContain("我要查的是");
  });

  it("localizes wttr weather labels for Chinese city queries", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const href = String(url);
      if (href.includes("wttr.in")) {
        return jsonResponse({
          nearest_area: [{ areaName: [{ value: "Pootung" }] }],
          current_condition: [{
            weatherDesc: [{ value: "Sunny" }],
            temp_C: "24",
            FeelsLikeC: "25",
            humidity: "54",
            windspeedKmph: "10",
            precipMM: "0.0",
          }],
          weather: [
            {
              date: "2026-04-24",
              mintempC: "18",
              maxtempC: "26",
              hourly: [{ weatherDesc: [{ value: "Sunny" }] }],
            },
            {
              date: "2026-04-25",
              mintempC: "19",
              maxtempC: "27",
              hourly: [{ weatherDesc: [{ value: "Patchy rain nearby" }] }],
            },
          ],
        });
      }
      throw new Error(`unexpected fetch ${href}`);
    }));

    const result = await createWeatherTool().execute("test", {
      query: "上海明天天气",
    });
    const text = result.content[0].text;

    expect(result.details.provider).toBe("wttr.in");
    expect(result.details.location).toBe("上海");
    expect(text).toContain("上海 当前天气");
    expect(text).toContain("天气: 晴");
    expect(text).toContain("24°C");
    expect(text).toContain("问题匹配日期：明天");
    expect(text).toContain("明天 2026-04-25");
    expect(text).not.toContain("今天 2026-04-24");
    expect(text).toContain("附近有零星小雨");
    expect(text).toContain("降雨判断: 有降雨可能");
    expect(text).not.toContain("Pootung");
  });

  it("treats future two days as tomorrow and the day after tomorrow", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const href = String(url);
      if (href.includes("wttr.in")) throw new Error("wttr unavailable");
      if (href.includes("api.open-meteo.com")) {
        expect(href).toContain("forecast_days=3");
        return jsonResponse({
          current: {
            temperature_2m: 27,
            relative_humidity_2m: 80,
            precipitation: 0,
            weather_code: 3,
            wind_speed_10m: 6,
          },
          daily: {
            time: ["2026-05-25", "2026-05-26", "2026-05-27"],
            weather_code: [80, 81, 3],
            temperature_2m_min: [24, 25, 24],
            temperature_2m_max: [33, 31, 30],
            precipitation_probability_max: [95, 97, 77],
            precipitation_sum: [4, 3, 0],
          },
        });
      }
      throw new Error(`unexpected fetch ${href}`);
    }));

    const result = await createWeatherTool().execute("test", {
      query: "杭州未来两天的天气",
    });
    const text = result.content[0].text;

    expect(result.details.location).toBe("杭州");
    expect(text).toContain("问题匹配日期：未来2天（不含今天）");
    expect(text).toContain("明天 2026-05-26");
    expect(text).toContain("后天 2026-05-27");
    expect(text).not.toContain("今天 2026-05-25");
    expect(text).toContain("降雨判断: 有降雨可能");
  });

  it("extracts common city names from rain questions without a weather keyword", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const href = String(url);
      if (href.includes("geocoding-api.open-meteo.com")) {
        return jsonResponse({
          results: [{
            name: "上海",
            admin1: "上海",
            latitude: 31.2304,
            longitude: 121.4737,
            timezone: "Asia/Shanghai",
          }],
        });
      }
      if (href.includes("api.open-meteo.com")) {
        return jsonResponse({
          current: {
            temperature_2m: 18,
            apparent_temperature: 18,
            relative_humidity_2m: 70,
            precipitation: 0,
            weather_code: 3,
            wind_speed_10m: 8,
          },
          daily: {
            time: ["2026-04-24", "2026-04-25"],
            weather_code: [3, 61],
            temperature_2m_min: [15, 16],
            temperature_2m_max: [21, 22],
            precipitation_probability_max: [10, 65],
            precipitation_sum: [0, 2.3],
          },
        });
      }
      throw new Error(`unexpected fetch ${href}`);
    }));

    const result = await createWeatherTool().execute("test", {
      query: "上海明天下雨吗？",
    });

    expect(result.details.provider).toBe("open-meteo");
    expect(result.details.location).toBe("上海");
    expect(result.content[0].text).toContain("上海 · 上海");
    expect(result.content[0].text).toContain("降雨概率 65%");
  });

  it("does not strip the leading character from city names such as 和田", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const href = String(url);
      if (href.includes("geocoding-api.open-meteo.com")) {
        expect(decodeURIComponent(href)).toContain("和田");
        return jsonResponse({
          results: [{
            name: "和田",
            admin1: "新疆",
            latitude: 37.1143,
            longitude: 79.9225,
            timezone: "Asia/Shanghai",
          }],
        });
      }
      if (href.includes("api.open-meteo.com")) {
        return jsonResponse({
          current: {
            temperature_2m: 12,
            apparent_temperature: 11,
            relative_humidity_2m: 40,
            precipitation: 0,
            weather_code: 0,
            wind_speed_10m: 7,
          },
          daily: {
            time: ["2026-04-24", "2026-04-25"],
            weather_code: [0, 1],
            temperature_2m_min: [8, 9],
            temperature_2m_max: [20, 22],
            precipitation_probability_max: [0, 5],
            precipitation_sum: [0, 0],
          },
        });
      }
      throw new Error(`unexpected fetch ${href}`);
    }));

    const result = await createWeatherTool().execute("test", {
      query: "和田明天天气",
    });

    expect(result.details.location).toBe("和田");
    expect(result.content[0].text).toContain("和田 · 新疆");
  });

  it("does not treat weather site navigation pages as concrete weather evidence", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network unavailable");
    }));
    searchMock.runSearchQuery.mockResolvedValue({
      provider: "mock-search",
      results: [{
        title: "上海天气预报 - 首页",
        url: "https://www.weather.com.cn/weather/101020100.shtml",
        snippet: "天气首页 生活指数 城市导航 空气质量 旅游 景点 天气新闻",
      }],
    });
    fetchContentMock.fetchWebContent.mockResolvedValue({
      text: "天气首页 生活指数 城市导航 空气质量 旅游 景点 天气新闻 上海天气预报",
    });

    const result = await createWeatherTool().execute("test", {
      query: "今天上海天气如何",
    });
    const text = result.content[0].text;

    expect(result.details.fallback).toBe(true);
    expect(text).toContain("未检索到明确天气数据");
    expect(text).not.toContain("生活指数 城市导航");

    const direct = buildDirectResearchAnswer("weather", text, "今天上海天气如何");
    expect(direct).toContain("上海本轮 weather 调用在上游网络层失败");
    expect(direct).toContain("只报告源状态");
    expect(direct).toContain("不把天气网站首页、导航菜单或搜索噪声当作结论");
    expect(direct).toContain("中国天气网");
    const normalized = direct.replace(/\s+/g, "");
    expect(normalized).not.toMatch(/(?:没有|未包含|不包含|缺少|暂无|不支持).{0,24}(?:天气|搜索|查询|检索|行情|股价|金价|汇率|比分|赛程|网页|访问).{0,24}(?:工具|功能|能力|接口)/u);
    expect(normalized).not.toMatch(/(?:无法|不能|没法|不支持).{0,24}(?:实时|在线|联网|访问网页|查询天气|查询股价|查询汇率|查询比分|查询赛程)/u);
  });
});
