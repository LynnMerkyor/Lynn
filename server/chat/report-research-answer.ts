import { extractWeatherLocation } from "../../lib/tools/realtime-info.js";

type ResearchAnswerKind =
  | ""
  | "stock"
  | "real_estate"
  | "market_weather_brief"
  | "weather"
  | "sports"
  | "market"
  | "news"
  | "generic"
  | (string & {});

interface ToolTextContent {
  text?: unknown;
  [key: string]: unknown;
}

interface DirectQuoteSnapshot {
  symbol?: unknown;
  close?: unknown;
  date?: unknown;
  time?: unknown;
  source?: unknown;
  url?: unknown;
  open?: unknown;
  high?: unknown;
  low?: unknown;
  [key: string]: unknown;
}

interface EvidenceSource {
  title?: unknown;
  source?: unknown;
  url?: unknown;
  [key: string]: unknown;
}

interface ToolResultDetails {
  directQuotes?: DirectQuoteSnapshot[];
  provider?: unknown;
  sources?: EvidenceSource[];
  location?: unknown;
  [key: string]: unknown;
}

interface ToolExecutionResult {
  content?: ToolTextContent[];
  details?: ToolResultDetails;
  [key: string]: unknown;
}

interface StooqItem {
  symbol: string;
  source: string;
  url: string;
  name: string;
  price: string;
  change: string;
  timestamp: string;
  range: string;
}

interface StockSnapshot {
  symbol?: unknown;
  price?: unknown;
  timestamp?: string;
  source?: unknown;
  url?: unknown;
  range?: string;
}

interface IndexFallbackTarget {
  label?: string;
  [key: string]: unknown;
}

interface IndexSnapshot {
  name?: string;
  level?: string;
  change?: string;
  source?: unknown;
  url?: unknown;
  queryDate: string;
}

interface WeatherForecastRow {
  date: string;
  desc: string;
  min: string;
  max: string;
}

interface WeatherSnapshot {
  location?: unknown;
  date: string;
  desc: string;
  tempRange: string;
}

interface EvidenceMeta {
  tool: string;
  basis: string;
  caveat: string;
}

interface EvidenceBlockOptions {
  kind?: ResearchAnswerKind;
  context?: unknown;
  userPrompt?: unknown;
}

type StructuredSectionEntry = readonly [string, unknown];
type StructuredFields = Record<string, string>;

interface TempRange {
  min: number | null;
  max: number | null;
}

interface GoldSummary {
  date: string;
  jewelry: string;
  bars: string;
  recovery: string;
  examples: string;
  sge: string;
  shuibei: string;
  international: string;
}

interface NewsItem {
  title: string;
  source: string;
  sourceUrl: string;
  link: string;
  snippet?: string;
  published: string;
  windowLabel: string;
  freshness: string;
}

interface BuildAnswerOptions {
  userPrompt?: unknown;
  prompt?: unknown;
  [key: string]: unknown;
}

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
function textOf(value: unknown): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}
function extractToolText(result: ToolExecutionResult | null | undefined): string {
  return (result?.content || [])
    .map((item) => item?.text || "")
    .filter(Boolean)
    .join("\n")
    .trim();
}
function parseStooqItems(context: unknown): StooqItem[] {
  const text = String(context || "");
  const starts = Array.from(text.matchAll(/(?:^|\n)(\d+\.\s+[A-Z0-9.]{1,12}\s+最近可用行情)/g)).map((match) => {
    const full = String(match[0] || "");
    const header = String(match[1] || "");
    const rawIndex = Number(match.index || 0);
    return full.startsWith("\n") ? rawIndex + 1 : rawIndex + full.indexOf(header);
  });
  const blocks = starts.map((start, index) => {
    const end = index + 1 < starts.length ? starts[index + 1] : text.length;
    return text.slice(start, end).trim();
  }).filter(Boolean);
  return blocks.map((block) => {
    const symbol = block.match(/^\d+\.\s+([A-Z0-9.]{1,12})\s+最近可用行情/m)?.[1] || "";
    const source = block.match(/^来源[:：]\s*([^\n]+)/m)?.[1] || "";
    const url = block.match(/^(https?:\/\/\S+)/m)?.[1] || "";
    const name = block.match(/^-+\s*名称[:：]\s*([^\n]+)/m)?.[1] || "";
    const price = block.match(/^-+\s*价格[:：]\s*([^\n]+)/m)?.[1] || "";
    const change = block.match(/^-+\s*涨跌\/涨跌幅[:：]\s*([^\n]+)/m)?.[1] || "";
    const timestamp = block.match(/^-+\s*时间戳[:：]\s*([^\n]+)/m)?.[1] || "";
    const range = block.match(/^-+\s*开盘\/最高\/最低[:：]\s*([^\n]+)/m)?.[1] || "";
    return { symbol, source, url, name, price, change, timestamp, range };
  }).filter((item) => item.symbol && item.price);
}
function extractRequestedUsTickers(text: unknown): string[] {
  const symbols: string[] = [];
  for (const match of String(text || "").matchAll(/\$?\b([A-Z]{1,5})(?:\.US)?\b/g)) {
    const raw = String(match[0] || "");
    const bare = String(match[1] || "").toUpperCase();
    if (MARKET_WEATHER_TICKER_STOPWORDS.has(bare)) continue;
    if (!raw.startsWith("$") && !COMMON_US_TICKERS.has(bare)) continue;
    if (!symbols.includes(bare)) symbols.push(bare);
  }
  return symbols.slice(0, 8);
}
function escapeRegExp(value: unknown): string {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function extractStructuredContextSection(context: unknown, title: string): string {
  const re = new RegExp(`【${escapeRegExp(title)}】\\n([\\s\\S]*?)(?=\\n【|$)`);
  return String(context || "").match(re)?.[1]?.trim() || "";
}
function parseStructuredFields(sectionText: unknown): StructuredFields {
  const fields: StructuredFields = {};
  for (const rawLine of String(sectionText || "").split(/\r?\n/)) {
    const line = textOf(rawLine);
    const match = line.match(/^-?\s*([^:：]+)[:：]\s*(.+)$/);
    if (match) fields[match[1].trim()] = match[2].trim();
  }
  return fields;
}
function buildStructuredSection(title: string, entries: readonly StructuredSectionEntry[]): string {
  const lines = entries
    .filter(([, value]) => textOf(value))
    .map(([label, value]) => `- ${label}: ${textOf(value)}`);
  if (!lines.length) return "";
  return [`【${title}】`, ...lines].join("\n");
}
function formatLocalDate(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
function formatLocalDateTime(date: Date = new Date()): string {
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${formatLocalDate(date)} ${hour}:${minute}`;
}
function uniqueCompact(items: unknown[], max: number = 3): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items.map(textOf).filter(Boolean)) {
    const clean = item
      .replace(/\s+/g, " ")
      .replace(/^\d+\.\s*/, "")
      .replace(/[，。；;,.]+$/g, "")
      .trim();
    if (!clean || /^(?:com|cn|net|org|www)$/i.test(clean) || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= max) break;
  }
  return out;
}
function extractEvidenceSources(context: unknown, max: number = 3): string[] {
  const text = String(context || "");
  const sources: unknown[] = [];
  for (const match of text.matchAll(/(?:来源|来源站点)[:：]\s*([^\n]+)/g)) {
    sources.push(match[1]);
  }
  for (const match of text.matchAll(/\[(Stooq|新浪财经|东方财富|上海黄金交易所|上金所|gold-api|Open-Meteo|wttr\.in|中国天气|中央气象台)[^\]]*\]/gi)) {
    sources.push(match[1]);
  }
  for (const match of text.matchAll(/\b(https?:\/\/[^\s)）]+)\b/g)) {
    try {
      sources.push(new URL(match[1]).hostname.replace(/^www\./, ""));
    } catch {
      // Ignore malformed snippets from search output.
    }
  }
  return uniqueCompact(sources, max);
}
function inferEvidenceMeta(kind: ResearchAnswerKind | undefined, prompt: string): EvidenceMeta {
  if (kind === "weather") {
    return {
      tool: "weather",
      basis: "天气工具返回的预报快照，按用户问法优先选择今天/明天/后天对应日期。",
      caveat: "天气预报会滚动变化，出门前建议再看本地天气 App 或雷达。",
    };
  }
  if (kind === "news") {
    return {
      tool: "live_news / web_search",
      basis: "按最近新闻候选、发布时间、来源链接和主题相关度筛选。",
      caveat: "正式引用前建议打开原文核验全文和发布时间。",
    };
  }
  if (kind === "market_weather_brief") {
    return {
      tool: "stock_market + weather",
      basis: "综合行情快照和天气预报快照生成行动建议。",
      caveat: "行情与天气都会实时波动，关键决策前请二次核验。",
    };
  }
  if (/金价|黄金|白银|金交所|金店|回收价|Au99\.99|Au9999|XAU|金条/i.test(prompt)) {
    return {
      tool: "stock_market",
      basis: "黄金/白银行情与品牌报价聚合结果，优先使用含明确数字的最近可用报价。",
      caveat: "门店、地区、工费和更新时间会造成差异，不构成投资或购买建议。",
    };
  }
  if (/原油|油价|布伦特|WTI|crude|oil/i.test(prompt)) {
    return {
      tool: "stock_market",
      basis: "原油行情工具返回的最近可用合约报价。",
      caveat: "期货/CFD 价格盘中波动明显，交易前请用行情终端核验。",
    };
  }
  if (kind === "market") {
    return {
      tool: "stock_market",
      basis: "行情工具返回的最近可用股价、指数或板块候选数据。",
      caveat: "行情展示不构成投资建议；交易级实时性请用券商或交易所源核验。",
    };
  }
  return {
    tool: "research_prefetch",
    basis: "系统预取资料中的可用证据。",
    caveat: "资料不足时应继续补充来源再下结论。",
  };
}
function appendEvidenceBlock(answer: unknown, { kind, context, userPrompt }: EvidenceBlockOptions = {}): string {
  const body = String(answer || "").trim();
  if (!body || /数据来源\/判断依据/.test(body)) return body;
  const prompt = textOf(userPrompt);
  if (/(?:一句话|一行|简短|简洁|直接回答|只回复|只回答)/.test(prompt)) return body;
  const meta = inferEvidenceMeta(kind, prompt);
  const sources = extractEvidenceSources(context);
  return [
    body,
    "",
    "数据来源/判断依据",
    `- 工具：${meta.tool}`,
    `- 时间：${formatLocalDateTime()}（本机时间）`,
    sources.length ? `- 来源：${sources.join("、")}` : "",
    `- 依据：${meta.basis}`,
    `- 注意：${meta.caveat}`,
  ].filter(Boolean).join("\n");
}
function parseStockSnapshot(result: ToolExecutionResult | null | undefined): StockSnapshot | null {
  const directQuote = result?.details?.directQuotes?.[0];
  if (directQuote?.symbol && directQuote?.close) {
    return {
      symbol: directQuote.symbol,
      price: directQuote.close,
      timestamp: [directQuote.date, directQuote.time].filter(Boolean).join(" "),
      source: directQuote.source || result?.details?.provider || "",
      url: directQuote.url || "",
      range: [directQuote.open, directQuote.high, directQuote.low].filter(Boolean).join(" / "),
    };
  }
  const item = parseStooqItems(extractToolText(result))[0];
  if (!item) return null;
  return {
    symbol: item.symbol,
    price: item.price,
    timestamp: item.timestamp,
    source: item.source,
    url: item.url,
    range: item.range,
  };
}
function parseIndexSnapshot(result: ToolExecutionResult | null | undefined, fallbackTarget: IndexFallbackTarget | null = null): IndexSnapshot | null {
  const sources = Array.isArray(result?.details?.sources) ? result.details.sources : [];
  for (const source of sources) {
    const title = textOf(source?.title);
    const match = title.match(/(上证指数|深证成指|创业板指|恒生指数|纳斯达克指数|纳斯达克|道琼斯指数|道琼斯|标普500)\s*([0-9][0-9,]*(?:\.\d+)?)\s*\(([+-]?\d+(?:\.\d+)?%)\)/);
    if (match) {
      return {
        name: match[1],
        level: match[2],
        change: match[3],
        source: source?.source || "",
        url: source?.url || "",
        queryDate: formatLocalDate(),
      };
    }
  }
  const text = extractToolText(result);
  const match = text.match(/(上证指数|深证成指|创业板指|恒生指数|纳斯达克指数|纳斯达克|道琼斯指数|道琼斯|标普500)\s*([0-9][0-9,]*(?:\.\d+)?)\s*\(([+-]?\d+(?:\.\d+)?%)\)/);
  if (match) {
    const source = sources[0] || {};
    return {
      name: match[1],
      level: match[2],
      change: match[3],
      source: source?.source || "",
      url: source?.url || "",
      queryDate: formatLocalDate(),
    };
  }
  if (!fallbackTarget && !sources.length) return null;
  const source = sources[0] || {};
  return {
    name: fallbackTarget?.label || "指数",
    level: "",
    change: "",
    source: source?.source || "",
    url: source?.url || "",
    queryDate: formatLocalDate(),
  };
}
function parseWeatherForecastRows(text: unknown): WeatherForecastRow[] {
  return Array.from(String(text || "").matchAll(/-\s*(\d{4}-\d{2}-\d{2}):\s*(.+?)\s+(-?\d+(?:\.\d+)?)~(-?\d+(?:\.\d+)?)\s*(?:°\s*C|°C|℃|C)/g)).map((match) => ({
    date: match[1],
    desc: textOf(match[2]),
    min: match[3],
    max: match[4],
  }));
}
function weekdayIndexFromPrompt(userPrompt: string = ""): number {
  const text = String(userPrompt || "");
  const patterns = [
    /周日|周天|星期日|星期天|礼拜日|礼拜天/,
    /周一|星期一|礼拜一/,
    /周二|星期二|礼拜二/,
    /周三|星期三|礼拜三/,
    /周四|星期四|礼拜四/,
    /周五|星期五|礼拜五/,
    /周六|星期六|礼拜六/,
  ];
  return patterns.findIndex((pattern) => pattern.test(text));
}
function localWeekdayOfDate(date: string): number {
  const parsed = new Date(`${date}T00:00:00+08:00`);
  const day = parsed.getDay();
  return Number.isFinite(day) ? day : -1;
}
function pickWeatherForecastRow(rows: WeatherForecastRow[] = [], userPrompt: string = ""): WeatherForecastRow | null {
  if (!rows.length) return null;
  if (/后天/.test(userPrompt) && rows[2]) return rows[2];
  if (/明天/.test(userPrompt) && rows[1]) return rows[1];
  const weekday = weekdayIndexFromPrompt(userPrompt);
  if (weekday >= 0) {
    const matched = rows.find((row) => localWeekdayOfDate(row.date) === weekday);
    if (matched) return matched;
  }
  return rows[0];
}
function parseWeatherSnapshot(result: ToolExecutionResult | null | undefined, userPrompt: string = "", locationHint: string = ""): WeatherSnapshot | null {
  const text = extractToolText(result);
  const rows = parseWeatherForecastRows(text);
  if (!rows.length && !locationHint) return null;
  const picked = pickWeatherForecastRow(rows, userPrompt);
  const rawLocation = text.match(/^([^\n]+?)\s+当前天气/m)?.[1]?.trim() || "";
  return {
    location: locationHint || rawLocation || result?.details?.location || "",
    date: picked?.date || "",
    desc: picked?.desc || "",
    tempRange: picked ? `${picked.min}~${picked.max} C` : "",
  };
}
function weatherLooksRainy(desc: unknown): boolean {
  return /rain|drizzle|shower|storm|雷|雨|阵雨|降水/i.test(String(desc || ""));
}
function parseTempRange(value: unknown): TempRange {
  const match = String(value || "").match(/(-?\d+)\s*~\s*(-?\d+)/);
  if (!match) return { min: null, max: null };
  return {
    min: Number(match[1]),
    max: Number(match[2]),
  };
}
function buildDirectMarketWeatherBriefAnswer(context: unknown): string {
  const stock = parseStructuredFields(extractStructuredContextSection(context, "美股快照"));
  const index = parseStructuredFields(extractStructuredContextSection(context, "指数快照"));
  const weather = parseStructuredFields(extractStructuredContextSection(context, "天气快照"));
  if (!Object.keys(stock).length && !Object.keys(index).length && !Object.keys(weather).length) return "";
  const dataLines: string[] = [];
  if (stock["标的"] && stock["最新价"]) {
    const stockBits = [
      `${stock["标的"]}：${stock["最新价"]}`,
      stock["时间戳"] ? `截至 ${stock["时间戳"]}` : "",
      stock["来源"] && stock["链接"] ? `来源：[${stock["来源"]}](${stock["链接"]})` : "",
      stock["开盘/最高/最低"] ? `开盘/最高/最低 ${stock["开盘/最高/最低"]}` : "",
    ].filter(Boolean);
    dataLines.push(`- ${stockBits.join("；")}`);
  } else {
    dataLines.push("- AAPL：未检索到明确的最近可用行情，建议继续核验。");
  }
  if (index["指数"]) {
    const indexBits = [
      index["最新点位"] ? `${index["指数"]}：${index["最新点位"]} 点` : `${index["指数"]}：未检索到明确点位`,
      index["涨跌幅"] ? `涨跌幅 ${index["涨跌幅"]}` : "",
      index["查询日期"] ? `查询日期 ${index["查询日期"]}` : "",
      index["来源"] && index["链接"] ? `来源：[${index["来源"]}](${index["链接"]})` : "",
    ].filter(Boolean);
    dataLines.push(`- ${indexBits.join("；")}`);
  } else {
    dataLines.push("- 上证指数：未检索到明确点位，建议继续核验。");
  }
  if (weather["地点"] || weather["日期"] || weather["天气"]) {
    const weatherBits = [
      [weather["地点"], weather["日期"]].filter(Boolean).join(" "),
      weather["天气"] || "",
      weather["温度"] ? `${weather["温度"]}` : "",
    ].filter(Boolean);
    dataLines.push(`- ${weatherBits.join("；")}`);
  } else {
    dataLines.push("- 上海天气：未检索到明确预报，建议出发前再看一次。");
  }
  const adviceLines: string[] = [];
  const rainy = weatherLooksRainy(weather["天气"]);
  if (weather["天气"]) {
    adviceLines.push(
      rainy
        ? "- 明早去浦东机场建议比平时多预留 20-30 分钟路上机动，带伞，优先选更稳定的出行方式。"
        : "- 明早去浦东机场可以按常规节奏出发，但仍建议预留 15-20 分钟机动时间。",
    );
    const { min, max } = parseTempRange(weather["温度"]);
    if (max !== null && Number.isFinite(max) && max <= 18) {
      adviceLines.push("- 着装建议：长袖打底加轻薄外套或防风层，怕冷的话再加一层更稳妥。");
    } else if (min !== null && Number.isFinite(min) && min < 18) {
      adviceLines.push("- 着装建议：薄长袖或短袖加一件轻薄外套，进出空调环境更舒服。");
    } else if (max !== null && Number.isFinite(max)) {
      adviceLines.push("- 着装建议：薄长袖或短袖都可以，包里备一件轻薄外套即可。");
    } else {
      adviceLines.push("- 着装建议：以上海早间通勤场景看，备一件轻薄外套会更稳。");
    }
    if (rainy) {
      adviceLines.push("- 如果下雨，鞋子尽量选防滑一点的，包里备纸巾或替换口罩。");
    }
  } else {
    adviceLines.push("- 天气预报没有拿到明确结果，去机场前建议再核验一次天气和路况。");
  }
  adviceLines.push("- AAPL 和上证指数这里只能视为最近可用行情/搜索快照，不构成投资建议。");
  return [
    "数据快照",
    ...dataLines,
    "",
    "行动建议",
    ...adviceLines,
  ].join("\n");
}
function buildDirectMarketAnswer(context: unknown, userPrompt: string = ""): string {
  const items = parseStooqItems(context);
  if (!items.length) return "";
  const seen = new Set(items.map((item) => item.symbol.toUpperCase()));
  const missing = extractRequestedUsTickers(userPrompt).filter((symbol) => !seen.has(symbol));
  const rows = items.map((item) => {
    return [
      `**${item.symbol}**`,
      item.name ? `- 名称：${item.name}` : "",
      `- 最新价：${item.price}`,
      item.change ? `- 涨跌/涨跌幅：${item.change}` : "",
      `- 时间戳：${item.timestamp}`,
      item.range ? `- 开盘/最高/最低：${item.range}` : "",
      `- 来源：[${item.source}](${item.url})`,
    ].filter(Boolean).join("\n");
  }).concat(missing.map((symbol) => [
    `**${symbol}**`,
    "- 未检索到明确的最近可用行情，建议继续用券商、交易所或 Stooq/Yahoo 等行情源核验。",
  ].join("\n"))).join("\n\n");
  return [
    "根据已获取的最近可用行情：",
    "",
    rows,
    "",
    "说明：这些是最近可用行情，不一定等同于盘中实时成交价；需要交易级实时性时，请再用券商、交易所或专门行情源交叉核验。",
    "",
    "以上信息仅作行情展示，不构成任何投资建议、买卖建议或收益承诺。",
  ].join("\n");
}
function buildDirectOilAnswer(context: unknown): string {
  const text = String(context || "");
  const rows = Array.from(text.matchAll(/-\s*(布伦特原油|纽约原油|WTI原油|原油[^：\n]*)[:：]\s*([0-9]+(?:\.[0-9]+)?)\s*美元\/桶(?:，涨跌幅\s*([+-]?\d+(?:\.\d+)?%))?(?:，涨跌\s*([+-]?\d+(?:\.\d+)?))?/g))
    .map((match) => ({
      name: match[1],
      price: match[2],
      pct: match[3] || "",
      change: match[4] || "",
    }));
  if (!rows.length) return "";
  return [
    "根据刚刚获取到的原油行情：",
    "",
    ...rows.map((item) => {
      const bits = [`${item.name}：${item.price} 美元/桶`];
      if (item.pct) bits.push(`涨跌幅 ${item.pct}`);
      if (item.change) bits.push(`涨跌 ${item.change}`);
      return `- ${bits.join("；")}`;
    }),
    "",
    "说明：这是最近可用行情快照，盘中价格会变动；交易或下单前请再用期货/券商行情终端核验。",
  ].join("\n");
}
function buildDirectWeatherAnswer(context: unknown, userPrompt: string = ""): string {
  const text = String(context || "");
  if (/未检索到明确天气数据|No concrete weather data was found/i.test(text)) {
    const location = extractWeatherLocation(userPrompt, "")
      || text.match(/没有拿到\s+(.+?)\s+的可用天气/)?.[1]?.trim()
      || "";
    const target = location || "目标地点";
    const errorLine = text.split(/\r?\n/).find((line) => /^错误[:：]/.test(line.trim())) || "";
    const errorText = errorLine ? `（${errorLine.replace(/^错误[:：]\s*/, "")}）` : "";
    if (/(?:一句话|一行|简短|简洁|直接回答|只回复|只回答)/.test(userPrompt)) {
      return `${target}天气源本轮超时，wttr.in 和 Open-Meteo 都没有返回可用数据${errorText}，我没有生成降雨判断。`;
    }
    return [
      `${target}天气源本轮超时，wttr.in 和 Open-Meteo 都没有返回可用数据${errorText}。`,
      "我不会把天气网站首页或导航菜单当成有效结果。",
      "我没有生成降雨判断；可以直接重试一次，或稍后用本地天气 App / 中国天气网核验。",
    ].join("\n");
  }
  const rows = parseWeatherForecastRows(text);
  if (!rows.length) return "";
  const picked = pickWeatherForecastRow(rows, userPrompt);
  if (!picked) return "";
  const location = extractWeatherLocation(userPrompt, "")
    || text.match(/\n\n([^\n]+?)\s+当前天气/)?.[1]?.trim()
    || text.match(/资料。\n\n([^\n]+?)\s+当前天气/)?.[1]?.trim()
    || "";
  const rainy = weatherLooksRainy(picked.desc);
  const desc = String(picked.desc || "")
    .replace(/Light rain shower/i, "小阵雨")
    .replace(/Moderate or heavy rain shower/i, "阵雨")
    .replace(/Rain shower/i, "阵雨")
    .replace(/Patchy rain nearby/i, "附近有零星小雨")
    .replace(/Partly Cloudy/i, "局部多云")
    .replace(/Sunny/i, "晴")
    .replace(/Cloudy/i, "多云")
    .replace(/Overcast/i, "阴")
    .replace(/Light rain/i, "小雨")
    .replace(/Moderate rain/i, "中雨")
    .replace(/Heavy rain/i, "大雨");
  const rainText = /下雨|降雨|降水/.test(userPrompt)
    ? `降雨判断：${rainy ? "有降雨可能" : "未显示明显降雨"}。`
    : "";
  if (/(?:一句话|一行|简短|简洁|直接回答|只回复|只回答)/.test(userPrompt)) {
    return `${[location, picked.date].filter(Boolean).join(" ")}天气：${desc}，${picked.min}-${picked.max}°C${rainText ? `，${rainy ? "有降雨可能" : "未显示明显降雨"}。` : "。"}`;
  }
  return [
    `${[location, picked.date].filter(Boolean).join(" ")}天气：${desc}，${picked.min}-${picked.max}°C。`,
    rainText,
    "说明：这是刚刚通过天气工具拿到的预报快照，出门前建议再看一次实时雷达或本地天气 App。",
  ].filter(Boolean).join("\n");
}
function parseGoldSummary(context: unknown): GoldSummary | null {
  const text = String(context || "");
  const date = text.match(/可核验到的黄金价格（(\d{4}-\d{2}-\d{2})）/)?.[1] || "";
  const lines = text.split(/\r?\n/).map((line) => textOf(line));
  const findLine = (re: RegExp): string => lines.find((line) => re.test(line)) || "";
  const jewelry = findLine(/品牌金店首饰金价/);
  const bars = findLine(/银行投资金条/);
  const recovery = findLine(/黄金回收/);
  const examples = findLine(/示例品牌/);
  const sge = findLine(/(?:上海黄金交易所|上金所).*\d{3,5}(?:\.\d+)?.*元\/克/);
  const sgeAlt = findLine(/(?:\bAu99\.99\b|\bAu9999\b).*\d{3,5}(?:\.\d+)?.*元\/克/);
  const shuibei = findLine(/水贝黄金|深圳水贝/);
  const international = findLine(/国际现货黄金|XAU\/USD|伦敦金/);
  if (!jewelry && !bars && !recovery && !sge && !sgeAlt && !shuibei && !international) return null;
  return {
    date,
    jewelry,
    bars,
    recovery,
    examples,
    sge: sge || sgeAlt,
    shuibei,
    international,
  };
}
function buildDirectGoldAnswer(context: unknown): string {
  const summary = parseGoldSummary(context);
  if (!summary) return "";
  return [
    summary.date ? `根据刚刚检索到的 ${summary.date} 黄金价格：` : "根据刚刚检索到的黄金价格：",
    "",
    summary.sge || "",
    summary.shuibei || "",
    summary.international || "",
    summary.jewelry || "",
    summary.bars || "",
    summary.recovery || "",
    summary.examples || "",
    "",
    "看投资基础价优先参考上金所；看深圳批发/工费前口径可参考水贝；买首饰重点看品牌金店；看回收就看回收价。",
    "说明：以上是刚检索到的网页报价汇总，不同品牌门店、工费和地区会有差异，不构成投资或购买建议。",
  ].filter(Boolean).join("\n");
}
function parseNewsRssItems(context: unknown): NewsItem[] {
  const items: NewsItem[] = [];
  const blocks = String(context || "").split(/\n(?=\d+\.\s+)/);
  for (const block of blocks) {
    const title = block.match(/^\d+\.\s+([^\n]+)/)?.[1]?.trim() || "";
    const source = block.match(/\n来源:\s*([^\n]+)/)?.[1]?.trim() || "";
    const sourceUrl = block.match(/\n来源站点:\s*(https?:\/\/\S+)/)?.[1]?.trim() || "";
    const windowLabel = block.match(/\n检索窗口:\s*([^\n]+)/)?.[1]?.trim() || "";
    const freshness = block.match(/\n新鲜度:\s*([^\n]+)/)?.[1]?.trim() || "";
    const link = block.match(/\n(https?:\/\/\S+)/)?.[1]?.trim() || "";
    const published = block.match(/\n发布时间:\s*([^\n]+)/)?.[1]?.trim() || "";
    if (title && (link || sourceUrl) && published) {
      items.push({ title, source, sourceUrl, link, published, windowLabel, freshness });
    }
  }
  return items;
}
function parseNewsSearchItems(context: unknown): NewsItem[] {
  const items: NewsItem[] = [];
  const seen = new Set<string>();
  const blocks = String(context || "").split(/\n(?=\d+\.\s+)/);
  for (const block of blocks) {
    const title = block.match(/^\d+\.\s+([^\n]+)/)?.[1]?.trim() || "";
    const source = block.match(/\n来源:\s*([^\n]+)/)?.[1]?.trim() || "";
    const sourceUrl = block.match(/\n来源站点:\s*(https?:\/\/\S+)/)?.[1]?.trim() || "";
    const windowLabel = block.match(/\n检索窗口:\s*([^\n]+)/)?.[1]?.trim() || "";
    const freshness = block.match(/\n新鲜度:\s*([^\n]+)/)?.[1]?.trim() || "";
    const explicitUrl = block.match(/\n\s*URL:\s*(https?:\/\/\S+)/i)?.[1]?.trim() || "";
    const firstUrl = block.match(/\n(https?:\/\/\S+)/)?.[1]?.trim() || "";
    const link = explicitUrl || sourceUrl || firstUrl;
    const snippet = block.match(/\n\s*-?\s*(?:摘要|正文摘录):\s*([^\n]+)/)?.[1]?.trim() || "";
    const published = block.match(/\n发布时间:\s*([^\n]+)/)?.[1]?.trim() || "";
    if (!title || !link) continue;
    const key = `${title}\n${link}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ title, source, sourceUrl, link, snippet, published, windowLabel, freshness });
  }
  return items;
}
function newsImportance(title: unknown): string {
  const text = String(title || "");
  if (/金融科技|券商|投顾|风控|交易|金融/.test(text)) {
    return "这说明 AI 正在从演示和概念进入金融业务流程，对投研、风控、客服和交易系统的投入优先级会继续上升。";
  }
  if (/AI PC|电脑|终端|芯片|半导体|算力|昇腾|GPU/.test(text)) {
    return "这关系到 AI 从云端模型走向本地终端和硬件生态，影响芯片、软件适配和个人设备升级节奏。";
  }
  if (/成立|新公司|认证|伙伴|通过|聆讯|上市|融资/.test(text)) {
    return "这代表 AI 相关业务继续公司化、资本化和生态化，说明产业链正在把模型能力转成具体产品与商业机会。";
  }
  if (/机器人|具身|自动驾驶/.test(text)) {
    return "这类进展关系到 AI 从文本和软件扩展到真实物理场景，是具身智能和自动化落地的重要观察点。";
  }
  if (/干细胞|细胞治疗|再生医学|临床|医疗|医药|药企|医院/.test(text)) {
    return "这关系到医疗研发、临床转化和产业监管节奏，建议重点核验原文时间、研究阶段和是否已有正式公告。";
  }
  return "这条信息与用户关注主题相关，建议重点核验原文时间、出处和是否有后续权威报道。";
}
function scoreNewsItem(item: NewsItem): number {
  const text = `${item.title} ${item.source} ${item.snippet || ""}`;
  let score = 0;
  if (/AI|人工智能|大模型|科技/i.test(text)) score += 2;
  if (/金融科技|券商|AI PC|芯片|半导体|机器人|成立|认证|聆讯|上市|融资|人才|薪酬|重塑|增长/.test(text)) score += 3;
  if (/干细胞|细胞治疗|再生医学|临床|医疗|医药|药企|医院|备案|监管|产业|大会/.test(text)) score += 4;
  if (/新浪|中证|中国科技|东方财富|同花顺|澎湃|DoNews|36氪|证券/.test(text)) score += 1;
  if (/直播|挑战|艺术|漫剧|培训|结课/.test(text)) score -= 2;
  return score;
}
function buildDirectNewsAnswer(context: unknown): string {
  const rssItems = parseNewsRssItems(context);
  const searchItems = parseNewsSearchItems(context);
  const merged = [...rssItems, ...searchItems]
    .filter((item, index, arr) => arr.findIndex((other) => other.title === item.title && other.link === item.link) === index);
  const picked = merged
    .sort((a, b) => scoreNewsItem(b) - scoreNewsItem(a))
    .slice(0, 8);
  if (picked.length < 1) return "";
  const isTodayEvidence = (item: NewsItem): boolean => {
    if (item.published && /今日|36/.test(item.windowLabel || "")) return true;
    const ts = Date.parse(item.published || "");
    return Number.isFinite(ts) && Date.now() - ts <= 36 * 60 * 60 * 1000;
  };
  const formatItem = (item: NewsItem, index: number): string => {
    const snippet = item.snippet ? `${String(item.snippet).replace(/\s+/g, " ").trim().slice(0, 220)}${String(item.snippet).length > 220 ? "..." : ""}` : "";
    return [
      `**${index + 1}. ${item.title}**`,
      item.published ? `- 发生/发布时间：${item.published}` : "",
      item.windowLabel ? `- 检索窗口：${item.windowLabel}` : "",
      item.freshness ? `- 新鲜度：${item.freshness}` : "",
      `- 来源：${item.source || item.sourceUrl || "搜索结果"}`,
      `- 链接：${item.link || item.sourceUrl}`,
      snippet ? `- 摘要：${snippet}` : "",
      `- 为什么重要：${newsImportance(item.title)}`,
    ].filter(Boolean).join("\n");
  };
  const todayItems = picked.filter(isTodayEvidence).slice(0, 5);
  const recentItems = picked.filter((item) => !isTodayEvidence(item)).slice(0, 5);
  const sections: string[] = [];
  if (todayItems.length) {
    sections.push([
      "## 今日可核验",
      todayItems.map(formatItem).join("\n\n"),
    ].join("\n\n"));
  }
  if (recentItems.length) {
    sections.push([
      todayItems.length ? "## 近7日相关 / 搜索候选" : "## 搜索候选（需打开原文核验日期）",
      recentItems.map(formatItem).join("\n\n"),
    ].join("\n\n"));
  }
  const expanded = recentItems.length > 0 && todayItems.length < 3;
  return [
    expanded
      ? "今天可核验新闻较少，我已自动扩展到最近 7 天，并按新鲜度分组："
      : "以下是刚刚检索到的最新相关新闻：",
    "",
    sections.join("\n\n"),
    "",
    "说明：我按检索窗口区分“今日”和“近7日”，不把旧结果冒充今日新闻；正式引用前建议继续打开原站核验全文。",
  ].join("\n");
}
export function buildDirectResearchAnswer(kind: ResearchAnswerKind, context: unknown, userPrompt: unknown = ""): string {
  if (!context) return "";
  const prompt = textOf(userPrompt);
  let answer = "";
  if (kind === "market_weather_brief") {
    answer = buildDirectMarketWeatherBriefAnswer(context);
    return appendEvidenceBlock(answer, { kind, context, userPrompt: prompt });
  }
  if (kind === "market") {
    if (/金价|黄金|白银|金交所|金店|回收价|Au99\.99|Au9999|XAU|金条/i.test(prompt)) {
      answer = buildDirectGoldAnswer(context);
      return appendEvidenceBlock(answer, { kind, context, userPrompt: prompt });
    }
    if (/原油|油价|布伦特|WTI|crude|oil/i.test(prompt)) {
      answer = buildDirectOilAnswer(context);
      return appendEvidenceBlock(answer, { kind, context, userPrompt: prompt });
    }
    if (/AAPL|TSLA|股票|股价|行情|报价|最新价|最近可用|概念股|概念板块|板块|题材|赛道|成分股|科技股|表现/i.test(prompt)) {
      answer = buildDirectMarketAnswer(context, prompt);
      return appendEvidenceBlock(answer, { kind, context, userPrompt: prompt });
    }
  }
  if (kind === "weather") {
    answer = buildDirectWeatherAnswer(context, prompt);
    return appendEvidenceBlock(answer, { kind, context, userPrompt: prompt });
  }
  if (kind === "news" && /新闻|消息|今日|今天|最新/.test(prompt)) {
    answer = buildDirectNewsAnswer(context);
    return appendEvidenceBlock(answer, { kind, context, userPrompt: prompt });
  }
  return "";
}
export { appendEvidenceBlock, buildDirectGoldAnswer, buildDirectMarketAnswer, buildDirectMarketWeatherBriefAnswer, buildDirectNewsAnswer, buildDirectOilAnswer, buildDirectWeatherAnswer, buildStructuredSection, extractToolText, parseGoldSummary, parseIndexSnapshot, parseNewsRssItems, parseNewsSearchItems, parseStooqItems, parseStockSnapshot, parseWeatherForecastRows, parseWeatherSnapshot };
export function buildAnswer(kind: ResearchAnswerKind, rawResults: unknown, opts: BuildAnswerOptions = {}): string {
  return buildDirectResearchAnswer(kind, rawResults, opts.userPrompt || opts.prompt || "");
}
