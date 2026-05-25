/**
 * hono-helpers.js — Hono migration utilities
 */

interface HonoJsonContext {
  req: {
    text(): Promise<string>;
  };
}

/** Safe JSON body parse — returns fallback on empty body or non-JSON */
export async function safeJson<T = Record<string, unknown>>(c: HonoJsonContext, fallback = {} as T): Promise<T> {
  try {
    const text = await c.req.text();
    return text ? JSON.parse(text) as T : fallback;
  } catch {
    return fallback;
  }
}
