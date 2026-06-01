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

  it("keeps a stable prefix-cache badge even before provider telemetry arrives", () => {
    const metrics = createRuntimeMetrics();

    recordDecodeTps(metrics, null);
    recordUsageMetrics(metrics, { total_tokens: 12 });

    expect(renderRuntimeMetrics(metrics)).toBe("prefix-cache hit tracking");
  });

  it("shows prefix-cache as warming before any usage telemetry arrives", () => {
    const metrics = createRuntimeMetrics();

    expect(renderRuntimeMetrics(metrics)).toBe("prefix-cache warming");
  });
});
