type FxTable = { result: string; base_code: string; rates: Record<string, unknown>; time_last_update_utc: string };
export type FxRate = { base: string; quote: string; rate: number; updatedAt: string; source: string; url: string; reference: boolean };
const fallbackCache = new Map<string, { table: FxTable; expires: number }>();
const fallbackInflight = new Map<string, Promise<FxTable>>();
const fallbackRoot = "https://allratestoday.com/api/open/latest/";

async function fetchTable(url: string, base: string): Promise<FxTable> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4500);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { "User-Agent": "Lynn/MarketQuote" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const table = await response.json() as FxTable;
    if (table?.result !== "success" || table.base_code !== base || !table.rates || typeof table.rates !== "object" || Array.isArray(table.rates)
      || !Object.keys(table.rates).length || Object.values(table.rates).some(rate => typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0)
      || typeof table.time_last_update_utc !== "string" || !Number.isFinite(Date.parse(table.time_last_update_utc))) {
      throw new Error("Invalid exchange-rate response");
    }
    return table;
  } finally {
    clearTimeout(timer);
  }
}

async function fallbackTable(base: string): Promise<FxTable> {
  const cached = fallbackCache.get(base);
  if (cached && cached.expires > Date.now()) return cached.table;
  const existing = fallbackInflight.get(base);
  if (existing) return existing;
  const pending = fetchTable(`${fallbackRoot}${base}`, base).then(table => {
    if (fallbackCache.size >= 32) fallbackCache.delete(fallbackCache.keys().next().value!);
    fallbackCache.set(base, { table, expires: Date.now() + 3600_000 });
    return table;
  }).finally(() => fallbackInflight.delete(base));
  fallbackInflight.set(base, pending);
  return pending;
}

export async function fetchFxRate(base = "USD", quote = "CNY"): Promise<FxRate> {
  base = base.trim().toUpperCase();
  quote = quote.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(base) || !/^[A-Z]{3}$/.test(quote)) throw new Error("Expected explicit three-letter currency codes");
  const failures: string[] = [];
  for (const source of ["open.er-api.com", "allratestoday.com"]) {
    const reference = source === "allratestoday.com";
    const url = reference ? `${fallbackRoot}${base}` : `https://open.er-api.com/v6/latest/${base}`;
    try {
      const table = await (reference ? fallbackTable(base) : fetchTable(url, base));
      const rate = table.rates[quote];
      if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) throw new Error(`Missing or invalid ${base}/${quote} rate`);
      return { base, quote, rate, updatedAt: table.time_last_update_utc, source, url, reference };
    } catch (error) {
      failures.push(`${source}: ${error instanceof Error ? error.message : "request failed"}`);
    }
  }
  throw new Error(`${base}/${quote} unavailable (${failures.join("; ")})`);
}

export function fxSourceNote(rate: FxRate): string {
  return rate.reference
    ? `汇率来源：[AllRatesToday](https://allratestoday.com)，ECB 每日参考汇率（非实时成交价）；更新时间：${rate.updatedAt}`
    : `汇率来源：${rate.source}；更新时间：${rate.updatedAt}`;
}
