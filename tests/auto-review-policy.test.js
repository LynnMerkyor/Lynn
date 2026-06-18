import { afterEach, describe, expect, it } from "vitest";

import {
  decideAutoReviewTurn,
  scheduleAutoReviewForTurn,
} from "../server/chat/auto-review.js";

function makeState(overrides = {}) {
  return {
    visibleTextAcc: "",
    realtimeToolFallbackText: "",
    hasOutput: false,
    hasToolCall: false,
    hasPrefetchToolCall: false,
    successfulToolCount: 0,
    lastSuccessfulTools: [],
    hasFailedTool: false,
    lastFailedTools: [],
    autoReviewStarted: false,
    ...overrides,
  };
}

describe("auto review policy", () => {
  afterEach(() => {
    delete process.env.LYNN_AUTO_REVIEW;
    delete process.env.LYNN_AUTO_REVIEW_ALWAYS;
  });

  it("requests background Hanako review for market and realtime tool evidence", () => {
    const decision = decideAutoReviewTurn({
      mode: "background",
      sourceText: "NVDA 最新报价 $205.19。",
      ss: makeState({
        hasOutput: true,
        lastSuccessfulTools: [
          {
            name: "stock_market",
            command: "英伟达股价",
            outputPreview: "NVDA 205.19",
          },
        ],
        successfulToolCount: 1,
      }),
    });

    expect(decision.shouldReview).toBe(true);
    expect(decision.mode).toBe("background");
    expect(decision.reasons).toEqual(expect.arrayContaining([
      "tool_evidence",
      "high_risk_tool",
      "time_sensitive_or_market",
    ]));
    expect(decision.context).toContain("Hanako · DS V4");
    expect(decision.context).toContain("NVDA 205.19");
  });

  it("does not review ordinary small talk without tools by default", () => {
    const decision = decideAutoReviewTurn({
      mode: "background",
      sourceText: "你好，我在。",
      ss: makeState({ hasOutput: true }),
    });

    expect(decision.shouldReview).toBe(false);
    expect(decision.reasons).toEqual([]);
  });

  it("requests background review for source-grade business research even when the answer is not empty", () => {
    const decision = decideAutoReviewTurn({
      mode: "background",
      sourceText: "公开资料显示，某私董会收费 13.8 万元/人，但人数规模未查到。",
      ss: makeState({
        hasOutput: true,
        lastSuccessfulTools: [
          {
            name: "web_search",
            command: "中国主要私董会的人数，收费",
            outputPreview: "运河私董会 学费 138000",
          },
        ],
        successfulToolCount: 1,
      }),
    });

    expect(decision.shouldReview).toBe(true);
    expect(decision.reasons).toEqual(expect.arrayContaining([
      "tool_evidence",
      "high_risk_tool",
      "time_sensitive_or_market",
    ]));
    expect(decision.context).toContain("中国主要私董会的人数，收费");
  });

  it("requests background review for prediction and probability claims", () => {
    const decision = decideAutoReviewTurn({
      mode: "background",
      sourceText: "西班牙是世界杯夺冠概率最高的队伍。",
      ss: makeState({ hasOutput: true }),
    });

    expect(decision.shouldReview).toBe(true);
    expect(decision.reasons).toContain("time_sensitive_or_market");
  });

  it("always reviews fallback turns so empty answers get a visible safety net", () => {
    const decision = decideAutoReviewTurn({
      mode: "fallback",
      reason: "empty_turn_without_visible_answer",
      sourceText: "",
      ss: makeState(),
    });

    expect(decision.shouldReview).toBe(true);
    expect(decision.mode).toBe("fallback");
    expect(decision.reasons).toEqual(expect.arrayContaining([
      "empty_turn_without_visible_answer",
      "fallback_visible_answer",
      "empty_answer_guard",
    ]));
    expect(decision.context).toContain("(无可见主回答)");
  });

  it("honors the disable switch before scheduling background work", () => {
    process.env.LYNN_AUTO_REVIEW = "0";
    const ss = makeState({
      hasOutput: true,
      lastSuccessfulTools: [
        { name: "web_search", command: "世界杯赛程", outputPreview: "4 场比赛" },
      ],
      successfulToolCount: 1,
    });

    const scheduled = scheduleAutoReviewForTurn({
      engine: {},
      broadcast: () => undefined,
      sessionPath: "/tmp/session.jsonl",
      ss,
      sourceText: "今晚有 4 场比赛。",
    });

    expect(scheduled).toBe(false);
    expect(ss.autoReviewStarted).toBe(false);
  });

  it("can be forced for diagnostic runs", () => {
    process.env.LYNN_AUTO_REVIEW_ALWAYS = "1";
    const decision = decideAutoReviewTurn({
      mode: "background",
      sourceText: "普通回答。",
      ss: makeState({ hasOutput: true }),
    });

    expect(decision.shouldReview).toBe(true);
    expect(decision.reasons).toContain("forced");
  });
});
