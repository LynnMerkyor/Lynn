import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const table = (overrides = {}) => ({ result: "success", base_code: "USD", time_last_update_utc: "Fri, 23 Oct 2026 15:00:00 GMT", rates: { CNY: 6.67, EUR: 0.89 }, ...overrides });
const response = (data: unknown) => ({ ok: true, json: async () => data });
let fetchFxRate: typeof import("../lib/tools/fx-rates.js").fetchFxRate;
beforeEach(async () => { vi.resetModules(); ({ fetchFxRate } = await import("../lib/tools/fx-rates.js")); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("foreign exchange failover", () => {
  it("uses only the primary when its result is valid", async () => {
    const fetcher = vi.fn().mockResolvedValue(response(table()));
    vi.stubGlobal("fetch", fetcher);
    expect(await fetchFxRate("usd", "cny")).toMatchObject({ rate: 6.67, source: "open.er-api.com", reference: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([null, table({ result: "error" }), table({ base_code: "EUR" }), table({ rates: { CNY: 0 } }), table({ rates: { CNY: -1 } }), table({ rates: { CNY: "6.67" } }), table({ rates: {} }), table({ time_last_update_utc: "invalid" })])("falls back on invalid primary data: %j", async invalid => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response(invalid)).mockResolvedValueOnce(response(table())));
    expect(await fetchFxRate()).toMatchObject({ source: "allratestoday.com", url: "https://allratestoday.com/api/open/latest/USD", reference: true });
  });
  it("times out response bodies and reuses the successful fallback table", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async (url: string, options: RequestInit) => {
      if (url.includes("allratestoday")) return response(table());
      return { ok: true, json: () => new Promise((_resolve, reject) => options.signal!.addEventListener("abort", () => reject(new Error("body timeout")), { once: true })) };
    });
    vi.stubGlobal("fetch", fetcher);
    const first = fetchFxRate();
    await vi.advanceTimersByTimeAsync(4500);
    expect(await first).toMatchObject({ source: "allratestoday.com" });
    const second = fetchFxRate("USD", "EUR");
    await vi.advanceTimersByTimeAsync(4500);
    expect((await second).rate).toBe(0.89);
    expect(fetcher.mock.calls.filter(([url]) => url.includes("allratestoday"))).toHaveLength(1);
  });
  it("reports both failed sources without inventing a rate", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    await expect(fetchFxRate("JPY", "CNY")).rejects.toThrow(/JPY\/CNY unavailable.*open.er-api.com.*allratestoday.com/);
  });
  it("does not cache a malformed fallback table", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({ ok: false, status: 503 }).mockResolvedValueOnce(response(table({ rates: { CNY: -1 } })))
      .mockResolvedValueOnce({ ok: false, status: 503 }).mockResolvedValueOnce(response(table()));
    vi.stubGlobal("fetch", fetcher);
    await expect(fetchFxRate()).rejects.toThrow("unavailable");
    expect((await fetchFxRate()).rate).toBe(6.67);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it("deduplicates concurrent fallback requests and expires the cache", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async (url: string) => url.includes("allratestoday") ? response(table()) : { ok: false, status: 503 });
    vi.stubGlobal("fetch", fetcher);
    const results = await Promise.all([fetchFxRate(), fetchFxRate("USD", "EUR")]);
    expect(results.map(result => result.rate)).toEqual([6.67, 0.89]);
    expect(fetcher.mock.calls.filter(([url]) => url.includes("allratestoday"))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3600_001);
    await fetchFxRate();
    expect(fetcher.mock.calls.filter(([url]) => url.includes("allratestoday"))).toHaveLength(2);
  });
  it("rejects malformed model parameters before any network request", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(fetchFxRate("USD/path", "CNY")).rejects.toThrow("currency codes");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
