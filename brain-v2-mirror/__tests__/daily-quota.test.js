import { describe, expect, it } from 'vitest';
import { createDailyQuota, parseDailyLimit } from '../daily-quota.js';

describe('daily quota', () => {
  it('treats zero and negative limits as disabled', () => {
    const quota = createDailyQuota({ limit: 0 });
    expect(Array.from({ length: 10 }, () => quota.consume('203.0.113.9')).every(Boolean)).toBe(true);

    const negative = createDailyQuota({ limit: -1 });
    expect(Array.from({ length: 10 }, () => negative.consume('203.0.113.9')).every(Boolean)).toBe(true);
  });

  it('limits each key independently', () => {
    const quota = createDailyQuota({ limit: 2, now: () => new Date('2026-06-12T00:00:00Z') });
    expect(quota.consume('203.0.113.9')).toBe(true);
    expect(quota.consume('203.0.113.9')).toBe(true);
    expect(quota.consume('203.0.113.9')).toBe(false);
    expect(quota.consume('198.51.100.7')).toBe(true);
  });

  it('resets buckets on a new UTC day', () => {
    let day = '2026-06-12T00:00:00Z';
    const quota = createDailyQuota({ limit: 1, now: () => new Date(day) });
    expect(quota.consume('203.0.113.9')).toBe(true);
    expect(quota.consume('203.0.113.9')).toBe(false);
    day = '2026-06-13T00:00:00Z';
    expect(quota.consume('203.0.113.9')).toBe(true);
  });

  it('parses configured limits without breaking the 0 disables limit contract', () => {
    expect(parseDailyLimit(undefined, 0)).toBe(0);
    expect(parseDailyLimit('', 0)).toBe(0);
    expect(parseDailyLimit('0', 5)).toBe(0);
    expect(parseDailyLimit('300', 5)).toBe(300);
    expect(parseDailyLimit('not-a-number', 5)).toBe(5);
  });
});
