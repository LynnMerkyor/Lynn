import { describe, expect, it, vi } from "vitest";
import { createPromptTurnRunner } from "../server/chat/prompt-turn-runner.js";
import { createChatTurnState } from "../server/chat/turn-state.js";
import { resetCompletedTurnState } from "../server/chat/stream-state.js";
import { finishSessionStream } from "../server/session-stream-store.js";
import { createWsControlHandler } from "../server/chat/ws-control-handler.js";
import { buildReportResearchContext } from "../server/chat/report-research-context.js";

vi.mock("../server/chat/report-research-context.js", async importOriginal => ({
  ...await importOriginal<typeof import("../server/chat/report-research-context.js")>(),
  buildReportResearchContext: vi.fn(),
  buildDirectResearchAnswer: vi.fn(() => ""),
}));

describe("prompt prefetch cancellation", () => {
  it("closes promptly, accepts another turn, and ignores late prefetch results", async () => {
    let resolveResearch!: (text: string) => void;
    vi.mocked(buildReportResearchContext).mockImplementationOnce(() => new Promise(resolve => { resolveResearch = resolve; }));
    const ss = createChatTurnState();
    const events: any[] = [];
    const engine = { getSessionByPath: () => null, isSessionStreaming: () => false, currentSessionPath: "/missing/cancel-test.jsonl" };
    const hub = { send: vi.fn(async () => undefined), abort: vi.fn() };
    const close = vi.fn(() => { finishSessionStream(ss); resetCompletedTurnState(ss); });
    const noop = vi.fn();
    const runner = createPromptTurnRunner({
      engine, hub, lifecycleHooks: { run: noop }, broadcast: noop,
      emitStreamEvent: (_path, _ss, event) => events.push(event),
      closeStreamAfterError: close, closeStreamWithVisibleFallback: vi.fn(() => true),
      finalizeReturnedTurnWithoutStream: vi.fn(() => false),
      fallbackLocalQwen35DirectToBrain: vi.fn(async () => false),
      startLocalQwen35PrefetchFeedback: () => noop,
      streamLocalQwen35DirectBridge: vi.fn(),
      schedulePersistedFinalAnswerPoll: vi.fn(() => false),
      scheduleReturnedTurnFinalizationFallback: vi.fn(() => false),
      scheduleSilentBrainAbort: noop, scheduleToolFinalizationFallback: noop,
      scheduleTurnHardAbort: noop, clearTurnTimers: noop,
      hasStreamEvent: () => false, hasToolExecutionInFlight: () => false,
    });
    const options = { ws: { send: noop }, msg: {}, ss, promptSessionPath: engine.currentSessionPath };
    const first = runner({ ...options, promptText: "杭州明天天气" });
    await vi.waitFor(() => expect(buildReportResearchContext).toHaveBeenCalled());
    const abort = createWsControlHandler({ engine, hub, sessionState: { get: () => ss }, broadcast: noop });
    await abort({ type: "abort" }, {});
    await first;
    expect(close).toHaveBeenCalledOnce();
    expect(ss.isStreaming).toBe(false);
    expect(hub.send).not.toHaveBeenCalled();

    await runner({ ...options, promptText: "请写一句关于海风的诗。" });
    expect(hub.send).toHaveBeenCalledOnce();
    const eventCount = events.length;
    resolveResearch("late evidence that must not start another model turn");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(hub.send).toHaveBeenCalledOnce();
    expect(events).toHaveLength(eventCount);
    expect(close).toHaveBeenCalledOnce();
    expect(ss.isStreaming).toBe(true);
  });
});
