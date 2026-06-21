import { getLocale } from "../../server/i18n.js";
import type { GoldSignals, MarketKind, MarketSource, NamedPrice, PriceRange } from "./stock-market-types.js";

export const DEFAULT_FETCH_COUNT = 2;
export const GOLD_FETCH_COUNT = 8;
export const MAX_FETCH_LENGTH = 3600;
export const MAX_LINES_PER_SOURCE = 4;
export const STOOQ_TIMEOUT_MS = 6500;

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const US_STOCK_NAME_TO_SYMBOL = new Map([
  ["苹果", "AAPL"],
  ["apple", "AAPL"],
  ["特斯拉", "TSLA"],
  ["tesla", "TSLA"],
  ["英伟达", "NVDA"],
  ["辉达", "NVDA"],
  ["nvidia", "NVDA"],
  ["微软", "MSFT"],
  ["microsoft", "MSFT"],
  ["谷歌", "GOOGL"],
  ["alphabet", "GOOGL"],
  ["亚马逊", "AMZN"],
  ["amazon", "AMZN"],
  ["meta", "META"],
  ["脸书", "META"],
]);

export const HK_STOCK_NAME_TO_SYMBOL = new Map([
  ["腾讯控股", "00700"],
  ["腾讯", "00700"],
  ["阿里巴巴", "09988"],
  ["阿里", "09988"],
  ["美团", "03690"],
  ["小米集团", "01810"],
  ["小米", "01810"],
  ["快手", "01024"],
  ["京东集团", "09618"],
  ["京东", "09618"],
  ["网易", "09999"],
  ["百度", "09888"],
  ["哔哩哔哩", "09626"],
]);

export const HK_TECH_BASKET_SYMBOLS = ["00700", "09988", "03690", "01810", "01024", "09618"];
export const US_TECH_BASKET_SYMBOLS = ["AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "TSLA"];

export const A_STOCK_NAME_TO_SYMBOL = new Map([
  ["雪人集团", "002639"],
  ["华丰科技", "688629"],
  ["拓维信息", "002261"],
  ["每日互动", "300766"],
  ["浙数文化", "600633"],
  ["中际旭创", "300308"],
  ["新易盛", "300502"],
  ["科大讯飞", "002230"],
  ["浪潮信息", "000977"],
  ["中芯国际", "688981"],
  ["兆易创新", "603986"],
  ["比亚迪", "002594"],
  ["宁德时代", "300750"],
  ["东方财富", "300059"],
  ["中信证券", "600030"],
  ["贵州茅台", "600519"],
  ["五粮液", "000858"],
]);

export const A_STOCK_BASKETS = [
  {
    re: /(?:A\s*股|a\s*股|沪深|A股|a股).{0,16}(?:异动|表现|行情|涨跌|涨幅|跌幅|今天|今日|盘中)|(?:异动|表现|行情|涨跌|涨幅|跌幅).{0,16}(?:A\s*股|a\s*股|沪深|A股|a股)/i,
    symbols: ["300059", "600030", "002261", "300308", "300750", "600519"],
  },
  {
    re: /(?:A\s*股|a\s*股|A股|a股|沪深|科创|创业板).{0,12}(?:AI|人工智能|算力|服务器|光模块|CPO|高速连接|科技|半导体|芯片)|(?:AI|人工智能|算力|服务器|光模块|CPO|高速连接|半导体|芯片).{0,12}(?:A\s*股|a\s*股|A股|a股|沪深|科创|创业板)/i,
    symbols: ["688629", "300308", "300502", "002230", "000977", "688981"],
  },
  {
    re: /(?:A\s*股|a\s*股|A股|a股|沪深|创业板|科创).{0,12}(?:新能源|电动车|锂电|光伏)|(?:新能源|电动车|锂电|光伏).{0,12}(?:A\s*股|a\s*股|A股|a股|沪深|创业板|科创)/i,
    symbols: ["300750", "002594", "601012", "300014"],
  },
  {
    re: /(?:A\s*股|a\s*股|A股|a股|沪深|创业板|科创).{0,12}(?:机器人|人形机器人)|(?:机器人|人形机器人).{0,12}(?:A\s*股|a\s*股|A股|a股|沪深|创业板|科创)/i,
    symbols: ["300024", "688017", "002747", "300124"],
  },
  {
    re: /(?:A\s*股|a\s*股|A股|a股|沪深).{0,12}(?:券商|证券)|(?:券商|证券).{0,12}(?:A\s*股|a\s*股|A股|a股|沪深)/i,
    symbols: ["600030", "601688", "600837", "000776"],
  },
  {
    re: /(?:A\s*股|a\s*股|A股|a股|沪深).{0,12}(?:白酒|消费)|(?:白酒|消费).{0,12}(?:A\s*股|a\s*股|A股|a股|沪深)/i,
    symbols: ["600519", "000858", "000568", "000596"],
  },
];

export const SLOW_OR_LOW_VALUE_CONCEPT_HOST_RE =
  /(?:^|\.)zhihu\.com$|(?:^|\.)southmoney\.com$|(?:^|\.)xueqiu\.com$/i;

export const TICKER_STOPWORDS = new Set([
  "AI", "API", "ETF", "ETFS", "USD", "CNY", "EUR", "GBP", "JPY",
  "PE", "PB", "PS", "IPO", "CEO", "CFO", "GDP", "CPI", "PPI",
  "MACD", "RSI", "US", "CN", "HK", "TOOL",
]);

export const KNOWN_US_STOCK_SYMBOLS = new Set([...US_STOCK_NAME_TO_SYMBOL.values()]);
export const NOISY_FINANCE_SOURCE_NAMES = new Set(["东方财富", "中信证券"]);

export const FINANCE_LOOKUP_CONTEXT_RE =
  /(?:股票|股价|行情|最新价|现价|收盘|开盘|涨跌|成交|市值|美股|港股|A\s*股|a\s*股|A股|a股|纳斯达克|纽交所|道指|标普|纳指|概念股|板块|行业|题材|赛道|龙头|成分股|异动|ticker|symbol|stock|share|price|quote|market|nasdaq|nyse)/i;
export const NON_FINANCE_QUOTE_CONTEXT_RE =
  /(?:报价模板|报价单|销售报价|客户报价|统一报价|报价流程|方案报价|采购报价|合同报价|客户\s*[A-Z]\b|会议记录|会议纪要|行动项|负责人|截止时间)/i;

export function isZhLocale(): boolean {
  return String(getLocale?.() || "").startsWith("zh");
}

export function detectKind(query: unknown, explicitKind = ""): MarketKind {
  const forced = String(explicitKind || "").trim().toLowerCase();
  if (forced) return forced;
  const text = String(query || "").toLowerCase();
  if (/(?:金价|黄金|白银|\bau\b|\bxau\b|\bgold\b|\bsilver\b)/i.test(text)) return "gold";
  // Order matters: oil before fx, because oil prompts often mention USD/美元.
  if (/(?:原油|油价|布伦特|\bwti\b|\bcrude\b|\boil\b)/i.test(text)) return "oil";
  if (/(?:汇率|美元|人民币|日元|欧元|英镑|\bfx\b|\busd\b|\bcny\b|\beur\b|\bgbp\b|\bjpy\b)/i.test(text)) return "fx";
  if (/(?:基金|净值|\betf\b|\blof\b|\bfof\b)/i.test(text)) return "fund";
  if (hasStockBasketIntent(query)) return "stock";
  if (/(?:指数|上证|深证|创业板|恒生|纳指|道指|标普|\bindex\b)/i.test(text)) return "index";
  return "stock";
}

export function hasStockBasketIntent(query: unknown): boolean {
  const text = String(query || "");
  return /(?:港股.{0,8}科技股?|科技股?.{0,8}港股|恒生科技(?!指数)|港股互联网|港股.{0,8}互联网|中概科技)/i.test(text)
    || /(?:美股|纳斯达克|纳指|七姐妹|七巨头|magnificent|mag7).{0,12}(?:科技股?|AI|人工智能|芯片|半导体|互联网|表现|行情|涨跌)?|(?:科技股?|AI|人工智能|芯片|半导体|互联网).{0,12}(?:美股|纳斯达克|纳指|七姐妹|七巨头|magnificent|mag7)/i.test(text)
    || /(?:A\s*股|a\s*股|A股|a股|沪深|科创|创业板).{0,12}(?:AI|人工智能|算力|服务器|光模块|CPO|高速连接|科技股?|半导体|芯片|新能源|电动车|锂电|光伏|机器人|人形机器人|券商|证券|白酒|消费|异动|表现|行情)|(?:AI|人工智能|算力|服务器|光模块|CPO|高速连接|科技股?|半导体|芯片|新能源|电动车|锂电|光伏|机器人|人形机器人|券商|证券|白酒|消费|异动|表现|行情).{0,12}(?:A\s*股|a\s*股|A股|a股|沪深|科创|创业板)/i.test(text);
}

export function hasConceptStockIntent(query: unknown): boolean {
  const text = String(query || "");
  if (hasStockBasketIntent(text)) return true;
  return /(?:概念股|概念板块|板块|行业|题材|赛道|龙头|成分股|产业链|科技股)/i.test(text)
    && /(?:今天|今日|当前|最新|表现|行情|涨跌|涨幅|跌幅|异动|看一下|怎么样|如何|盘中|收盘|报价|股票|股价|A\s*股|a\s*股|A股|a股|港股|美股|纳指|恒生)/i.test(text);
}

export function shouldPreferDynamicConceptResolution(query: unknown, explicitSymbol = ""): boolean {
  if (String(explicitSymbol || "").trim()) return false;
  const text = String(query || "");
  return /(?:概念股|概念板块|龙头|成分股|产业链|题材|赛道)/i.test(text)
    && !/(?:七姐妹|七巨头|mag7|magnificent|港股.{0,8}科技|恒生科技|纳指科技|美股.{0,8}科技|A股AI算力|a股AI算力)/i.test(text);
}

export function buildQuery(query: unknown, kind: MarketKind, market = "", symbol = ""): string {
  const raw = String(query || "").trim();
  const marketText = String(market || "").trim();
  const symbolText = String(symbol || "").trim();
  const suffix = [];
  if (symbolText) suffix.push(symbolText);
  if (marketText) suffix.push(marketText);

  if (kind === "gold") {
    suffix.push("国际金价 上海黄金交易所 腾讯自选股 新浪财经");
  } else if (kind === "index") {
    suffix.push("指数 行情 腾讯自选股 新浪财经 东方财富");
  } else if (kind === "fund") {
    suffix.push("基金 净值 天天基金 新浪财经");
  } else if (kind === "fx") {
    suffix.push("汇率 行情 新浪财经 Investing");
  } else if (kind === "oil") {
    suffix.push("原油 行情 新浪财经 Investing");
  } else {
    suffix.push("股票 行情 腾讯自选股 新浪财经 东方财富");
  }

  return [raw, ...suffix].filter(Boolean).join(" ");
}

export function keywordScore(kind: MarketKind, line: unknown): number {
  const text = String(line || "");
  let score = 0;
  if (/\d/.test(text)) score += 2;
  if (/涨|跌|涨跌|涨幅|跌幅|最新|现价|报价|收盘|开盘|美元|元\/克|盎司|点|%/.test(text)) score += 2;
  if (kind === "gold" && /(金价|黄金|白银|au|xau|伦敦金|沪金)/i.test(text)) score += 4;
  if (kind === "index" && /(指数|上证|深证|创业板|恒生|纳指|道指|标普)/i.test(text)) score += 4;
  if (kind === "fund" && /(基金|净值|估值|涨跌幅)/i.test(text)) score += 4;
  if (kind === "fx" && /(汇率|美元|人民币|日元|欧元|英镑|usd|cny|eur|gbp|jpy)/i.test(text)) score += 4;
  if (kind === "oil" && /(原油|布伦特|wti|油价)/i.test(text)) score += 4;
  if (kind === "stock" && /(股票|股价|港股|美股|a股|最新价|成交额|成交量)/i.test(text)) score += 4;
  return score;
}

export function normalizeLine(line: unknown): string {
  return String(line || "")
    .replace(/\s+/g, " ")
    .replace(/[|│┃]/g, " ")
    .trim();
}

export function toFiniteNumber(value: unknown): number | null {
  const n = Number(String(value ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

export function formatPrice(value: unknown, digits = 2): string {
  const n = toFiniteNumber(value);
  if (n == null || !Number.isFinite(n)) return "";
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(digits).replace(/\.?0+$/, "");
}

export function extractSection(text: unknown, startRe: RegExp, endReList: RegExp[] = []): string {
  const source = String(text || "");
  const startMatch = startRe.exec(source);
  if (!startMatch) return "";
  const start = startMatch.index + startMatch[0].length;
  const tail = source.slice(start);
  let end = tail.length;
  for (const re of endReList) {
    const match = re.exec(tail);
    if (match && match.index < end) end = match.index;
  }
  return tail.slice(0, end);
}

export function dedupeByName<T extends { name?: unknown }>(items: T[] = []): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = String(item?.name || "").trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function dedupeStrings(items: unknown[] = []): string[] {
  const seen = new Set<string>();
  return items
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .filter((item) => {
      if (seen.has(item)) return false;
      seen.add(item);
      return true;
    });
}

export function summarizeRange(items: NamedPrice[] = []): PriceRange | null {
  const priced = items
    .map((item) => ({ ...item, numericPrice: toFiniteNumber(item.price) }))
    .filter((item): item is NamedPrice & { numericPrice: number } => Number.isFinite(item.numericPrice));
  if (!priced.length) return null;
  const sorted = [...priced].sort((a, b) => a.numericPrice - b.numericPrice);
  return {
    min: sorted[0].numericPrice,
    minName: sorted[0].name,
    max: sorted[sorted.length - 1].numericPrice,
    maxName: sorted[sorted.length - 1].name,
  };
}

export function numberInRange(value: unknown, min: number, max: number): boolean {
  const n = toFiniteNumber(value);
  return n != null && Number.isFinite(n) && n >= min && n <= max;
}

export function normalizeDateToken(token = ""): string {
  const raw = String(token || "").trim();
  const match = raw.match(/(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (!match) return "";
  const [, year, month, day] = match;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

export function normalizeSgeName(raw = ""): string {
  const text = String(raw || "").toUpperCase();
  if (text.includes("100G")) return "Au100g";
  if (text.includes("9995")) return "Au9995";
  if (text.includes("9999")) return "Au9999";
  if (text.includes("99.99")) return "Au99.99";
  return "Au99.99";
}

export function hasGoldEvidence(signals: GoldSignals | null | undefined): boolean {
  return Boolean(
    signals?.sgeLines?.length
    || signals?.shuibeiLines?.length
    || signals?.internationalLines?.length
    || signals?.jewelry?.length
    || signals?.bars?.length
    || signals?.recovery?.length,
  );
}

export function hasPriorityGoldEvidence(signals: GoldSignals | null | undefined): boolean {
  return Boolean(
    signals?.sgeLines?.length
    || signals?.shuibeiLines?.length,
  );
}

export function countPriorityGoldEvidence(signals: GoldSignals | null | undefined): number {
  let count = 0;
  if (signals?.sgeLines?.length) count += 1;
  if (signals?.shuibeiLines?.length) count += 1;
  return count;
}

export function mergeGoldSignals(sources: MarketSource[] = []): GoldSignals {
  const merged: GoldSignals = {
    jewelry: [],
    jewelryRange: null,
    bars: [],
    barRange: null,
    recovery: [],
    goldRecovery: null,
    date: "",
    sgeLines: [],
    shuibeiLines: [],
    internationalLines: [],
  };

  for (const source of sources) {
    const signals = source?.goldSignals;
    if (!signals) continue;
    if (!merged.date && signals.date) merged.date = signals.date;
    merged.jewelry.push(...(signals.jewelry || []));
    merged.bars.push(...(signals.bars || []));
    merged.recovery.push(...(signals.recovery || []));
    merged.sgeLines.push(...(signals.sgeLines || []));
    merged.shuibeiLines.push(...(signals.shuibeiLines || []));
    merged.internationalLines.push(...(signals.internationalLines || []));
  }

  merged.jewelry = dedupeByName(merged.jewelry);
  merged.bars = dedupeByName(merged.bars);
  merged.recovery = dedupeByName(merged.recovery);
  merged.sgeLines = dedupeStrings(merged.sgeLines);
  merged.shuibeiLines = dedupeStrings(merged.shuibeiLines);
  merged.internationalLines = dedupeStrings(merged.internationalLines);
  merged.jewelryRange = summarizeRange(merged.jewelry);
  merged.barRange = summarizeRange(merged.bars);
  merged.goldRecovery = merged.recovery.find((item) => /黄金回收/.test(item.name)) || merged.recovery[0] || null;

  return merged;
}

export function extractGoldSignals(text: unknown): GoldSignals | null {
  const source = String(text || "");
  if (!source) return null;

  const date = normalizeDateToken(source.match(/\b20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}\b/)?.[0] || "");

  const jewelrySection = extractSection(
    source,
    /各品牌黄金首饰金店报价/,
    [/实物黄金定价依据/, /银行投资金条价格/, /今日黄金回收价格/],
  );
  const bankSection = extractSection(
    source,
    /银行投资金条价格/,
    [/今日黄金回收价格/, /实物黄金定价依据/],
  );
  const recoverySection = extractSection(
    source,
    /今日黄金回收价格/,
    [/实物黄金定价依据/, /登录\/注册/, /©/],
  );

  const jewelry = dedupeByName(Array.from(jewelrySection.matchAll(
    /([^\s/()]{1,20}(?:黄金|珠宝|凤祥|周生生|周六福|潮宏基|至尊))(?:\s+\([^)]+\))?\s+(\d+(?:\.\d+)?)\s+(?:\d+(?:\.\d+)?|-)\s+(?:\d+(?:\.\d+)?|-)\s+元\/克\s+(\d{4}-\d{2}-\d{2})/g,
  )).map((match) => ({
    name: match[1],
    price: match[2],
    date: match[3],
  })));

  const bars = dedupeByName(Array.from(bankSection.matchAll(
    /([^\s/()]{2,30}金条)(?:\s+\([^)]+\))?\s+(\d+(?:\.\d+)?)/g,
  )).map((match) => ({
    name: match[1],
    price: match[2],
  })));

  const recovery = dedupeByName(Array.from(recoverySection.matchAll(
    /([^\s/()]{2,24}回收)(?:\s+\([^)]+\))?\s+(\d+(?:\.\d+)?)\s+元\/克(?:\s+(\d{4}-\d{2}-\d{2}))?/g,
  )).map((match) => ({
    name: match[1],
    price: match[2],
    date: match[3] || "",
  })));

  const sgeLines = dedupeStrings([
    ...Array.from(source.matchAll(
      /(?:上海黄金交易所|上金所)[^\n]{0,40}?(Au?99\.99|Au?9999|Au100g|黄金9999|黄金9995)[^\n]{0,40}?(\d{3,5}(?:\.\d+)?)(?:\s*元\/克)?/gi,
    )).map((match) => {
      const price = match[2];
      if (!numberInRange(price, 300, 3000)) return "";
      return `上海黄金交易所 ${normalizeSgeName(match[1] || "")} ${formatPrice(price)} 元/克`;
    }),
    ...Array.from(source.matchAll(
      /(^|\n)\s*(Au?99\.99|Au?9999|Au100g|黄金9999|黄金9995)\s*[：: ]\s*(\d{3,5}(?:\.\d+)?)(?:\s*元\/克)?/gim,
    )).map((match) => {
      const price = match[3];
      if (!numberInRange(price, 300, 3000)) return "";
      return `上海黄金交易所 ${normalizeSgeName(match[2] || "")} ${formatPrice(price)} 元/克`;
    }),
  ]);

  const shuibeiLines = dedupeStrings([
    ...Array.from(source.matchAll(
      /(?:深圳)?水贝(?:黄金|金价|批发价)?[^\n]{0,30}?(?:(\d{3,5}(?:\.\d+)?)\s*[-~—至到]\s*(\d{3,5}(?:\.\d+)?)(?:\s*元\/克)?|(\d{3,5}(?:\.\d+)?)(?:\s*元\/克)?)/gi,
    )).map((match) => {
      const min = match[1];
      const max = match[2];
      const single = match[3];
      if (numberInRange(min, 300, 1600) && numberInRange(max, 300, 1600)) {
        return `深圳水贝黄金 ${formatPrice(min)}-${formatPrice(max)} 元/克`;
      }
      if (numberInRange(single, 300, 1600)) {
        return `深圳水贝黄金 ${formatPrice(single)} 元/克`;
      }
      return "";
    }),
    ...Array.from(source.matchAll(
      /(?:深圳)?水贝今日金价[\s\S]{0,260}?黄金[^\d]{0,20}(\d{3,5}(?:\.\d+)?)\s*元\/克/gi,
    )).map((match) => {
      const price = match[1];
      if (!numberInRange(price, 300, 1600)) return "";
      return `深圳水贝黄金 ${formatPrice(price)} 元/克`;
    }),
    ...Array.from(source.matchAll(
      /水贝金价网[\s\S]{0,260}?水贝[^\d]{0,20}(\d{3,5}(?:\.\d+)?)\s*元\/克/gi,
    )).map((match) => {
      const price = match[1];
      if (!numberInRange(price, 300, 1600)) return "";
      return `深圳水贝黄金 ${formatPrice(price)} 元/克`;
    }),
  ]);

  const internationalLines = dedupeStrings(Array.from(source.matchAll(
    /(?:XAU\/USD|国际现货黄金|现货黄金|伦敦金|COMEX黄金)[^\n]{0,40}?(\d{4}(?:\.\d+)?)(?:\s*(?:美元\/盎司|USD\/oz|usd\/oz|盎司))?/gi,
  )).map((match) => {
    const price = match[1];
    if (!numberInRange(price, 1000, 5000)) return "";
    return `国际现货黄金（XAU/USD） ${formatPrice(price)} 美元/盎司`;
  }));

  if (!jewelry.length && !bars.length && !recovery.length && !sgeLines.length && !shuibeiLines.length && !internationalLines.length) return null;

  const jewelryRange = summarizeRange(jewelry);
  const barRange = summarizeRange(bars);
  const goldRecovery = recovery.find((item) => /黄金回收/.test(item.name)) || recovery[0] || null;
  const dated = jewelry.find((item) => item.date)?.date
    || recovery.find((item) => item.date)?.date
    || date;

  return {
    jewelry,
    jewelryRange,
    bars,
    barRange,
    recovery,
    goldRecovery,
    date: dated,
    sgeLines,
    shuibeiLines,
    internationalLines,
  };
}

export function buildGoldSummary(sources: MarketSource[] = []): string {
  const signals = mergeGoldSignals(sources);
  if (!hasGoldEvidence(signals)) return "";

  const lines = [];
  const dateLine = signals.date ? `可核验到的黄金价格（${signals.date}）：` : "可核验到的黄金价格：";
  lines.push(dateLine);

  for (const line of signals.sgeLines.slice(0, 2)) {
    lines.push(`- ${line}`);
  }
  if (signals.shuibeiLines.length) {
    lines.push(`- ${signals.shuibeiLines[0]}`);
  }
  if (signals.internationalLines.length) {
    lines.push(`- ${signals.internationalLines[0]}`);
  }
  if (signals.jewelryRange) {
    lines.push(
      `- 品牌金店首饰金价：${formatPrice(signals.jewelryRange.min)}-${formatPrice(signals.jewelryRange.max)} 元/克（${signals.jewelryRange.minName} ~ ${signals.jewelryRange.maxName}）`,
    );
  }
  if (signals.barRange) {
    lines.push(
      `- 银行投资金条：${formatPrice(signals.barRange.min)}-${formatPrice(signals.barRange.max)} 元/克（${signals.barRange.minName} ~ ${signals.barRange.maxName}）`,
    );
  }
  if (signals.goldRecovery) {
    lines.push(`- 黄金回收：约 ${formatPrice(signals.goldRecovery.price)} 元/克`);
  }
  const examples = signals.jewelry.slice(0, 4).map((item) => `${item.name} ${formatPrice(item.price)}`);
  if (examples.length) {
    lines.push(`- 示例品牌：${examples.join("，")} 元/克`);
  }
  return lines.join("\n");
}
