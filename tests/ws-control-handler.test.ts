import { describe, expect, it, vi } from "vitest";
import { createWsControlHandler } from "../server/chat/ws-control-handler.js";

describe("WS control abort", () => {
  it("marks the active turn as user-cancelled before aborting the hub", async () => {
    const state = { userAbortRequested: false };
    const hub = { abort: vi.fn(async () => undefined) };
    const handler = createWsControlHandler({
      engine: {
        currentSessionPath: "/tmp/current.jsonl",
        isSessionStreaming: vi.fn(() => true),
      },
      hub,
      sessionState: { get: vi.fn(() => state) },
      broadcast: vi.fn(),
    });

    await expect(handler({ type: "abort", sessionPath: "/tmp/current.jsonl" }, {})).resolves.toBe(true);
    expect(state.userAbortRequested).toBe(true);
    expect(hub.abort).toHaveBeenCalledWith("/tmp/current.jsonl");
  });
});
