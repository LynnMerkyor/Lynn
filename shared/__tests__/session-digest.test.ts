import { describe, expect, it } from "vitest";
import {
  appendSessionInsight,
  consumeSessionInsights,
  mergeSessionDigest,
  normalizeSessionDigest,
  normalizeSessionInsights,
  unreadInsightCount,
} from "../session-digest.js";

describe("session digest and insights", () => {
  it("normalizes compact session digest cards", () => {
    const digest = normalizeSessionDigest({
      goal: "Stabilize V0.85.1",
      summary: "New kernel is passing gates.",
      decisions: ["Use topology memory"],
      todos: ["Ship map"],
      evidence: ["npm test"],
      updatedAt: "2026-06-22T00:00:00.000Z",
    });

    expect(digest).toMatchObject({
      objective: "Stabilize V0.85.1",
      summary: "New kernel is passing gates.",
      decisions: ["Use topology memory"],
      nextSteps: ["Ship map"],
      evidenceRefs: ["npm test"],
      updatedAt: "2026-06-22T00:00:00.000Z",
    });
  });

  it("merges digest patches and stamps updates", () => {
    const digest = mergeSessionDigest(
      { objective: "Old", decisions: ["A"], nextSteps: ["B"] },
      { summary: "Fresh" },
      new Date("2026-06-22T01:02:03.000Z"),
    );

    expect(digest).toMatchObject({
      objective: "Old",
      summary: "Fresh",
      decisions: ["A"],
      nextSteps: ["B"],
      updatedAt: "2026-06-22T01:02:03.000Z",
    });
  });

  it("appends and consumes insight inbox entries", () => {
    const now = new Date("2026-06-22T01:02:03.000Z");
    const insights = appendSessionInsight([], {
      id: "i1",
      source: "Hanako",
      content: "Review found a grounding risk.",
    }, now);

    expect(insights).toHaveLength(1);
    expect(unreadInsightCount(insights)).toBe(1);
    expect(normalizeSessionInsights(insights)[0]).toMatchObject({
      id: "i1",
      source: "Hanako",
      status: "unread",
      createdAt: "2026-06-22T01:02:03.000Z",
    });

    const consumed = consumeSessionInsights(insights, ["i1"], new Date("2026-06-22T02:00:00.000Z"));
    expect(consumed[0]).toMatchObject({
      id: "i1",
      status: "consumed",
      consumedAt: "2026-06-22T02:00:00.000Z",
    });
    expect(unreadInsightCount(consumed)).toBe(0);
  });
});
