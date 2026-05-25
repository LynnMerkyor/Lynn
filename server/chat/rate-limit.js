export function createTokenBucketRateLimiter(opts = {}) {
  const capacity = Math.max(1, Number(opts.capacity || 5));
  const refillMs = Math.max(1, Number(opts.refillMs || 10_000));
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();
  const buckets = new WeakMap();

  return function checkRateLimit(subject) {
    if (!subject || (typeof subject !== "object" && typeof subject !== "function")) return false;
    let bucket = buckets.get(subject);
    if (!bucket) {
      bucket = { tokens: capacity, lastRefill: now() };
      buckets.set(subject, bucket);
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
