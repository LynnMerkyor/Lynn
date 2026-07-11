export type RateLimitDecision = boolean;

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

interface RateLimiterOptions {
  capacity?: number;
  refillMs?: number;
  now?: () => number;
  maxPrimitiveSubjects?: number;
}

export function createTokenBucketRateLimiter(opts: RateLimiterOptions = {}): (subject: unknown) => RateLimitDecision {
  const capacity = Math.max(1, Number(opts.capacity || 5));
  const refillMs = Math.max(1, Number(opts.refillMs || 10_000));
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();
  const objectBuckets = new WeakMap<object, TokenBucket>();
  const primitiveBuckets = new Map<string | number | symbol, TokenBucket>();
  const maxPrimitiveSubjects = Math.max(1, Number(opts.maxPrimitiveSubjects || 1_000));

  return function checkRateLimit(subject: unknown): RateLimitDecision {
    if (subject === null || subject === undefined) return false;
    const isObjectSubject = typeof subject === "object" || typeof subject === "function";
    const isPrimitiveSubject = typeof subject === "string" || typeof subject === "number" || typeof subject === "symbol";
    if (!isObjectSubject && !isPrimitiveSubject) return false;
    const objectKey = subject as object;
    const primitiveKey = subject as string | number | symbol;
    let bucket = isObjectSubject
      ? objectBuckets.get(objectKey)
      : primitiveBuckets.get(primitiveKey);
    if (!bucket) {
      bucket = { tokens: capacity, lastRefill: now() };
      if (!isObjectSubject && primitiveBuckets.size >= maxPrimitiveSubjects) {
        const oldest = primitiveBuckets.keys().next().value;
        if (oldest !== undefined) primitiveBuckets.delete(oldest);
      }
      if (isObjectSubject) objectBuckets.set(objectKey, bucket);
      else primitiveBuckets.set(primitiveKey, bucket);
    } else if (!isObjectSubject) {
      primitiveBuckets.delete(primitiveKey);
      primitiveBuckets.set(primitiveKey, bucket);
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
