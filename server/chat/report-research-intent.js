import { extractWeatherLocation } from "../../lib/tools/realtime-info.js";
import { inferReportPromptKind } from "../../shared/report-normalizer.js";
const KNOWN_STOCK_NAME_TO_CODE = new Map([
  ["华丰科技", "688629"],
]);
const STOCK_COMPANY_RE = /[\u4e00-\u9fa5A-Za-z]{2,18}(?:科技|股份|电子|智能|软件|证券|银行|集团|药业|医药|能源|材料|半导体|光电|电气|通信|汽车|机器人|芯片|电力|股份)/;
const STOCK_ANALYSIS_RE = /(?:股票|股价|个股|A股|a股|科创板|创业板|沪深|标的|走势|怎么看|技术面|基本面|估值|市值|总股本|PE|PB|PS|资金|资金流|财报|研报|公告|解禁|减持|支撑位|压力位|K线|k线|均线|成交量|成交额|筹码|止损|止盈|仓位|目标价|三种情景|操作计划|未来1-3个月)/i;
const GENERIC_RESEARCH_RE = /(?=.*(?:调研|研究|分析|评估|对比|比较|判断|怎么看|报告|预测|整理|汇总))(?=.*(?:最新|数据|资料|来源|公司|行业|市场|政策|公告|财报|研报|楼盘|房价|成交|竞品|价格|估值|市值|PDF|文档|报表|合同|产品|品牌))/i;
const WEATHER_LOOKUP_RE = /(?:天气|气温|温度|预报|冷不冷|热不热|下雨|下雪|多少度|几度|紫外线|空气质量|湿度|风力|体感|带伞|雨伞)/i;
const SPORTS_LOOKUP_RE = /(?:比分|赛程|排名|战绩|湖人|勇士|NBA|CBA|英超|中超|欧冠|世界杯|比赛结果)/i;
const MARKET_LOOKUP_RE = /(?:金价|黄金|白银|油价|原油|汇率|美元|人民币|指数|基金|ETF|etf|股价|股票|行情|收盘|涨跌|现价|最新价|美股|港股|A股|a股|恒生|恒指|纳指|道指|标普|AAPL|TSLA|NVDA|MSFT|GOOGL|AMZN|META|\$[A-Z]{1,5}\b)/i;
const STOCK_BASKET_LOOKUP_RE = /(?:港股.{0,8}科技股?|科技股?.{0,8}港股|恒生科技(?!指数)|港股互联网|港股.{0,8}互联网|中概科技|(?:美股|纳斯达克|纳指|七巨头|magnificent|mag7).{0,12}(?:科技股?|AI|人工智能|芯片|半导体|互联网)|(?:科技股?|AI|人工智能|芯片|半导体|互联网).{0,12}(?:美股|纳斯达克|纳指|七巨头|magnificent|mag7)|(?:A股|a股|沪深|科创|创业板).{0,12}(?:AI|人工智能|算力|服务器|光模块|CPO|高速连接|科技股?|半导体|芯片|新能源|电动车|锂电|光伏|机器人|人形机器人|券商|证券|白酒|消费)|(?:AI|人工智能|算力|服务器|光模块|CPO|高速连接|科技股?|半导体|芯片|新能源|电动车|锂电|光伏|机器人|人形机器人|券商|证券|白酒|消费).{0,12}(?:A股|a股|沪深|科创|创业板))/i;
const CONCEPT_STOCK_LOOKUP_RE = /(?:概念股|概念板块|板块|行业|题材|赛道|龙头|成分股|产业链|科技股)/i;
const MARKET_WEATHER_BRIEF_RE = /(?:机场|出行|着装|穿什么|穿搭|行动建议|浦东|虹桥|登机|航班|明早|早班机|数据快照|行动建议)/i;
const LIVE_NEWS_LOOKUP_RE = /(?=.*(?:今天|今日|今晚|最新|实时|进展|消息|新闻|报道|发生|了吗|如何|怎么样|快讯|热点|全网))(?=.*(?:AI|人工智能|科技|大模型|模型|Gemini|OpenAI|Anthropic|Claude|芯片|半导体|机器人|美伊|伊朗|美国|中东|巴以|以色列|巴勒斯坦|俄乌|俄罗斯|乌克兰|关税|制裁|冲突|停火|谈判|选举|地震|台风|事故|发布|宣布|外交|战争|袭击|股市|市场|公司|政策|干细胞|细胞治疗|再生医学|临床|医疗|医药|医院|药企))/i;
const EXTERNAL_RESEARCH_INTENT_RE = /(?:最新|实时|今天|今日|联网|搜索|查询|查一下|找一下|资料|来源|链接|官网|网页|公开信息|公告|财报|研报|新闻|政策|PDF|文档|市场数据|行业数据|竞品)/i;
const LOCAL_OFFICE_TASK_RE = /(?:会议记录|会议纪要|行动项|负责人|截止时间|风险|经营分析|环比|增长率|根据数据|下面会议|Q[1-4]|报价模板|客户\s*[A-Z]\b)/i;
const MARKET_WEATHER_TICKER_STOPWORDS = new Set([
  "AI", "API", "ETF", "ETFS", "USD", "CNY", "EUR", "GBP", "JPY",
  "PE", "PB", "PS", "IPO", "CEO", "CFO", "GDP", "CPI", "PPI",
  "MACD", "RSI", "UTC", "PPT", "TOOL",
]);
const COMMON_US_TICKERS = new Set([
  "AAPL", "TSLA", "NVDA", "MSFT", "GOOGL", "GOOG", "AMZN", "META",
  "NFLX", "AMD", "INTC", "AVGO", "SMCI", "PLTR", "COIN", "MSTR",
  "BABA", "PDD", "NIO", "XPEV", "LI",
]);
const INDEX_TARGETS = [
  { re: /上证指数|上证综指|沪指/, label: "上证指数", query: "上证指数 最新点位" },
  { re: /深证成指/, label: "深证成指", query: "深证成指 最新点位" },
  { re: /创业板指/, label: "创业板指", query: "创业板指 最新点位" },
  { re: /恒生指数|恒指/, label: "恒生指数", query: "恒生指数 最新点位" },
  { re: /纳斯达克|纳指/, label: "纳斯达克指数", query: "纳斯达克指数 最新点位" },
  { re: /道琼斯|道指/, label: "道琼斯指数", query: "道琼斯指数 最新点位" },
  { re: /标普(?:500)?/, label: "标普500", query: "标普500 最新点位" },
];
const AIRPORT_CITY_HINTS = [
  { re: /浦东|虹桥/, city: "上海" },
  { re: /首都机场|大兴/, city: "北京" },
  { re: /白云机场/, city: "广州" },
  { re: /宝安机场/, city: "深圳" },
];
export function extractStockTargetForResearch(text) {
  const source = String(text || "");
  const code = source.match(/\b([0368]\d{5})\b/)?.[1] || "";
  for (const [name, mappedCode] of KNOWN_STOCK_NAME_TO_CODE) {
    if (source.includes(name)) return { name, code: code || mappedCode };
  }
  const name = source.match(STOCK_COMPANY_RE)?.[0] || "";
  if (name || code) return { name, code };
  return { name: "", code: "" };
}
export function inferReportResearchKind(text) {
  const normalized = String(text || "").trim();
  if (!normalized) return "";
  if (WEATHER_LOOKUP_RE.test(normalized) && MARKET_LOOKUP_RE.test(normalized) && MARKET_WEATHER_BRIEF_RE.test(normalized)) {
    return "market_weather_brief";
  }
  if ((STOCK_BASKET_LOOKUP_RE.test(normalized) || CONCEPT_STOCK_LOOKUP_RE.test(normalized))
    && /(?:现在|今日|今天|最新|当前|表现|行情|报价|涨跌幅|涨跌|收盘|盘中|看一下|怎么样|如何)/.test(normalized)
    && !/(?:深度|报告|长期|未来|预测|估值|基本面|技术面|研报|三种情景|操作计划)/.test(normalized)) {
    return "market";
  }
  const promptKind = inferReportPromptKind(normalized);
  if (promptKind) return promptKind;
  const target = extractStockTargetForResearch(normalized);
  const simpleQuoteIntent = /(?:现在|今日|今天|最新|当前|多少|价格|股价|行情|报价|涨跌幅|涨跌|来源)/.test(normalized);
  const analysisIntent = /(?:支撑位|压力位|K线|k线|均线|成交量|成交额|筹码|止损|止盈|目标价|怎么看|走势|分析|研究|深度|报告|未来|预测|估值|市值|基本面|技术面|资金|财报|研报|公告|解禁|减持|三种情景|操作计划)/.test(normalized);
  if ((target.name || target.code) && MARKET_LOOKUP_RE.test(normalized) && simpleQuoteIntent && !analysisIntent) return "market";
  if ((target.name || target.code) && STOCK_ANALYSIS_RE.test(normalized)) return "stock";
  if (/支撑位|压力位|K线|k线|均线|成交量|成交额|筹码|止损|止盈|目标价/.test(normalized)
    && /(?:\b[0368]\d{5}\b|股票|股价|个股|A股|a股|科创板|创业板|华丰科技)/.test(normalized)) {
    return "stock";
  }
  if (WEATHER_LOOKUP_RE.test(normalized)) return "weather";
  if (SPORTS_LOOKUP_RE.test(normalized)) return "sports";
  if (MARKET_LOOKUP_RE.test(normalized)) return "market";
  if (/(?:新闻|消息|报道|快讯|热点)/.test(normalized) && /(?:今天|今日|最新|实时|全网|查一下|查查|查询|搜索|有什么|哪些)/.test(normalized)) return "news";
  if (LIVE_NEWS_LOOKUP_RE.test(normalized)) return "news";
  if (GENERIC_RESEARCH_RE.test(normalized) && EXTERNAL_RESEARCH_INTENT_RE.test(normalized) && !LOCAL_OFFICE_TASK_RE.test(normalized)) return "generic";
  return "";
}
export function extractRequestedUsTickers(text) {
  const symbols = [];
  for (const match of String(text || "").matchAll(/\$?\b([A-Z]{1,5})(?:\.US)?\b/g)) {
    const raw = String(match[0] || "");
    const bare = String(match[1] || "").toUpperCase();
    if (MARKET_WEATHER_TICKER_STOPWORDS.has(bare)) continue;
    if (!raw.startsWith("$") && !COMMON_US_TICKERS.has(bare)) continue;
    if (!symbols.includes(bare)) symbols.push(bare);
  }
  return symbols.slice(0, 8);
}
export function extractPrimaryUsTicker(text) {
  const normalized = String(text || "");
  const seen = new Set();
  for (const match of normalized.matchAll(/\$?\b([A-Z]{2,5})\b/g)) {
    const symbol = (match[1] || "").toUpperCase();
    if (!symbol || MARKET_WEATHER_TICKER_STOPWORDS.has(symbol) || seen.has(symbol)) continue;
    seen.add(symbol);
    return symbol;
  }
  return "";
}
export function detectPrimaryIndexTarget(text) {
  const normalized = String(text || "");
  return INDEX_TARGETS.find((item) => item.re.test(normalized)) || null;
}
export function extractCompositeWeatherLocation(text) {
  const normalized = String(text || "");
  for (const hint of AIRPORT_CITY_HINTS) {
    if (hint.re.test(normalized)) return hint.city;
  }
  const clause = normalized.match(/[^。；，,\n]{0,80}(?:天气|气温|温度|预报)/)?.[0] || normalized;
  return extractWeatherLocation(clause, "");
}
export function extractWeatherLocationForResearch(query, fallback = "") {
  return extractWeatherLocation(query, fallback);
}
export function inferKind(promptText) {
  const source = String(promptText || "");
  const kind = inferReportResearchKind(source);
  const stockTarget = extractStockTargetForResearch(source);
  const target = stockTarget.name || stockTarget.code ? stockTarget : undefined;
  const ticker = extractPrimaryUsTicker(source);
  const indexTarget = detectPrimaryIndexTarget(source);
  const weatherLocation = extractCompositeWeatherLocation(source);
  return {
    kind,
    ...(target ? { target } : {}),
    ...(ticker ? { ticker } : {}),
    ...(indexTarget ? { indexTarget } : {}),
    ...(weatherLocation ? { weatherLocation } : {}),
  };
}
