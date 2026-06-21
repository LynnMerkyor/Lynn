/**
 * stock-market.js — 轻量财经/行情工具
 *
 * 目标：不给用户额外增加 key 配置压力，优先复用 Lynn 现有搜索/抓取链路，
 * 为金价、股价、指数、基金、汇率、原油等常见场景提供结构化可读结果。
 */

import { Type } from "@sinclair/typebox";
import { t } from "../../server/i18n.js";
import { runSearchQuery, type SearchResultItem } from "./web-search.js";
import { fetchWebContent } from "./web-fetch.js";
import type {
  ConceptQuotes,
  ConceptResolution,
  LooseRecord,
  MarketCollection,
  MarketKind,
  MarketQuote,
  MarketSource,
  StockMarketToolParams,
  ToolTextResult,
} from "./stock-market-types.js";

import {
  A_STOCK_BASKETS,
  A_STOCK_NAME_TO_SYMBOL,
  DEFAULT_FETCH_COUNT,
  FINANCE_LOOKUP_CONTEXT_RE,
  GOLD_FETCH_COUNT,
  HK_STOCK_NAME_TO_SYMBOL,
  HK_TECH_BASKET_SYMBOLS,
  KNOWN_US_STOCK_SYMBOLS,
  MAX_FETCH_LENGTH,
  MAX_LINES_PER_SOURCE,
  NOISY_FINANCE_SOURCE_NAMES,
  NON_FINANCE_QUOTE_CONTEXT_RE,
  SLOW_OR_LOW_VALUE_CONCEPT_HOST_RE,
  STOOQ_TIMEOUT_MS,
  TICKER_STOPWORDS,
  US_STOCK_NAME_TO_SYMBOL,
  US_TECH_BASKET_SYMBOLS,
  buildGoldSummary,
  buildQuery,
  countPriorityGoldEvidence,
  detectKind,
  errorMessage,
  extractGoldSignals,
  formatPrice,
  hasConceptStockIntent,
  hasGoldEvidence,
  hasStockBasketIntent,
  isZhLocale,
  keywordScore,
  mergeGoldSignals,
  normalizeDateToken,
  normalizeLine,
  shouldPreferDynamicConceptResolution,
  toFiniteNumber,
} from "./stock-market-core.js";
import {
  collectAStockQuotes,
  collectOilDirectQuotes,
  collectStooqQuotes,
  extractHongKongStockSymbols,
  fetchTextWithTimeout,
  fetchUsStockQuote,
  fetchTencentAStockQuote,
  hasFinanceLookupIntent,
  timeoutSignal,
} from "./stock-market-quotes.js";


async function fetchJsonWithTimeout(url: string, ms: number, headers: Record<string, string> = {}): Promise<LooseRecord> {
  const timer = timeoutSignal(ms);
  try {
    const resp = await fetch(url, {
      signal: timer.signal,
      headers: { "User-Agent": "Lynn/MarketQuote", ...headers },
    });
    if (!resp.ok) throw new Error(`${url} ${resp.status}`);
    return await resp.json() as LooseRecord;
  } finally {
    timer.clear();
  }
}

async function fetchUsdCnyRate(): Promise<{ rate: number; updatedAt: string; source: string }> {
  const fx = await fetchFxRate("USD", "CNY");
  return {
    rate: fx.rate,
    updatedAt: fx.updatedAt,
    source: fx.source,
  };
}

async function fetchFxRate(base = "USD", quote = "CNY"): Promise<{ base: string; quote: string; rate: number; updatedAt: string; source: string }> {
  const normalizedBase = String(base || "USD").trim().toUpperCase();
  const normalizedQuote = String(quote || "CNY").trim().toUpperCase();
  const json = await fetchJsonWithTimeout(`https://open.er-api.com/v6/latest/${encodeURIComponent(normalizedBase)}`, 4500);
  const rate = Number(json?.rates?.[normalizedQuote]);
  if (!Number.isFinite(rate)) throw new Error("USD/CNY unavailable");
  return {
    base: normalizedBase,
    quote: normalizedQuote,
    rate,
    updatedAt: json.time_last_update_utc || "",
    source: "open.er-api.com",
  };
}

function inferFxPair(query: unknown): { base: string; quote: string } {
  const text = String(query || "").toLowerCase();
  const hasCny = /人民币|cny|rmb/.test(text);
  const pairs: Array<[RegExp, string]> = [
    [/(美元|美金|\busd\b)/i, "USD"],
    [/(欧元|\beur\b)/i, "EUR"],
    [/(英镑|\bgbp\b)/i, "GBP"],
    [/(日元|\bjpy\b)/i, "JPY"],
    [/(港币|港元|\bhkd\b)/i, "HKD"],
  ];
  const found = pairs.filter(([re]) => re.test(text)).map(([, code]) => code);
  if (found.length >= 2) return { base: found[0], quote: found[1] };
  if (found.length === 1 && hasCny && found[0] !== "CNY") return { base: found[0], quote: "CNY" };
  return { base: "USD", quote: "CNY" };
}

async function fetchFxMarketSource(query: unknown): Promise<MarketSource | null> {
  const { base, quote } = inferFxPair(query);
  const fx = await fetchFxRate(base, quote);
  const inverse = fx.rate ? 1 / fx.rate : null;
  const lines = [
    `${fx.base}/${fx.quote}：1 ${fx.base} = ${formatPrice(fx.rate, 4)} ${fx.quote}`,
    inverse != null && Number.isFinite(inverse)
      ? `${fx.quote}/${fx.base}：1 ${fx.quote} = ${formatPrice(inverse, 6)} ${fx.base}`
      : "",
    fx.updatedAt ? `更新时间：${fx.updatedAt}` : "",
  ].filter(Boolean);
  return {
    title: `${fx.base}/${fx.quote} 汇率`,
    url: `https://open.er-api.com/v6/latest/${encodeURIComponent(fx.base)}`,
    snippet: lines.join("；"),
    lines,
    goldSignals: null,
    source: fx.source,
    host: "open.er-api.com",
    timestamp: fx.updatedAt,
  };
}

async function fetchGoldApiMarketSource(): Promise<MarketSource | null> {
  const [gold, silver, fx] = await Promise.all([
    fetchJsonWithTimeout("https://api.gold-api.com/price/XAU", 4500),
    fetchJsonWithTimeout("https://api.gold-api.com/price/XAG", 4500).catch(() => null),
    fetchUsdCnyRate(),
  ]);
  const goldUsdOz = Number(gold?.price);
  if (!Number.isFinite(goldUsdOz)) return null;
  const goldCnyGram = goldUsdOz * fx.rate / 31.1034768;
  const lines = [
    `国际现货黄金（XAU/USD） ${formatPrice(goldCnyGram)} 元/克（约 ${formatPrice(goldUsdOz)} 美元/盎司，USD/CNY ${fx.rate.toFixed(4)}）`,
    gold?.updatedAt ? `更新时间：${gold.updatedAt}` : "",
  ].filter(Boolean);
  if (silver?.price) {
    const silverCnyGram = Number(silver.price) * fx.rate / 31.1034768;
    if (Number.isFinite(silverCnyGram)) {
      lines.push(`国际现货白银（XAG/USD） ${formatPrice(silverCnyGram)} 元/克（约 ${formatPrice(silver.price)} 美元/盎司）`);
    }
  }
  return {
    title: "Gold API 实时贵金属报价",
    url: "https://api.gold-api.com/price/XAU",
    snippet: lines.join("；"),
    lines,
    goldSignals: {
      jewelry: [],
      jewelryRange: null,
      bars: [],
      barRange: null,
      recovery: [],
      goldRecovery: null,
      date: normalizeDateToken(gold?.updatedAt || "") || normalizeDateToken(new Date().toISOString()),
      sgeLines: [],
      shuibeiLines: [],
      internationalLines: [lines[0]],
    },
    source: "gold-api.com",
    host: "api.gold-api.com",
  };
}

function shouldReturnGoldApiImmediately(query: unknown): boolean {
  return !/(?:水贝|深圳|品牌|金店|周大福|周生生|老凤祥|老庙|中国黄金|回收|金条|投资金条|上金所|上海黄金交易所|Au99\.99|Au9999|首饰|饰金|批发|工费)/i
    .test(String(query || ""));
}

function buildGoldQueries(query: unknown, market = "", symbol = ""): string[] {
  const raw = String(query || "").trim();
  return [...new Set([
    buildQuery(query, "gold", market, symbol),
    `${raw} 上海黄金交易所 Au99.99 Au9999 今日行情`,
    `${raw} 深圳水贝黄金 今日价格 批发价`,
    `${raw} XAU/USD 国际现货黄金 今日价格`,
  ].filter(Boolean))];
}

function inferConceptMarketHint(query: unknown): string {
  const text = String(query || "");
  if (/(?:港股|恒生|恒指|港交所|HK\b|\.HK\b|中概港股)/i.test(text)) return "hk";
  if (/(?:美股|纳斯达克|纳指|纽交所|七姐妹|七巨头|magnificent|mag7|nasdaq|nyse|\bUS\b)/i.test(text)) return "us";
  return "a";
}

function buildConceptSearchQueries(query: unknown, marketHint: string): string[] {
  const raw = String(query || "").replace(/\s+/g, " ").trim();
  if (marketHint === "hk") {
    return [
      `${raw} 港股 概念股 龙头 股票代码`,
      `${raw} 恒生科技 成分股 股票代码`,
    ];
  }
  if (marketHint === "us") {
    return [
      `${raw} 美股 概念股 ticker stocks`,
      `${raw} US stocks tickers`,
    ];
  }
  return [
    `${raw} 概念股 龙头 股票代码 A股`,
    `${raw} 同花顺 概念股 东方财富 股票代码`,
  ];
}

function hasTickerAnchorNear(source: unknown, index = 0): boolean {
  const text = String(source || "");
  const start = Math.max(0, Number(index || 0) - 36);
  const end = Math.min(text.length, Number(index || 0) + 48);
  return /(?:ticker|symbol|stock|stocks|share|NASDAQ|NYSE|Nasdaq|Nyse|纳斯达克|纽交所|股票代码|证券代码|代码)/i
    .test(text.slice(start, end));
}

function hasExplicitAStockCodeNearName(source: unknown, name: string, symbol: string): boolean {
  const idx = String(source || "").indexOf(name);
  if (idx < 0) return false;
  const start = Math.max(0, idx - 24);
  const end = Math.min(String(source || "").length, idx + name.length + 36);
  const window = String(source || "").slice(start, end);
  return new RegExp(`(?:${symbol}|(?:SH|SZ|BJ)[:：]?${symbol}|${symbol}\\.(?:SH|SZ|BJ))`, "i").test(window);
}

function hasConceptListAnchorNear(source: unknown, index = 0): boolean {
  const text = String(source || "");
  const start = Math.max(0, Number(index || 0) - 42);
  const end = Math.min(text.length, Number(index || 0) + 64);
  return /(?:包括|名单|龙头|成分股|概念股|相关股|标的|股票代码|证券代码|代码|涨跌幅|行情|入选|受益|题材)/i
    .test(text.slice(start, end));
}

function extractConceptSymbolsFromText(
  text: unknown,
  marketHint: string,
  opts: { query?: unknown } = {},
): string[] {
  const source = String(text || "");
  const query = String(opts.query || "");
  const symbols: string[] = [];
  const add = (value: unknown): void => {
    const normalized = String(value || "").trim().toUpperCase().replace(/^(?:SH|SZ|BJ|HK)[:：]?/i, "");
    if (!normalized || symbols.includes(normalized)) return;
    symbols.push(normalized);
  };

  if (marketHint === "hk") {
    for (const match of source.matchAll(/\b(?:HK[:：]?)?(0\d{4})(?:\.HK)?\b/gi)) add(match[1]);
    for (const [name, symbol] of HK_STOCK_NAME_TO_SYMBOL) {
      if (source.includes(name)) add(symbol);
    }
    return symbols.slice(0, 8);
  }

  if (marketHint === "us") {
    for (const [name, symbol] of US_STOCK_NAME_TO_SYMBOL) {
      if (source.toLowerCase().includes(name.toLowerCase())) add(symbol);
    }
    for (const match of source.matchAll(/\$?\b([A-Z]{1,5})(?:\.[A-Z]{1,3})?\b/g)) {
      const raw = String(match[0] || "");
      const bare = String(match[1] || "").toUpperCase();
      if (TICKER_STOPWORDS.has(bare)) continue;
      if (KNOWN_US_STOCK_SYMBOLS.has(bare) || raw.startsWith("$") || hasTickerAnchorNear(source, match.index)) {
        add(bare);
      }
    }
    return symbols.slice(0, 8);
  }

  for (const [name, symbol] of A_STOCK_NAME_TO_SYMBOL) {
    let index = source.indexOf(name);
    while (index >= 0) {
      const queryMentionsName = query.includes(name);
      const hasCodeNearName = hasExplicitAStockCodeNearName(source, name, symbol);
      const noisySourceBrand = NOISY_FINANCE_SOURCE_NAMES.has(name) && !queryMentionsName && !hasCodeNearName;
      if (!noisySourceBrand && (queryMentionsName || hasCodeNearName || hasConceptListAnchorNear(source, index))) {
        add(symbol);
        break;
      }
      index = source.indexOf(name, index + name.length);
    }
  }
  for (const match of source.matchAll(/\b([0368]\d{5})\b/g)) add(match[1]);
  return symbols.slice(0, 8);
}

function shouldFetchConceptUrl(url: unknown): boolean {
  try {
    const host = new URL(String(url || "")).hostname.replace(/^www\./i, "");
    return !!host && !SLOW_OR_LOW_VALUE_CONCEPT_HOST_RE.test(host);
  } catch {
    return false;
  }
}

async function resolveConceptStockSymbols(query: unknown): Promise<ConceptResolution> {
  if (!hasConceptStockIntent(query)) return { marketHint: "", symbols: [], sources: [] };
  const marketHint = inferConceptMarketHint(query);
  const symbols: string[] = [];
  const sources: MarketSource[] = [];
  const addSymbol = (value: unknown): void => {
    const symbol = String(value || "").trim().toUpperCase();
    if (symbol && !symbols.includes(symbol)) symbols.push(symbol);
  };

  searchLoop:
  for (const searchQuery of buildConceptSearchQueries(query, marketHint)) {
    let result;
    try {
      result = await runSearchQuery(searchQuery, 5, { sceneHint: "finance" });
    } catch {
      continue;
    }
    const items = (result?.results || []).slice(0, 4);
    for (const item of items) {
      const titleSnippetText = [item?.title, item?.snippet].filter(Boolean).join(" ");
      for (const symbol of extractConceptSymbolsFromText(titleSnippetText, marketHint, { query })) addSymbol(symbol);
      if (symbols.length >= 8) {
        if (item?.title || item?.snippet || item?.url) {
          sources.push({
            title: item.title || searchQuery,
            url: item.url || "",
            snippet: item.snippet || "",
            lines: extractCandidateLines(item.snippet || item.title || "", "stock").slice(0, 3),
            goldSignals: null,
            source: item.url ? sourceLabel(item.url) : "概念解析",
            host: (() => {
              try { return item.url ? new URL(item.url).hostname : ""; } catch { return ""; }
            })(),
          });
        }
        break searchLoop;
      }
    }

    const enriched = await Promise.allSettled(items.map(async (item) => {
      let fetchedText = "";
      if (item?.url && shouldFetchConceptUrl(item.url)) {
        try {
          const fetched = await fetchWebContent(item.url, MAX_FETCH_LENGTH);
          fetchedText = fetched?.text || "";
        } catch {
          // Snippets are still useful when the source blocks fetching.
        }
      }
      return { item, fetchedText };
    }));

    for (const settled of enriched) {
      if (settled.status !== "fulfilled") continue;
      const { item, fetchedText } = settled.value || {};
      const combined = [item?.title, item?.snippet, fetchedText].filter(Boolean).join(" ");
      for (const symbol of extractConceptSymbolsFromText(combined, marketHint, { query })) addSymbol(symbol);
      if (item?.title || item?.snippet || item?.url) {
        sources.push({
          title: item.title || searchQuery,
          url: item.url || "",
          snippet: item.snippet || "",
          lines: extractCandidateLines(fetchedText || item.snippet || item.title || "", "stock").slice(0, 3),
          goldSignals: null,
          source: item.url ? sourceLabel(item.url) : "概念解析",
          host: (() => {
            try { return item.url ? new URL(item.url).hostname : ""; } catch { return ""; }
          })(),
        });
      }
      if (symbols.length >= 8) break;
    }
    if (symbols.length >= 3) break;
  }

  return { marketHint, symbols: symbols.slice(0, 8), sources: sources.slice(0, 3) };
}

async function collectConceptStockQuotes(query: unknown): Promise<ConceptQuotes> {
  const resolved = await resolveConceptStockSymbols(query);
  if (!resolved.symbols.length) return { directQuotes: [], sources: [], marketHint: resolved.marketHint };

  const fetcher = resolved.marketHint === "hk"
    ? fetchSinaHongKongQuote
    : resolved.marketHint === "us"
      ? fetchUsStockQuote
      : fetchTencentAStockQuote;
  const settled = await Promise.allSettled(resolved.symbols.map((symbol) => fetcher(symbol)));
  return {
    marketHint: resolved.marketHint,
    sources: resolved.sources,
    directQuotes: settled
      .map((item) => item.status === "fulfilled" ? item.value : null)
      .filter((item): item is MarketQuote => Boolean(item)),
  };
}

function parseSinaHongKongQuote(raw: unknown, requestedSymbol: string): MarketQuote | null {
  const match = String(raw || "").match(/=\"([^\"]*)\"/);
  const fields = match?.[1]?.split(",") || [];
  if (fields.length < 18) return null;
  const price = fields[6];
  if (!Number.isFinite(Number(price))) return null;
  const symbol = String(requestedSymbol || "").padStart(5, "0");
  const amount = fields[11] || "";
  const volume = fields[12] || "";
  return {
    symbol: `${symbol}.HK`,
    name: fields[1] || fields[0] || `${symbol}.HK`,
    date: fields[17] || "",
    time: fields[18] || "",
    open: fields[3] || "",
    high: fields[4] || "",
    low: fields[5] || "",
    close: price,
    previousClose: fields[2] || "",
    change: fields[7] || "",
    pct: fields[8] ? `${fields[8]}%` : "",
    amount,
    volume,
    source: "新浪财经",
    url: `https://finance.sina.com.cn/stock/hkstock/quotes/${symbol}.html`,
    currency: "HKD",
  };
}

async function fetchSinaHongKongQuote(symbol: string): Promise<MarketQuote | null> {
  const normalized = String(symbol || "").trim().padStart(5, "0");
  if (!/^\d{5}$/.test(normalized)) return null;
  const raw = await fetchTextWithTimeout(`https://hq.sinajs.cn/list=rt_hk${normalized}`, 4500, {
    Referer: "https://finance.sina.com.cn",
    "User-Agent": "Mozilla/5.0 Lynn/MarketQuote",
  }, "gbk");
  return parseSinaHongKongQuote(raw, normalized);
}

async function collectHongKongQuotes(query: unknown, explicitSymbol = ""): Promise<MarketQuote[]> {
  const symbols = extractHongKongStockSymbols(query, explicitSymbol);
  if (!symbols.length) return [];
  const settled = await Promise.allSettled(symbols.map((symbol) => fetchSinaHongKongQuote(symbol)));
  return settled
    .map((item) => item.status === "fulfilled" ? item.value : null)
    .filter((item): item is MarketQuote => Boolean(item));
}

function extractCandidateLines(text: unknown, kind: MarketKind): string[] {
  const seen = new Set<string>();
  const lines = String(text || "")
    .split(/\r?\n/)
    .map(normalizeLine)
    .filter(Boolean)
    .filter((line) => line.length <= 220)
    .map((line) => ({ line, score: keywordScore(kind, line) }))
    .filter((item) => item.score >= 4)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.line)
    .filter((line) => {
      if (seen.has(line)) return false;
      seen.add(line);
      return true;
    });
  return lines.slice(0, MAX_LINES_PER_SOURCE);
}

function sourceLabel(url: unknown): string {
  try {
    const host = new URL(String(url || "")).hostname.replace(/^www\./i, "");
    if (host.includes("finance.sina.com.cn") || host.includes("sina.com.cn")) return "新浪财经";
    if (host.includes("qq.com")) return "腾讯";
    if (host.includes("xueqiu.com")) return "雪球";
    if (host.includes("eastmoney.com")) return "东方财富";
    if (host.includes("10jqka.com.cn")) return "同花顺";
    if (host.includes("akshare")) return "AkShare";
    if (host.includes("jrj.com.cn")) return "金融界";
    if (host.includes("cs.com.cn")) return "中证网";
    return host;
  } catch {
    return "";
  }
}

function isSearchEngineResultUrl(rawUrl: unknown): boolean {
  try {
    const parsed = new URL(String(rawUrl || ""));
    const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    const path = parsed.pathname.toLowerCase();
    if (host.endsWith("baidu.com") && path === "/s") return true;
    if (host.endsWith("bing.com") && path === "/search") return true;
    if (host.endsWith("google.com") && path === "/search") return true;
    if (host.endsWith("duckduckgo.com") && (path === "/" || path === "/html/" || path === "/html")) return true;
  } catch {
    return false;
  }
  return false;
}

function shouldHideMarketSourceUrl(rawUrl: unknown): boolean {
  try {
    const parsed = new URL(String(rawUrl || ""));
    const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    const path = parsed.pathname.toLowerCase();
    if (isSearchEngineResultUrl(rawUrl)) return true;
    // Quote detail pages on these sites are mostly JS-rendered shells. Showing
    // them as deep-read URLs makes the model call web_fetch, get an empty page,
    // and then claim the quote was unavailable even when snippets were useful.
    if (host.endsWith("eastmoney.com") && /quote|stock|us|hk|sz|sh/i.test(path)) return true;
    if (host.endsWith("baidu.com")) return true;
  } catch {
    return false;
  }
  return false;
}

function shouldFetchMarketResultUrl(rawUrl: unknown): boolean {
  if (shouldHideMarketSourceUrl(rawUrl)) return false;
  return true;
}

function marketSummarySourceLabel(rawUrl: unknown, fallback = ""): string {
  if (shouldHideMarketSourceUrl(rawUrl)) return isZhLocale() ? "搜索摘要" : "Search summary";
  return sourceLabel(rawUrl) || fallback;
}

function buildSnapshotText(
  query: string,
  kind: MarketKind,
  provider: string,
  sources: MarketSource[],
  directQuotes: MarketQuote[] = [],
): string {
  const goldSummary = kind === "gold" ? buildGoldSummary(sources) : "";
  if (kind === "gold" && goldSummary) {
    const refs = sources
      .filter((item) => item.url && !shouldHideMarketSourceUrl(item.url))
      .filter((item) => item.host === "api.gold-api.com" || hasGoldEvidence(item.goldSignals))
      .slice(0, 3)
      .map((item, idx) => {
      const url = shouldHideMarketSourceUrl(item.url) ? "" : item.url || "";
      const title = item.title || item.source || url;
      return `${idx + 1}. ${title}${url ? `\n${url}` : ""}`;
    }).join("\n");
    return [
      `黄金价格快照（via ${provider}）`,
      `查询：${query}`,
      "",
      goldSummary,
      "",
      "参考来源：",
      refs || "- 暂无可展示来源",
      "",
      "说明：以上是刚检索到的网页报价汇总，不同品牌门店、工费和地区会有差异，不构成投资建议。",
    ].join("\n");
  }
  const zh = isZhLocale();
  const header = zh
    ? [
        `财经/行情快照（via ${provider}）`,
        `查询：${query}`,
        `类型：${kind}`,
        directQuotes.length
          ? "说明：以下结果优先来自直连行情源；关键价格、涨跌幅和时间点建议至少交叉验证 2 个来源。"
          : "说明：以下结果来自结构化源、网页搜索与正文抓取汇总；关键价格、涨跌幅和时间点建议至少交叉验证 2 个来源。",
      ].join("\n")
    : [
        `Market snapshot (via ${provider})`,
        `Query: ${query}`,
        `Type: ${kind}`,
        directQuotes.length
          ? "Note: direct market data sources are preferred. Cross-check key prices, changes, and timestamps across at least two sources."
          : "Note: results are aggregated from structured sources, web search, and page extraction. Cross-check key prices, changes, and timestamps across at least two sources.",
      ].join("\n");

  const quoteBody = directQuotes.length
    ? directQuotes.map((item, idx) => {
      const timestamp = [item.date, item.time].filter(Boolean).join(" ");
      const priceText = [item.close, item.currency].filter(Boolean).join(" ");
      const changeText = [item.change, item.pct].filter(Boolean).join(" / ");
      return [
        `${idx + 1}. ${item.symbol} 最近可用行情`,
        zh ? `来源：${item.source}` : `Source: ${item.source}`,
        item.url,
        item.name ? `- ${zh ? "名称" : "Name"}: ${item.name}` : "",
        `- ${zh ? "价格" : "Close"}: ${priceText || item.close}`,
        changeText ? `- ${zh ? "涨跌/涨跌幅" : "Change/Percent"}: ${changeText}` : "",
        timestamp ? `- ${zh ? "时间戳" : "Timestamp"}: ${timestamp}` : "",
        item.open ? `- ${zh ? "开盘/最高/最低" : "Open/High/Low"}: ${item.open} / ${item.high || "?"} / ${item.low || "?"}` : "",
        item.amountText ? `- ${zh ? "成交额" : "Turnover"}: ${item.amountText}` : "",
        item.turnoverRate ? `- ${zh ? "换手率" : "Turnover rate"}: ${item.turnoverRate}%` : "",
      ].filter(Boolean).join("\n");
    }).join("\n\n")
    : "";

  const webBody = sources.map((item, idx) => {
    const displayIndex = idx + 1 + directQuotes.length;
    const lines = item.lines?.length
      ? item.lines.map((line) => `- ${line}`).join("\n")
      : `- ${item.snippet || (zh ? "未提取到清晰行情行，建议继续深读该来源。" : "No clear market line extracted; consider reading this source in depth.")}`;
    return [
      `${displayIndex}. ${item.title || item.source || item.url}`,
      zh ? `来源：${item.source || item.host}` : `Source: ${item.source || item.host}`,
      item.url,
      lines,
    ].filter(Boolean).join("\n");
  }).join("\n\n");

  const tail = zh
    ? "\n\n后续建议：以上属于最近可用行情/网页汇总，不构成投资建议；盘中或高频交易场景请继续交叉核验交易所、券商或专门行情源。"
    : "\n\nSuggested next step: use web_fetch on the most relevant source for more detail, or connect a dedicated finance data source for stricter real-time quotes.";

  const body = [goldSummary, quoteBody, webBody].filter(Boolean).join("\n\n");
  return `${header}\n\n${body}${tail}`;
}

function buildMarketEvidence(
  kind: MarketKind,
  provider: string,
  sources: MarketSource[] = [],
  directQuotes: MarketQuote[] = [],
): Array<Record<string, unknown>> {
  const quoteEvidence = (directQuotes || []).map((item) => {
    const timestamp = [item.date, item.time].filter(Boolean).join(" ");
    return {
      type: "quote",
      kind,
      label: item.name || item.symbol || "",
      symbol: item.symbol || "",
      value: item.close || "",
      unit: item.currency || "",
      change: item.change || "",
      percent: item.pct || "",
      timestamp,
      source: item.source || provider || "",
      url: item.url || "",
    };
  });

  const sourceEvidence = (sources || []).map((item) => ({
    type: "source",
    kind,
    label: item.title || item.source || item.host || item.url || "",
    value: item.lines?.[0] || item.snippet || "",
    timestamp: item.timestamp || item.date || "",
    source: item.source || item.host || provider || "",
    url: item.url || "",
    symbol: "",
  }));

  return [...quoteEvidence, ...sourceEvidence]
    .filter((item) => item.value || item.url || item.symbol)
    .slice(0, 12);
}

async function collectMarketSources(query: string, kind: MarketKind, market = "", symbol = ""): Promise<MarketCollection> {
  let conceptSources: MarketSource[] = [];
  let directQuotes: MarketQuote[] = [];
  let triedConceptResolution = false;
  if (kind === "stock" && shouldPreferDynamicConceptResolution(query, symbol)) {
    triedConceptResolution = true;
    const concept = await collectConceptStockQuotes(query).catch(() => ({ directQuotes: [], sources: [] }));
    directQuotes = concept.directQuotes || [];
    conceptSources = concept.sources || [];
  }
  if (kind === "stock" && !directQuotes.length) {
    directQuotes = [
      ...await collectAStockQuotes(query, symbol).catch(() => []),
      ...await collectHongKongQuotes(query, symbol).catch(() => []),
      ...await collectStooqQuotes(query, symbol).catch(() => []),
    ];
  }
  if (kind === "stock" && !directQuotes.length && !triedConceptResolution && hasConceptStockIntent(query)) {
    const concept = await collectConceptStockQuotes(query).catch(() => ({ directQuotes: [], sources: [] }));
    directQuotes = concept.directQuotes || [];
    conceptSources = concept.sources || [];
  }
  if (directQuotes.length) {
    return {
      provider: directQuotes[0]?.source || "direct_quote",
      plan: { scene: "finance" },
      sources: conceptSources,
      directQuotes,
    };
  }

  const picked: MarketSource[] = [];
  if (kind === "gold") {
    const goldApiSource = await fetchGoldApiMarketSource().catch(() => null);
    if (goldApiSource) {
      picked.push(goldApiSource);
      if (shouldReturnGoldApiImmediately(query)) {
        return {
          provider: goldApiSource.source || "gold-api.com",
          plan: { scene: "finance" },
          sources: picked,
          directQuotes,
        };
      }
    }
  }
  if (kind === "oil") {
    const oilQuotes = await collectOilDirectQuotes(query).catch(() => []);
    for (const quote of oilQuotes) {
      picked.push({
        title: `${quote.name} 实时行情`,
        url: `https://finance.sina.com.cn/futures/quotes/${String(quote.symbol || "").replace(/^hf_/, "")}.shtml`,
        snippet: `${quote.name} ${quote.price}`,
        lines: [
          `${quote.name}：${quote.price} 美元/桶${quote.pct ? `，涨跌幅 ${quote.pct}` : ""}${quote.change ? `，涨跌 ${quote.change}` : ""}`,
          quote.time ? `时间：${quote.time}` : "",
          quote.high && quote.low ? `日内高/低：${quote.high} / ${quote.low}` : "",
          quote.previous ? `前收：${quote.previous}` : "",
        ].filter(Boolean),
        goldSignals: null,
        source: "新浪财经",
        host: "hq.sinajs.cn",
      });
    }
    if (picked.length) {
      return {
        provider: "新浪财经",
        plan: { scene: "finance" },
        sources: picked,
        directQuotes,
      };
    }
  }
  if (kind === "fx") {
    const fxSource = await fetchFxMarketSource(query).catch(() => null);
    if (fxSource) {
      return {
        provider: fxSource.source || "open.er-api.com",
        plan: { scene: "finance" },
        sources: [fxSource],
        directQuotes,
      };
    }
  }
  const searchQueries = kind === "gold"
    ? buildGoldQueries(query, market, symbol)
    : [buildQuery(query, kind, market, symbol)];
  const seenUrls = new Set();
  let provider = "";
  let plan: { scene?: string } | null = null;
  let lastError: unknown = null;
  const fetchLimit = kind === "gold" ? GOLD_FETCH_COUNT : DEFAULT_FETCH_COUNT;

  for (const searchQuery of searchQueries) {
    let results: SearchResultItem[] = [];
    try {
      const searchResult = await runSearchQuery(searchQuery, 5, { sceneHint: "finance" });
      results = searchResult.results || [];
      if (!provider) provider = searchResult.provider || "";
      if (!plan) plan = searchResult.plan || null;
    } catch (err) {
      lastError = err;
      continue;
    }

    for (const result of results.slice(0, kind === "gold" ? 2 : 3)) {
      if (!result?.url || seenUrls.has(result.url)) continue;
      seenUrls.add(result.url);

      let fetchedText = "";
      try {
        if (shouldFetchMarketResultUrl(result.url)) {
          const fetched = await fetchWebContent(result.url, MAX_FETCH_LENGTH);
          fetchedText = fetched.text || "";
        }
      } catch {
        // fallback to snippet only
      }
      const evidenceText = fetchedText || result.snippet || "";
      const lines = extractCandidateLines(evidenceText, kind);
      const goldSignals = kind === "gold" ? extractGoldSignals(evidenceText) : null;
      if (kind === "gold" && !hasGoldEvidence(goldSignals)) continue;
      const hideUrl = shouldHideMarketSourceUrl(result.url);
      picked.push({
        title: result.title,
        url: hideUrl ? "" : result.url,
        snippet: result.snippet,
        lines,
        goldSignals,
        source: marketSummarySourceLabel(result.url),
        host: hideUrl ? "" : (() => {
          try { return new URL(result.url).hostname; } catch { return ""; }
        })(),
      });

      if (kind !== "gold" && picked.length >= fetchLimit) break;
      if (kind === "gold" && picked.length >= 2 && countPriorityGoldEvidence(mergeGoldSignals(picked)) >= 2) break;
      if (picked.length >= fetchLimit) break;
    }

    if (kind !== "gold" && picked.length >= fetchLimit) break;
    if (kind === "gold" && picked.length >= 2 && countPriorityGoldEvidence(mergeGoldSignals(picked)) >= 2) break;
    if (picked.length >= fetchLimit) break;
  }

  if (!picked.length && lastError) {
    throw lastError;
  }

  return {
    provider,
    plan,
    sources: picked,
    directQuotes,
  };
}

export function createStockMarketTool() {
  return {
    name: "stock_market",
    label: t("toolDef.stockMarket.label"),
    description: t("toolDef.stockMarket.description"),
    parameters: Type.Object({
      query: Type.String({ description: t("toolDef.stockMarket.queryDesc") }),
      kind: Type.Optional(Type.String({ description: t("toolDef.stockMarket.kindDesc") })),
      market: Type.Optional(Type.String({ description: t("toolDef.stockMarket.marketDesc") })),
      symbol: Type.Optional(Type.String({
        description: t("toolDef.stockMarket.symbolDesc"),
        pattern: "^(?:[A-Z]{2,5}|[0-9]{6})$",
      })),
    }),
    execute: async (_toolCallId: string, params: StockMarketToolParams): Promise<ToolTextResult> => {
      const query = String(params.query || "").trim();
      if (!query) {
        return {
          content: [{ type: "text", text: isZhLocale() ? "请输入要查询的行情问题。" : "Please provide a market query." }],
          details: {},
        };
      }

      const kind = detectKind(query, params.kind);
      if (kind === "stock" && !hasFinanceLookupIntent(query, params.symbol)) {
        return {
          content: [{
            type: "text",
            text: isZhLocale()
              ? "未检测到明确的股票/行情查询意图。不要把会议里的“客户 A”、季度标记 Q1/Q2 或“报价模板”当作股票代码；请直接按用户原始办公任务整理、计算或写作。"
              : "No clear stock or market-quote intent was detected. Do not treat meeting labels such as client A, Q1/Q2, or quote templates as stock tickers; answer the original office task directly.",
          }],
          details: { scene: "finance", notFinanceIntent: true },
        };
      }
      try {
        const { provider, plan, sources, directQuotes } = await collectMarketSources(query, kind, params.market, params.symbol);
        if (!sources.length && !directQuotes?.length) {
          return {
            content: [{
              type: "text",
              text: isZhLocale()
                ? "这次没有拿到可用的财经结果。请重试，或继续使用 web_search / web_fetch 深读具体来源。"
                : "No usable finance results were found this time. Please retry, or continue with web_search / web_fetch for specific sources.",
          }],
          details: {
            scene: plan?.scene || "finance",
            provider,
            kind,
            evidence: [],
          },
        };
      }

        const evidence = buildMarketEvidence(kind, provider, sources, directQuotes);
        return {
          content: [{
            type: "text",
            text: buildSnapshotText(query, kind, provider, sources, directQuotes),
          }],
          details: {
            scene: plan?.scene || "finance",
            provider,
            kind,
            market: params.market || "",
            symbol: params.symbol || "",
            sources: sources.map((item) => ({
              title: item.title,
              source: item.source,
              url: item.url,
            })),
            directQuotes: (directQuotes || []).map((item) => ({
              symbol: item.symbol,
              close: item.close,
              currency: item.currency,
              date: item.date,
              time: item.time,
              source: item.source,
              url: item.url,
            })),
            evidence,
            shouldCrossVerify: true,
          },
        };
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: isZhLocale()
              ? `行情查询失败：${errorMessage(err)}`
              : `Market lookup failed: ${errorMessage(err)}`,
          }],
          details: { kind, evidence: [] },
        };
      }
    },
  };
}
