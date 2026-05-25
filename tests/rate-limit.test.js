import { describe, expect, it } from "vitest";

import { createTokenBucketRateLimiter } from "../server/chat/rate-limit.js";

describe("token bucket rate limiter", () => {
  it("allows requests within capacity", () => {
    const check = createTokenBucketRateLimiter({ capacity: 3, refillMs: 10_000 });
    const subject = {};
    expect(check(subject)).toBe(true);
    expect(check(subject)).toBe(true);
    expect(check(subject)).toBe(true);
  });

  it("rejects requests when bucket is exhausted", () => {
    const check = createTokenBucketRateLimiter({ capacity: 2, refillMs: 10_000 });
    const subject = {};
    check(subject);
    check(subject);
    expect(check(subject)).toBe(false);
  });

  it("refills tokens after refill interval", () => {
    let time = 0;
    const check = createTokenBucketRateLimiter({ capacity: 2, refillMs: 1000, now: () => time });
    const subject = {};
    check(subject);
    check(subject);
    expect(check(subject)).toBe(false);

    time = 1000;
    expect(check(subject)).toBe(true);
  });

  it("returns false for non-object subjects", () => {
    const check = createTokenBucketRateLimiter();
    expect(check(null)).toBe(false);
    expect(check(undefined)).toBe(false);
    expect(check("string")).toBe(false);
    expect(check(42)).toBe(false);
  });

  it("tracks independent buckets per subject", () => {
    const check = createTokenBucketRateLimiter({ capacity: 1 });
    const subjectA = {};
    const subjectB = {};
    expect(check(subjectA)).toBe(true);
    expect(check(subjectA)).toBe(false);
    expect(check(subjectB)).toBe(true);
  });
});
