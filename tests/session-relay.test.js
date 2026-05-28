import { describe, expect, it } from "vitest";
import {
  formatRelaySummaryContext,
  resolveSessionRelayConfig,
} from "../core/session-relay.js";

describe("session relay helpers", () => {
  it("uses smaller auto-relay thresholds for smaller context windows", () => {
    expect(resolveSessionRelayConfig({}, { contextWindow: 8_000 }).compactionThreshold).toBe(1);
    expect(resolveSessionRelayConfig({}, { contextWindow: 24_000 }).compactionThreshold).toBe(2);
    expect(resolveSessionRelayConfig({}, { contextWindow: 64_000 }).compactionThreshold).toBe(3);
  });

  it("lets explicit preferences override defaults", () => {
    expect(resolveSessionRelayConfig({
      enabled: false,
      compaction_threshold: 7,
      summary_max_tokens: 1200,
    }, { contextWindow: 8_000 })).toMatchObject({
      enabled: false,
      compactionThreshold: 7,
      summaryMaxTokens: 1200,
    });
  });

  it("formats localized relay context without overlong summaries", () => {
    const zh = formatRelaySummaryContext("继续做 A", "zh-CN");
    expect(zh).toContain("自动接力摘要");
    expect(zh).toContain("继续做 A");

    const en = formatRelaySummaryContext("x".repeat(4100), "en-US");
    expect(en).toContain("Automatic Session Relay Summary");
    expect(en.length).toBeLessThan(4300);
  });
});
