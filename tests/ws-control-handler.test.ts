import { describe, expect, it, vi } from "vitest";
import { createWsControlHandler } from "../server/chat/ws-control-handler.js";

describe("WS control abort", () => {
  it("cancels prefetch before the engine starts streaming without aborting another engine turn", async () => {
    const controller = new AbortController();
    const state = { isStreaming: true, userAbortRequested: false, turnAbortController: controller };
    const hub = { abort: vi.fn() };
    const handler = createWsControlHandler({
      engine: { currentSessionPath: "/other", isSessionStreaming: () => false },
      hub,
      sessionState: { get: path => path === "/prefetch" ? state : undefined },
      broadcast: vi.fn(),
    });
    await handler({ type: "abort", sessionPath: "/prefetch" }, {});
    expect(controller.signal.aborted).toBe(true);
    expect(state.userAbortRequested).toBe(true);
    expect(hub.abort).not.toHaveBeenCalled();
  });

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
