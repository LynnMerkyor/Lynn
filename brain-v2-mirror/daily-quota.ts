type Clock = () => Date;

export function parseDailyLimit(value: unknown, fallback: number): number {
  const raw = value === undefined || value === null ? '' : String(value).trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function createDailyQuota(options: { limit: number; now?: Clock }) {
  const now = options.now || (() => new Date());
  const buckets = new Map<string, { day: string; count: number }>();

  function currentUtcDay(): string {
    return now().toISOString().slice(0, 10);
  }

  return {
    consume(key: string): boolean {
      if (options.limit <= 0) return true;
      const bucketKey = key || 'unknown';
      const day = currentUtcDay();
      const bucket = buckets.get(bucketKey);
      if (!bucket || bucket.day !== day) {
        buckets.set(bucketKey, { day, count: 1 });
        return true;
      }
      if (bucket.count >= options.limit) return false;
      bucket.count += 1;
      return true;
    },
    reset(): void {
      buckets.clear();
    },
    snapshot(): Record<string, { day: string; count: number }> {
      return Object.fromEntries(buckets.entries());
    },
  };
}

