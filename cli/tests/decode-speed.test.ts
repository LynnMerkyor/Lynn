import { describe, expect, it } from "vitest";
import { createDecodeSpeedTracker, estimateDecodeTokens } from "../src/decode-speed.js";

describe("decode speed", () => {
  it("estimates CJK and latin decode tokens conservatively", () => {
    expect(estimateDecodeTokens("你好世界")).toBe(4);
    expect(estimateDecodeTokens("hello world")).toBe(3);
  });

  it("renders recent decode TPS from streamed deltas", () => {
    const tracker = createDecodeSpeedTracker(1000);
    expect(tracker.add("hello", 1000)).toBe("8.00 TPS");
    expect(tracker.add(" world", 2000)).toBe("4.00 TPS");
  });
});
