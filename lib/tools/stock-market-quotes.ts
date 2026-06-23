import type { LooseRecord, MarketQuote } from "./stock-market-types.js";
import {
  A_STOCK_BASKETS,
  A_STOCK_NAME_TO_SYMBOL,
  FINANCE_LOOKUP_CONTEXT_RE,
  HK_STOCK_NAME_TO_SYMBOL,
  HK_TECH_BASKET_SYMBOLS,
  KNOWN_US_STOCK_SYMBOLS,
  NON_FINANCE_QUOTE_CONTEXT_RE,
  STOOQ_TIMEOUT_MS,
  TICKER_STOPWORDS,
  US_STOCK_NAME_TO_SYMBOL,
  US_TECH_BASKET_SYMBOLS,
  formatPrice,
  hasStockBasketIntent,
  toFiniteNumber,
} from "./stock-market-core.js";

export async function fetchTextWithTimeout(
  url: string,
  ms: number,
  headers: Record<string, string> = {},
  encoding = "utf-8",
): Promise<string> {
  const timer = timeoutSignal(ms);
  try {
    const resp = await fetch(url, {
      signal: timer.signal,
      headers: { "User-Agent": "Lynn/MarketQuote", ...headers },
    });
    if (!resp.ok) throw new Error(`${url} ${resp.status}`);
    if (encoding && encoding.toLowerCase() !== "utf-8") {
      const bytes = await resp.arrayBuffer();
      return new TextDecoder(encoding).decode(bytes);
    }
    return await resp.text();
  } finally {
    timer.clear();
  }
}

export function parseSinaFuturesQuote(raw: unknown, fallbackSymbol = ""): MarketQuote | null {
  const match = String(raw || "").match(/=\"([^\"]*)\"/);
  const parts = (match?.[1] || "").split(",");
  const price = toFiniteNumber(parts[0]);
  if (price == null || !Number.isFinite(price)) return null;
  const prev = toFiniteNumber(parts[7]);
  const change = prev != null && Number.isFinite(prev) ? price - prev : null;
  const pct = change != null && Number.isFinite(change) && prev ? `${change >= 0 ? "+" : ""}${((change / prev) * 100).toFixed(2)}%` : "";
  const fallbackName = fallbackSymbol === "hf_OIL"
    ? "布伦特原油"
    : fallbackSymbol === "hf_CL"
      ? "WTI原油"
      : fallbackSymbol;
  const rawName = parts[13] || "";
  const name = rawName && /原油|布伦特|WTI|Crude|Oil/i.test(rawName) ? rawName : fallbackName;
  return {
    symbol: fallbackSymbol,
    name,
    price: formatPrice(price, 3),
    high: formatPrice(parts[4], 3),
    low: formatPrice(parts[5], 3),
    time: [parts[12], parts[6]].filter(Boolean).join(" "),
    previous: Number.isFinite(prev) ? formatPrice(prev, 3) : "",
    change: change != null && Number.isFinite(change) ? `${change >= 0 ? "+" : ""}${formatPrice(change, 3)}` : "",
    pct,
  };
}

export async function fetchSinaFuturesQuote(symbol: string): Promise<MarketQuote | null> {
  const raw = await fetchTextWithTimeout(`https://hq.sinajs.cn/list=${symbol}`, 4500, {
    Referer: "https://finance.sina.com.cn/",
  }, "gbk");
  return parseSinaFuturesQuote(raw, symbol);
}

export async function collectOilDirectQuotes(query: unknown): Promise<MarketQuote[]> {
  const text = String(query || "");
  const targets: string[] = [];
  if (/布伦特|brent|oil/i.test(text)) targets.push("hf_OIL");
  if (/WTI|纽约原油|美油|crude|CL\b/i.test(text)) targets.push("hf_CL");
  if (!targets.length) targets.push("hf_OIL");
  const settled = await Promise.allSettled([...new Set(targets)].map(fetchSinaFuturesQuote));
  return settled
    .map((item) => item.status === "fulfilled" ? item.value : null)
    .filter((item): item is MarketQuote => Boolean(item));
}

export function timeoutSignal(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}

export function parseCsvLine(line: unknown): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;
  const source = String(line || "");
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '"') {
      if (inQuotes && source[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      cells.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
}

export function hasFinanceLookupIntent(query: unknown, explicitSymbol = ""): boolean {
  const text = String(query || "");
  if (String(explicitSymbol || "").trim()) return true;
  if (hasStockBasketIntent(text)) return true;
  if (NON_FINANCE_QUOTE_CONTEXT_RE.test(text) && !FINANCE_LOOKUP_CONTEXT_RE.test(text)) return false;
  if (FINANCE_LOOKUP_CONTEXT_RE.test(text)) return true;
  if (/\$[A-Z]{1,5}(?:\.[A-Z]{1,3})?\b/.test(text)) return true;
  for (const [name, symbol] of US_STOCK_NAME_TO_SYMBOL) {
    if (text.toLowerCase().includes(name.toLowerCase())) return true;
    if (new RegExp(`\\b${symbol}\\b`, "i").test(text)) return true;
  }
  return false;
}

export function extractUsStockSymbols(query: unknown, explicitSymbol = ""): string[] {
  const symbols: string[] = [];
  const text = String(query || "");
  const financeContext = hasFinanceLookupIntent(text, explicitSymbol);
  const add = (
    value: unknown,
    { explicit = false, dollar = false, known = false }: { explicit?: boolean; dollar?: boolean; known?: boolean } = {},
  ): void => {
    const normalized = String(value || "").trim().toUpperCase().replace(/^\$/, "");
    if (!/^[A-Z]{1,5}(?:\.[A-Z]{1,3})?$/.test(normalized)) return;
    const bare = normalized.split(".")[0];
    if (TICKER_STOPWORDS.has(bare)) return;
    if (!explicit && !dollar && !known && !financeContext) return;
    if (bare.length === 1 && !explicit && !dollar) return;
    if (!symbols.includes(bare)) symbols.push(bare);
  };

  add(explicitSymbol, { explicit: true });
  for (const [name, symbol] of US_STOCK_NAME_TO_SYMBOL) {
    if (text.toLowerCase().includes(name.toLowerCase())) add(symbol, { known: true });
  }
  if (/(?:美股|纳斯达克|纳指|七姐妹|七巨头|magnificent|mag7).{0,12}(?:科技|AI|人工智能|芯片|半导体|互联网|表现|行情|涨跌)?|(?:科技|AI|人工智能|芯片|半导体|互联网).{0,12}(?:美股|纳斯达克|纳指|七姐妹|七巨头|magnificent|mag7)/i.test(text)) {
    for (const symbol of US_TECH_BASKET_SYMBOLS) add(symbol, { known: true });
  }
  for (const match of text.matchAll(/\$?\b([A-Z]{1,5})(?:\.[A-Z]{1,3})?\b/g)) {
    const raw = match[0] || "";
    const bare = (match[1] || "").toUpperCase();
    add(bare, { dollar: raw.startsWith("$"), known: KNOWN_US_STOCK_SYMBOLS.has(bare) });
  }
  return symbols.slice(0, 8);
}

export async function fetchStooqQuote(symbol: string): Promise<MarketQuote | null> {
  const bare = String(symbol || "").trim().toUpperCase().replace(/^\$/, "").split(".")[0];
  if (!bare) return null;
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const timer = timeoutSignal(STOOQ_TIMEOUT_MS);
    try {
      const url = `https://stooq.com/q/l/?s=${encodeURIComponent(`${bare}.us`.toLowerCase())}&f=sd2t2ohlcv&h&e=csv`;
      const resp = await fetch(url, {
        signal: timer.signal,
        headers: { "User-Agent": "Lynn/MarketQuote" },
      });
      if (!resp.ok) throw new Error(`Stooq ${resp.status}`);
      const csv = await resp.text();
      const [headerLine, dataLine] = csv.trim().split(/\r?\n/);
      const headers = parseCsvLine(headerLine);
      const values = parseCsvLine(dataLine);
      const row = Object.fromEntries(headers.map((key, index) => [key, values[index] || ""])) as LooseRecord;
      if (!row.Symbol || row.Close === "N/D" || !Number.isFinite(Number(row.Close))) return null;
      return {
        symbol: bare,
        stooqSymbol: row.Symbol,
        date: row.Date || "",
        time: row.Time || "",
        open: row.Open || "",
        high: row.High || "",
        low: row.Low || "",
        close: row.Close || "",
        volume: row.Volume || "",
        source: "Stooq",
        url: `https://stooq.com/q/?s=${encodeURIComponent(`${bare}.us`.toLowerCase())}`,
        currency: "USD",
      };
    } catch (error) {
      lastError = error;
    } finally {
      timer.clear();
    }
  }
  if (lastError) return null;
  return null;
}

function formatSignedNumber(value: unknown, digits = 2): string {
  const n = toFiniteNumber(value);
  if (n == null || !Number.isFinite(n)) return "";
  return `${n >= 0 ? "+" : ""}${formatPrice(n, digits)}`;
}

function formatTradingViewTimestamp(epochSeconds: unknown): { date: string; time: string } {
  const n = Number(epochSeconds);
  if (!Number.isFinite(n) || n <= 0) return { date: "", time: "" };
  const iso = new Date(n * 1000).toISOString();
  return {
    date: iso.slice(0, 10),
    time: `${iso.slice(11, 16)} UTC`,
  };
}

export async function fetchTradingViewQuote(symbol: string): Promise<MarketQuote | null> {
  const bare = String(symbol || "").trim().toUpperCase().replace(/^\$/, "").split(".")[0];
  if (!/^[A-Z]{1,5}$/.test(bare)) return null;
  const tickers = [`NASDAQ:${bare}`, `NYSE:${bare}`, `AMEX:${bare}`];
  const timer = timeoutSignal(4500);
  try {
    const resp = await fetch("https://scanner.tradingview.com/america/scan", {
      method: "POST",
      signal: timer.signal,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 Lynn/MarketQuote",
      },
      body: JSON.stringify({
        symbols: { tickers, query: { types: [] } },
        columns: [
          "name",
          "description",
          "exchange",
          "close",
          "change",
          "change_abs",
          "volume",
          "market_cap_basic",
          "currency",
          "update_mode",
          "time",
        ],
      }),
    });
    if (!resp.ok) throw new Error(`TradingView ${resp.status}`);
    const json = await resp.json() as LooseRecord;
    const row = Array.isArray(json?.data) ? json.data.find((item: LooseRecord) => {
      const d = Array.isArray(item?.d) ? item.d : [];
      return String(d[0] || "").toUpperCase() === bare && Number.isFinite(Number(d[3]));
    }) : null;
    const d = Array.isArray(row?.d) ? row.d : [];
    const close = formatPrice(d[3], 2);
    if (!close) return null;
    const exchange = String(d[2] || String(row?.s || "").split(":")[0] || "").toUpperCase();
    const timestamp = formatTradingViewTimestamp(d[10]);
    const change = formatSignedNumber(d[5], 2);
    const pct = formatSignedNumber(d[4], 2);
    return {
      symbol: bare,
      name: String(d[1] || d[0] || bare),
      date: timestamp.date,
      // TradingView's daily-bar timestamp is the bar time, not a precise close
      // timestamp. Keep the quote date and avoid presenting it as close time.
      time: "",
      close,
      volume: d[6] != null ? String(d[6]) : "",
      amount: d[7] != null ? String(d[7]) : "",
      change,
      pct: pct ? `${pct}%` : "",
      source: "TradingView",
      url: exchange
        ? `https://www.tradingview.com/symbols/${encodeURIComponent(`${exchange}-${bare}`)}/`
        : `https://www.tradingview.com/symbols/${encodeURIComponent(bare)}/`,
      currency: String(d[8] || "USD"),
    };
  } catch {
    return null;
  } finally {
    timer.clear();
  }
}

// US quotes via mainland-reachable mirrors first. stooq.com (the former primary)
// now returns HTTP 404 and TradingView's scanner is unreliable from China, so US
// lookups fell through to web search → JS-rendered quote pages → no extractable
// price. Tencent (qt.gtimg.cn) and Sina (hq.sinajs.cn) both serve US quotes over
// GBK, fast and reachable from the mainland; their price fields are ASCII. Keep
// stooq / TradingView as overseas fallbacks.
export async function fetchTencentUsQuote(symbol: string): Promise<MarketQuote | null> {
  const bare = String(symbol || "").trim().toUpperCase().replace(/^\$/, "").split(".")[0];
  if (!/^[A-Z]{1,5}$/.test(bare)) return null;
  const raw = await fetchTextWithTimeout(`https://qt.gtimg.cn/q=us${bare}`, 4500, {
    Referer: "https://gu.qq.com/",
  }, "gbk");
  const match = raw.match(/="([^"]*)"/);
  const parts = (match?.[1] || "").split("~");
  if (parts.length < 35) return null;
  const price = toFiniteNumber(parts[3]);
  if (price == null || !Number.isFinite(price)) return null;
  const prev = toFiniteNumber(parts[4]);
  const pct = formatSignedNumber(parts[32], 2);
  return {
    symbol: bare,
    name: parts[1] || bare,
    price: formatPrice(price, 2),
    close: formatPrice(price, 2),
    previousClose: prev != null && Number.isFinite(prev) ? formatPrice(prev, 2) : "",
    previous: prev != null && Number.isFinite(prev) ? formatPrice(prev, 2) : "",
    open: formatPrice(parts[5], 2),
    high: formatPrice(parts[33], 2),
    low: formatPrice(parts[34], 2),
    volume: parts[6] || "",
    time: parts[30] || "",
    change: formatSignedNumber(parts[31], 2),
    pct: pct ? `${pct}%` : "",
    source: "腾讯财经",
    url: `https://gu.qq.com/us${bare}`,
    currency: parts[35] || "USD",
  };
}

export async function fetchSinaUsQuote(symbol: string): Promise<MarketQuote | null> {
  const bare = String(symbol || "").trim().toUpperCase().replace(/^\$/, "").split(".")[0];
  if (!/^[A-Z]{1,5}$/.test(bare)) return null;
  const raw = await fetchTextWithTimeout(`https://hq.sinajs.cn/list=gb_${bare.toLowerCase()}`, 4500, {
    Referer: "https://finance.sina.com.cn/",
  }, "gbk");
  const match = raw.match(/="([^"]*)"/);
  const parts = (match?.[1] || "").split(",");
  if (parts.length < 27) return null;
  const price = toFiniteNumber(parts[1]);
  if (price == null || !Number.isFinite(price)) return null;
  const prev = toFiniteNumber(parts[26]);
  const pct = toFiniteNumber(parts[2]);
  return {
    symbol: bare,
    name: parts[0] || bare,
    price: formatPrice(price, 2),
    close: formatPrice(price, 2),
    previousClose: prev != null && Number.isFinite(prev) ? formatPrice(prev, 2) : "",
    previous: prev != null && Number.isFinite(prev) ? formatPrice(prev, 2) : "",
    open: formatPrice(parts[5], 2),
    high: formatPrice(parts[6], 2),
    low: formatPrice(parts[7], 2),
    time: parts[3] || "",
    change: formatSignedNumber(parts[4], 2),
    pct: pct != null && Number.isFinite(pct) ? `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%` : "",
    source: "新浪财经",
    url: `https://stock.finance.sina.com.cn/usstock/quotes/${bare}.html`,
    currency: "USD",
  };
}

export async function fetchUsStockQuote(symbol: string): Promise<MarketQuote | null> {
  return await fetchTencentUsQuote(symbol).catch(() => null)
    || await fetchSinaUsQuote(symbol).catch(() => null)
    || await fetchStooqQuote(symbol).catch(() => null)
    || await fetchTradingViewQuote(symbol).catch(() => null);
}

const TENCENT_US_INDEX_TARGETS = [
  { key: "IXIC", code: "usIXIC", label: "纳斯达克指数", aliases: /纳斯达克|纳指|nasdaq|ixic/i },
  { key: "DJI", code: "usDJI", label: "道琼斯指数", aliases: /道琼斯|道指|dow|dji/i },
  { key: "INX", code: "usINX", label: "标普500", aliases: /标普|s&p|sp500|s\s*&\s*p|inx/i },
] as const;

function extractIndexTargets(query: unknown, explicitSymbol = ""): Array<(typeof TENCENT_US_INDEX_TARGETS)[number]> {
  const text = `${query || ""} ${explicitSymbol || ""}`;
  const targets = TENCENT_US_INDEX_TARGETS.filter((item) => item.aliases.test(text));
  return targets.length ? targets : [];
}

function parseTencentUsIndexQuote(raw: unknown, target: (typeof TENCENT_US_INDEX_TARGETS)[number]): MarketQuote | null {
  const match = String(raw || "").match(/="([^"]*)"/);
  const parts = (match?.[1] || "").split("~");
  if (parts.length < 35) return null;
  const price = toFiniteNumber(parts[3]);
  if (price == null || !Number.isFinite(price)) return null;
  const prev = toFiniteNumber(parts[4]);
  const pct = formatSignedNumber(parts[32], 2);
  const rawSymbol = String(parts[2] || "").replace(/^\./, "").trim().toUpperCase();
  return {
    symbol: target.key,
    name: target.label || parts[1] || rawSymbol,
    price: formatPrice(price, 2),
    close: formatPrice(price, 2),
    previousClose: prev != null && Number.isFinite(prev) ? formatPrice(prev, 2) : "",
    previous: prev != null && Number.isFinite(prev) ? formatPrice(prev, 2) : "",
    open: formatPrice(parts[5], 2),
    high: formatPrice(parts[33], 2),
    low: formatPrice(parts[34], 2),
    volume: parts[6] || "",
    time: parts[30] || "",
    change: formatSignedNumber(parts[31], 2),
    pct: pct ? `${pct}%` : "",
    source: "腾讯财经",
    url: `https://gu.qq.com/${target.code}`,
    currency: parts[35] || "USD",
  };
}

async function fetchTencentUsIndexQuote(target: (typeof TENCENT_US_INDEX_TARGETS)[number]): Promise<MarketQuote | null> {
  const raw = await fetchTextWithTimeout(`https://qt.gtimg.cn/q=${target.code}`, 4500, {
    Referer: "https://gu.qq.com/",
    "User-Agent": "Mozilla/5.0 Lynn/MarketQuote",
  }, "gbk");
  return parseTencentUsIndexQuote(raw, target);
}

export async function collectIndexDirectQuotes(query: unknown, explicitSymbol = ""): Promise<MarketQuote[]> {
  const targets = extractIndexTargets(query, explicitSymbol);
  if (!targets.length) return [];
  const settled = await Promise.allSettled(targets.map((target) => fetchTencentUsIndexQuote(target)));
  return settled
    .map((item) => item.status === "fulfilled" ? item.value : null)
    .filter((item): item is MarketQuote => Boolean(item));
}

export async function collectStooqQuotes(query: unknown, explicitSymbol = ""): Promise<MarketQuote[]> {
  const symbols = extractUsStockSymbols(query, explicitSymbol);
  if (!symbols.length) return [];
  const settled = await Promise.allSettled(symbols.map((symbol) => fetchUsStockQuote(symbol)));
  return settled
    .map((item) => item.status === "fulfilled" ? item.value : null)
    .filter((item): item is MarketQuote => Boolean(item));
}

export function extractHongKongStockSymbols(query: unknown, explicitSymbol = ""): string[] {
  const symbols: string[] = [];
  const text = String(query || "");
  const add = (value: unknown): void => {
    const raw = String(value || "").trim().toUpperCase();
    const match = raw.match(/^(\d{4,5})(?:\.HK)?$/);
    if (!match) return;
    const symbol = match[1].padStart(5, "0");
    if (!symbols.includes(symbol)) symbols.push(symbol);
  };

  add(explicitSymbol);
  for (const [name, symbol] of HK_STOCK_NAME_TO_SYMBOL) {
    if (text.includes(name)) add(symbol);
  }
  if (/(?:港股.{0,8}科技|科技.{0,8}港股|恒生科技|港股互联网|港股.{0,8}互联网|中概科技)/.test(text)) {
    for (const symbol of HK_TECH_BASKET_SYMBOLS) add(symbol);
  }
  for (const match of text.matchAll(/\b(\d{4,5})\.HK\b/gi)) {
    add(match[1]);
  }
  return symbols.slice(0, 8);
}

export function extractAStockSymbols(query: unknown, explicitSymbol = ""): string[] {
  const symbols: string[] = [];
  const text = String(query || "");
  const add = (value: unknown): void => {
    const raw = String(value || "").trim();
    const match = raw.match(/^([0368]\d{5})$/);
    if (!match) return;
    if (!symbols.includes(match[1])) symbols.push(match[1]);
  };

  add(explicitSymbol);
  for (const [name, symbol] of A_STOCK_NAME_TO_SYMBOL) {
    if (text.includes(name)) add(symbol);
  }
  for (const basket of A_STOCK_BASKETS) {
    if (basket.re.test(text)) {
      for (const symbol of basket.symbols) add(symbol);
    }
  }
  for (const match of text.matchAll(/\b([0368]\d{5})\b/g)) {
    add(match[1]);
  }
  return symbols.slice(0, 8);
}

export function aStockTencentPrefix(symbol: unknown): string {
  const code = String(symbol || "");
  if (/^6/.test(code)) return "sh";
  if (/^[03]/.test(code)) return "sz";
  if (/^8/.test(code)) return "bj";
  return "";
}

export function parseTencentAStockQuote(raw: unknown, requestedSymbol: string): MarketQuote | null {
  const match = String(raw || "").match(/=\"([^\"]*)\"/);
  const fields = match?.[1]?.split("~") || [];
  const price = fields[3];
  if (!Number.isFinite(Number(price))) return null;
  const symbol = String(requestedSymbol || fields[2] || "").trim();
  const prefix = aStockTencentPrefix(symbol);
  const amountWan = toFiniteNumber(fields[37]);
  const amountText = amountWan != null && Number.isFinite(amountWan) ? `${formatPrice(amountWan / 10000)} 亿元` : "";
  return {
    symbol: `${symbol}.${prefix === "sh" ? "SH" : prefix === "bj" ? "BJ" : "SZ"}`,
    name: fields[1] || symbol,
    date: fields[30] || "",
    time: "",
    open: fields[5] || "",
    high: fields[33] || "",
    low: fields[34] || "",
    close: price,
    previousClose: fields[4] || "",
    change: fields[31] || "",
    pct: fields[32] ? `${fields[32]}%` : "",
    volume: fields[36] || "",
    amount: fields[37] || "",
    amountText,
    turnoverRate: fields[38] || "",
    pe: fields[39] || "",
    source: "腾讯行情",
    url: `https://gu.qq.com/${prefix}${symbol}/gp`,
    currency: "CNY",
  };
}

export async function fetchTencentAStockQuote(symbol: string): Promise<MarketQuote | null> {
  const normalized = String(symbol || "").trim();
  const prefix = aStockTencentPrefix(normalized);
  if (!prefix || !/^[0368]\d{5}$/.test(normalized)) return null;
  const raw = await fetchTextWithTimeout(`https://qt.gtimg.cn/q=${prefix}${normalized}`, 4500, {
    Referer: "https://gu.qq.com/",
    "User-Agent": "Mozilla/5.0 Lynn/MarketQuote",
  }, "gbk");
  return parseTencentAStockQuote(raw, normalized);
}

export async function collectAStockQuotes(query: unknown, explicitSymbol = ""): Promise<MarketQuote[]> {
  const symbols = extractAStockSymbols(query, explicitSymbol);
  if (!symbols.length) return [];
  const settled = await Promise.allSettled(symbols.map((symbol) => fetchTencentAStockQuote(symbol)));
  return settled
    .map((item) => item.status === "fulfilled" ? item.value : null)
    .filter((item): item is MarketQuote => Boolean(item));
}
