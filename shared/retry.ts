import { AppError } from './errors.js';

export type RetryableAppError = Error & {
  retryable?: boolean;
  _retryAfterMs?: number;
  context?: Record<string, unknown> & { retryAfterMs?: unknown };
};

export type RetryOptions = {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  shouldRetry?: (error: RetryableAppError) => boolean;
};

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}

/**
 * Retry with decorrelated jitter (AWS recommended).
 * delay = min(maxDelay, random(baseDelay, previousDelay * 3))
 */
export async function withRetry<T>(fn: () => T | Promise<T>, opts: RetryOptions = {}): Promise<T | undefined> {
  const { maxAttempts = 3, baseDelayMs = 1000, maxDelayMs = 30000, signal, shouldRetry } = opts;
  let prevDelay = baseDelayMs;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const appErr = AppError.wrap(err) as RetryableAppError;
      const retry = shouldRetry ? shouldRetry(appErr) : appErr.retryable;
      if (!retry || attempt === maxAttempts - 1) throw appErr;

      if (signal?.aborted) throw appErr;

      // 优先使用 429 Retry-After 精确等待时间
      const retryAfterMs = (appErr._retryAfterMs || appErr.context?.retryAfterMs) as number;
      const delay = retryAfterMs > 0
        ? Math.min(maxDelayMs, retryAfterMs)
        : Math.min(maxDelayMs, randomBetween(baseDelayMs, prevDelay * 3));
      prevDelay = delay;
      await sleep(delay, signal);
    }
  }
}
