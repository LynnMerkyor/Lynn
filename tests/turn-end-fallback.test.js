import { describe, expect, it } from "vitest";

import { resolveTurnEndFallback } from "../server/chat/turn-end-fallback.js";

describe("turn_end fallback matrix", () => {
  it("closes reasoning-only output with a visible explanation", () => {
    expect(resolveTurnEndFallback(
      { hasOutput: false, hasThinking: true, hasError: false },
      { hasToolEvidence: false },
    )).toMatchObject({ reason: "reasoning_only_without_visible_answer" });
  });

  it("replaces a short fragment after a large hidden-reasoning budget", () => {
    const result = resolveTurnEndFallback({
      hasOutput: true,
      hasThinking: true,
      hasError: false,
      visibleTextAcc: "结论是",
      events: [{ event: { type: "thinking_delta", delta: "思".repeat(800) } }],
    }, { hasToolEvidence: false });

    expect(result).toMatchObject({
      reason: "short_visible_after_hidden_reasoning",
      appendEvenIfHasOutput: true,
    });
  });

  it("closes a completely empty turn", () => {
    expect(resolveTurnEndFallback(
      { hasOutput: false, hasThinking: false, hasError: false },
      { hasToolEvidence: false },
    )).toMatchObject({ reason: "empty_turn_without_visible_answer" });
  });

  it("uses completed tool evidence when the writer returns no final text", () => {
    expect(resolveTurnEndFallback(
      { hasOutput: false, hasThinking: true, hasError: false },
      { hasToolEvidence: true, toolFallbackText: "天气工具已返回深圳 30°C。" },
    )).toEqual({
      reason: "tool_turn_end_without_visible_answer",
      text: "天气工具已返回深圳 30°C。",
    });
  });

  it("does not override normal visible answers or explicit errors", () => {
    expect(resolveTurnEndFallback(
      { hasOutput: true, visibleTextAcc: "完整答案", hasError: false },
      { hasToolEvidence: false },
    )).toBeNull();
    expect(resolveTurnEndFallback(
      { hasOutput: false, hasError: true },
      { hasToolEvidence: false },
    )).toBeNull();
  });
});
