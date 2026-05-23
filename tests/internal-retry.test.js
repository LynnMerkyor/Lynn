import { describe, expect, it, vi } from "vitest";
import {
  canScheduleInternalRetry,
  internalRetryCount,
  markInternalRetry,
  prepareInternalRetryStream,
  scheduleInternalRetry,
} from "../server/chat/internal-retry.js";

describe("internal retry compatibility shim", () => {
  it("never schedules hidden model retries", () => {
    const hub = { send: vi.fn() };
    const scheduled = scheduleInternalRetry({
      sessionPath: "/sessions/current.jsonl",
      reason: "empty_reply",
      retryPrompt: "请重新回答",
      getState: vi.fn(),
      broadcast: vi.fn(),
      hub,
      engine: {},
    });

    expect(scheduled).toBe(false);
    expect(hub.send).not.toHaveBeenCalled();
  });

  it("keeps legacy counters inert", () => {
    const ss = { internalRetryCounts: { empty_reply: 2 } };
    expect(internalRetryCount(ss, "empty_reply")).toBe(0);
    expect(canScheduleInternalRetry(ss, "empty_reply")).toBe(false);
    expect(markInternalRetry(ss, "empty_reply")).toBe(false);
    expect(prepareInternalRetryStream("/tmp/session.jsonl", ss, "empty_reply")).toBeNull();
  });
});
