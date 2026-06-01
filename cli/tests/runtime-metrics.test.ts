import { describe, expect, it } from "vitest";
import { createRuntimeMetrics, recordDecodeTps, recordUsageMetrics, renderRuntimeMetrics } from "../src/runtime-metrics.js";

describe("runtime metrics", () => {
  it("keeps rolling decode TPS and prefix-cache hit ratio for the status bar", () => {
    const metrics = createRuntimeMetrics();

    recordDecodeTps(metrics, "100 TPS");
    recordDecodeTps(metrics, "300 TPS");
    recordUsageMetrics(metrics, {
      prompt_cache_hit_tokens: 80,
      prompt_cache_miss_tokens: 20,
    });
    recordUsageMetrics(metrics, {
      prompt_cache_hit_tokens: 60,
      prompt_cache_miss_tokens: 40,
    });

    expect(renderRuntimeMetrics(metrics)).toBe("avg decode 200 TPS · prefix-cache 70% recent");
  });

  it("ignores missing telemetry instead of showing diagnostics in the UI", () => {
    const metrics = createRuntimeMetrics();

    recordDecodeTps(metrics, null);
    recordUsageMetrics(metrics, { total_tokens: 12 });

    expect(renderRuntimeMetrics(metrics)).toBeNull();
  });
});
