export type RateLimitDecision = boolean;

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

interface RateLimiterOptions {
  capacity?: number;
  refillMs?: number;
  now?: () => number;
}

export function createTokenBucketRateLimiter(opts: RateLimiterOptions = {}): (subject: unknown) => RateLimitDecision {
  const capacity = Math.max(1, Number(opts.capacity || 5));
  const refillMs = Math.max(1, Number(opts.refillMs || 10_000));
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();
  const buckets = new WeakMap<object, TokenBucket>();

  return function checkRateLimit(subject: unknown): RateLimitDecision {
    if (!subject || (typeof subject !== "object" && typeof subject !== "function")) return false;
    let bucket = buckets.get(subject as object);
    if (!bucket) {
      bucket = { tokens: capacity, lastRefill: now() };
      buckets.set(subject as object, bucket);
    }
    const currentTime = now();
    const elapsed = currentTime - bucket.lastRefill;
    if (elapsed >= refillMs) {
      const refills = Math.floor(elapsed / refillMs);
      bucket.tokens = Math.min(capacity, bucket.tokens + refills * capacity);
      bucket.lastRefill += refills * refillMs;
    }
    if (bucket.tokens <= 0) return false;
    bucket.tokens -= 1;
    return true;
  };
}
