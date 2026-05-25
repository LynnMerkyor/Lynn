import { AppError } from './errors.js';
import { errorBus } from './error-bus.js';

export type SafeParseResponseInput = {
  ok: unknown;
  status: unknown;
  url?: unknown;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
};

export function safeParseJSON<T = unknown>(text: unknown): T | null;
export function safeParseJSON<T = unknown, F = null>(text: unknown, fallback: F): T | F;
export function safeParseJSON<T = unknown, F = null>(text: unknown, fallback: F | null = null): T | F | null {
  try {
    return JSON.parse(text as string) as T;
  } catch (err) {
    errorBus.report(new AppError('CONFIG_PARSE', { cause: err, context: { textPreview: String(text).slice(0, 100) } }));
    return fallback;
  }
}

export function safeParseResponse<T = unknown>(res: SafeParseResponseInput | null | undefined): Promise<T | null>;
export function safeParseResponse<T = unknown, F = null>(res: SafeParseResponseInput | null | undefined, fallback: F): Promise<T | F>;
export async function safeParseResponse<T = unknown, F = null>(
  res: SafeParseResponseInput | null | undefined,
  fallback: F | null = null,
): Promise<T | F | null> {
  try {
    const response = res as SafeParseResponseInput;
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      errorBus.report(new AppError('FETCH_SERVER_ERROR', {
        message: `HTTP ${response.status}: ${body.slice(0, 200)}`,
        context: { status: response.status, url: response.url },
      }));
      return fallback;
    }
    return await response.json() as T;
  } catch (err) {
    errorBus.report(new AppError('CONFIG_PARSE', { cause: err, context: { url: res?.url } }));
    return fallback;
  }
}
