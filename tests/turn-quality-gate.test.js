import { describe, expect, it } from "vitest";

import {
  __turnQualityRulesForTest,
  createTurnQualitySnapshot,
  evaluateForcedTurnFallback,
  evaluatePostTurnEndQuality,
  evaluatePreTurnEndQuality,
} from "../server/chat/turn-quality-gate.js";

describe("turn quality gate compatibility shim", () => {
  it("does not register intervention rules", () => {
    expect(__turnQualityRulesForTest).toEqual([]);
  });

  it("still exposes a lightweight snapshot for diagnostics", () => {
    const snapshot = createTurnQualitySnapshot({
      hasToolCall: true,
      lastSuccessfulTools: [{ name: "weather" }],
    }, "可见文本");

    expect(snapshot.visibleTrimmed).toBe("可见文本");
    expect(snapshot.visibleLen).toBe(4);
    expect(snapshot.hasAnyToolCall).toBe(true);
    expect(snapshot.toolSuccessFallback).toBe("");
  });

  it("never retries or synthesizes fallback text", () => {
    const ss = {
      hasOutput: false,
      hasToolCall: false,
      hasThinking: false,
      hasError: false,
      routeIntent: "chat",
    };
    const snapshot = createTurnQualitySnapshot(ss, "");

    expect(evaluatePreTurnEndQuality(ss, snapshot, { isActive: true })).toBeNull();
    expect(evaluatePostTurnEndQuality(ss, snapshot, {})).toBeNull();
    expect(evaluateForcedTurnFallback(ss, snapshot, {})).toBeNull();
  });
});
