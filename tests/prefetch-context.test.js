import { describe, expect, it } from "vitest";
import { shouldPrefetchReportContext } from "../server/chat/prefetch-context.js";

describe("prefetch context policy", () => {
  it("does not inject local realtime prefetch context for Brain V2", () => {
    expect(shouldPrefetchReportContext("market", { isBrain: true })).toBe(false);
    expect(shouldPrefetchReportContext("weather", { isBrain: true })).toBe(false);
    expect(shouldPrefetchReportContext("news", { isBrain: true })).toBe(false);
  });

  it("keeps local prefetch for non-Brain realtime turns", () => {
    expect(shouldPrefetchReportContext("market", { isBrain: false })).toBe(true);
    expect(shouldPrefetchReportContext("weather", null)).toBe(true);
  });
});
