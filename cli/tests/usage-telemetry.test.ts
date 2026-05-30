import { describe, expect, it } from "vitest";
import { normalizeUsageTelemetry, renderUsageTelemetry } from "../src/usage-telemetry.js";

describe("usage telemetry normalization", () => {
  it("normalizes DeepSeek prompt cache hit/miss fields", () => {
    const telemetry = normalizeUsageTelemetry({
      prompt_tokens: 1000,
      completion_tokens: 80,
      total_tokens: 1080,
      prompt_cache_hit_tokens: 750,
      prompt_cache_miss_tokens: 250,
    }, { durationMs: 2000 });

    expect(telemetry).toMatchObject({
      promptTokens: 1000,
      completionTokens: 80,
      totalTokens: 1080,
      cacheHitTokens: 750,
      cacheMissTokens: 250,
      cacheHitRatio: 0.75,
      tps: 40,
    });
    expect(renderUsageTelemetry(telemetry)).toBe("1080 tokens · in 1000 · out 80 · cache 750 · miss 250 (75%) · 40.0 TPS");
  });

  it("normalizes OpenAI nested cached token fields", () => {
    const telemetry = normalizeUsageTelemetry({
      prompt_tokens: 900,
      completion_tokens: 50,
      prompt_tokens_details: { cached_tokens: 600 },
    }, { durationMs: 1000 });

    expect(telemetry?.cacheHitTokens).toBe(600);
    expect(telemetry?.cacheHitRatio).toBeCloseTo(600 / 900);
    expect(renderUsageTelemetry(telemetry)).toContain("cache 600 (67%)");
  });

  it("normalizes Anthropic-style cache read/write fields", () => {
    const telemetry = normalizeUsageTelemetry({
      input_tokens: 1200,
      output_tokens: 120,
      cache_read_input_tokens: 960,
      cache_creation_input_tokens: 240,
      duration_ms: 3000,
    });

    expect(telemetry).toMatchObject({
      promptTokens: 1200,
      completionTokens: 120,
      cacheHitTokens: 960,
      cacheMissTokens: 240,
      cacheWriteTokens: 240,
      cacheHitRatio: 0.8,
      tps: 40,
    });
    expect(renderUsageTelemetry(telemetry)).toBe("1320 tokens · in 1200 · out 120 · cache 960 · miss 240 (80%) · 40.0 TPS");
  });

  it("returns null for non-usage payloads", () => {
    expect(normalizeUsageTelemetry({ foo: "bar" })).toBeNull();
    expect(renderUsageTelemetry(null)).toBeNull();
  });
});
