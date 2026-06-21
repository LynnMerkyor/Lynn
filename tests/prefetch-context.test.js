import { describe, expect, it } from "vitest";
import { shouldPrefetchReportContext } from "../server/chat/prefetch-context.js";

describe("prefetch context policy", () => {
  it("keeps deterministic realtime prefetch context for Brain V2", () => {
    expect(shouldPrefetchReportContext("market", { isBrain: true })).toBe(true);
    expect(shouldPrefetchReportContext("weather", { isBrain: true })).toBe(true);
    expect(shouldPrefetchReportContext("sports", { isBrain: true })).toBe(true);
    expect(shouldPrefetchReportContext("market_weather_brief", { isBrain: true })).toBe(true);
    expect(shouldPrefetchReportContext("news", { isBrain: true })).toBe(true);
    expect(shouldPrefetchReportContext("public_data", { isBrain: true })).toBe(true);
  });

  it("does not inject open-ended local research context for Brain V2", () => {
    expect(shouldPrefetchReportContext("generic", { isBrain: true })).toBe(false);
  });

  it("keeps local prefetch for non-Brain realtime turns", () => {
    expect(shouldPrefetchReportContext("market", { isBrain: false })).toBe(true);
    expect(shouldPrefetchReportContext("weather", null)).toBe(true);
  });
});
