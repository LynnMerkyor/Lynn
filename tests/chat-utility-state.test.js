import { describe, expect, it } from "vitest";
import { createEditRollbackStore } from "../server/chat/edit-rollback-store.js";
import { createTokenBucketRateLimiter } from "../server/chat/rate-limit.js";

describe("chat utility state", () => {
  it("rate limits per websocket-like subject and refills over time", () => {
    let now = 0;
    const check = createTokenBucketRateLimiter({ capacity: 2, refillMs: 1000, now: () => now });
    const firstClient = {};
    const secondClient = {};

    expect(check(firstClient)).toBe(true);
    expect(check(firstClient)).toBe(true);
    expect(check(firstClient)).toBe(false);
    expect(check(secondClient)).toBe(true);

    now = 1000;
    expect(check(firstClient)).toBe(true);
    expect(check(firstClient)).toBe(true);
    expect(check(firstClient)).toBe(false);
  });

  it("finalizes edit rollback snapshots and evicts the oldest entries", () => {
    const store = createEditRollbackStore({ maxSnapshots: 2 });
    store.setPending("a", { sessionPath: "/s1.jsonl", filePath: "/tmp/a.js", originalContent: "a" });
    store.setPending("b", { sessionPath: "/s1.jsonl", filePath: "/tmp/b.js", originalContent: "b" });
    store.setPending("c", { sessionPath: "/s2.jsonl", filePath: "/tmp/c.js", originalContent: "c" });

    expect(store.pendingCount()).toBe(3);
    expect(store.finalize("a")).toMatchObject({ rollbackId: "a", originalContent: "a" });
    expect(store.finalize("b")).toMatchObject({ rollbackId: "b", originalContent: "b" });
    expect(store.finalize("c")).toMatchObject({ rollbackId: "c", originalContent: "c" });
    expect(store.get("a")).toBeNull();
    expect(store.get("b")).toMatchObject({ originalContent: "b" });
    expect(store.get("c")).toMatchObject({ originalContent: "c" });
  });

  it("discards pending rollback snapshots by session and stream token", () => {
    const store = createEditRollbackStore();
    store.setPending("a", { sessionPath: "/s.jsonl", streamToken: "one" });
    store.setPending("b", { sessionPath: "/s.jsonl", streamToken: "two" });
    store.setPending("c", { sessionPath: "/other.jsonl", streamToken: "one" });

    expect(store.discardPendingForSession("/s.jsonl", "one")).toBe(1);
    expect(store.pendingCount()).toBe(2);
    expect(store.discardPendingForSession("/s.jsonl")).toBe(1);
    expect(store.pendingCount()).toBe(1);
  });
});
