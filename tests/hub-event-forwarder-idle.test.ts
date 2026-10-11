import { describe, expect, it, vi } from "vitest";
import { createHubEventForwarder } from "../server/chat/hub-event-forwarder.js";

describe("tool finalization idle timer", () => {
  function setup() {
    const state = { isStreaming: true, activeStreamToken: "current", toolFinalizationTimer: 1 };
    const schedule = vi.fn();
    const subscribe = vi.fn();
    createHubEventForwarder({
      hub: { subscribe },
      engine: { currentSessionPath: "session" },
      sessionState: new Map([["session", state]]),
      editRollbackStore: {},
      lifecycleHooks: {},
      broadcast: vi.fn(),
      emitStreamEvent: vi.fn(),
      feedAssistantVisibleText: vi.fn(),
      flushBufferedAssistantText: vi.fn(),
      maybeAppendCodeVerificationPostscript: vi.fn(),
      maybeGenerateFirstTurnTitle: vi.fn(),
      buildRealtimeToolFallbackText: vi.fn(),
      closeStreamAfterError: vi.fn(),
      closeStreamWithVisibleFallback: vi.fn(),
      scheduleToolAuthorizationFallback: vi.fn(),
      scheduleToolFinalizationFallback: schedule,
      hasStreamEvent: vi.fn(() => false),
      hasToolExecutionInFlight: vi.fn(() => false),
    });
    return { state, schedule, forward: subscribe.mock.calls[0][0] };
  }

  it.each(["text_delta", "thinking_delta"])("rearms an existing idle timer on nonempty %s", (type) => {
    const { state, schedule, forward } = setup();
    forward({ type: "message_update", assistantMessageEvent: { type, delta: "progress" } }, "session");
    expect(schedule).toHaveBeenCalledWith("session", state);
  });

  it.each(["text_delta", "thinking_delta"])("does not extend a silent turn for empty %s", (type) => {
    const { schedule, forward } = setup();
    forward({ type: "message_update", assistantMessageEvent: { type, delta: "" } }, "session");
    expect(schedule).not.toHaveBeenCalled();
  });

  it("does not rearm for stale events or start a timer before a tool turn", () => {
    const { state, schedule, forward } = setup();
    const event = { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "progress" } };
    forward({ ...event, _hubContext: { streamToken: "old" } }, "session");
    state.toolFinalizationTimer = 0;
    forward(event, "session");
    expect(schedule).not.toHaveBeenCalled();
  });
});
