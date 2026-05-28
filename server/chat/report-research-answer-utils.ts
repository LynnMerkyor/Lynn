import type {
  StooqItem,
  StructuredFields,
  StructuredSectionEntry,
  ToolExecutionResult,
} from "./report-research-answer-types.js";

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

export function textOf(value: unknown): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function extractToolText(result: ToolExecutionResult | null | undefined): string {
  return (result?.content || [])
    .map((item) => item?.text || "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function parseStooqItems(context: unknown): StooqItem[] {
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

export function extractRequestedUsTickers(text: unknown): string[] {
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

export function escapeRegExp(value: unknown): string {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function extractStructuredContextSection(context: unknown, title: string): string {
  const re = new RegExp(`【${escapeRegExp(title)}】\\n([\\s\\S]*?)(?=\\n【|$)`);
  return String(context || "").match(re)?.[1]?.trim() || "";
}

export function parseStructuredFields(sectionText: unknown): StructuredFields {
  const fields: StructuredFields = {};
  for (const rawLine of String(sectionText || "").split(/\r?\n/)) {
    const line = textOf(rawLine);
    const match = line.match(/^-?\s*([^:：]+)[:：]\s*(.+)$/);
    if (match) fields[match[1].trim()] = match[2].trim();
  }
  return fields;
}

export function buildStructuredSection(title: string, entries: readonly StructuredSectionEntry[]): string {
  const lines = entries
    .filter(([, value]) => textOf(value))
    .map(([label, value]) => `- ${label}: ${textOf(value)}`);
  if (!lines.length) return "";
  return [`【${title}】`, ...lines].join("\n");
}

export function formatLocalDate(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function formatLocalDateTime(date: Date = new Date()): string {
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${formatLocalDate(date)} ${hour}:${minute}`;
}

export function uniqueCompact(items: unknown[], max: number = 3): string[] {
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

export function extractEvidenceSources(context: unknown, max: number = 3): string[] {
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
