import { describe, expect, it, vi } from "vitest";

import { createStreamEmitters } from "../server/chat/stream-emitters.js";
import { createChatTurnState } from "../server/chat/turn-state.js";

function makeHarness(overrides = {}) {
  const broadcast = vi.fn();
  const scheduleToolFinalizationFallback = vi.fn();
  const clearToolFinalizationTimer = vi.fn();
  const maybeGenerateFirstTurnTitle = vi.fn();

  const emitters = createStreamEmitters({
    broadcast,
    hasStreamEvent: (ss, type) => Array.isArray(ss?.events) && ss.events.some((entry) => entry?.event?.type === type),
    hasToolExecutionInFlight: (ss) => Number(ss?.activeToolCallCount || 0) > 0 || !!ss?.recoveredBashInFlight,
    scheduleToolFinalizationFallback,
    clearToolFinalizationTimer,
    maybeGenerateFirstTurnTitle,
    ...overrides,
  });

  return {
    ss: createChatTurnState(),
    broadcast,
    scheduleToolFinalizationFallback,
    clearToolFinalizationTimer,
    maybeGenerateFirstTurnTitle,
    emitters,
  };
}

describe("chat stream emitters", () => {
  it("emits visible text deltas and updates title/visible accumulators", () => {
    const { ss, broadcast, clearToolFinalizationTimer, maybeGenerateFirstTurnTitle, emitters } = makeHarness();

    emitters.emitVisibleTextDelta("/tmp/session.jsonl", ss, "你好");

    expect(ss.hasOutput).toBe(true);
    expect(ss.titlePreview).toBe("你好");
    expect(ss.visibleTextAcc).toBe("你好");
    expect(clearToolFinalizationTimer).toHaveBeenCalledWith(ss);
    expect(maybeGenerateFirstTurnTitle).toHaveBeenCalledWith("/tmp/session.jsonl", ss);
    expect(ss.events.at(-1)?.event).toEqual({ type: "text_delta", delta: "你好" });
    expect(broadcast).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "text_delta",
      delta: "你好",
      sessionPath: "/tmp/session.jsonl",
      seq: 1,
    }));
  });

  it("trusted visible text bypasses in-flight tool buffering", () => {
    const { ss, broadcast, maybeGenerateFirstTurnTitle, emitters } = makeHarness();
    ss.activeToolCallCount = 1;

    const emitted = emitters.emitTrustedVisibleTextDelta("/tmp/session.jsonl", ss, "最终答案");

    expect(emitted).toBe(true);
    expect(ss.bufferedVisibleTextDuringTool).toBe("");
    expect(ss.hasBufferedVisibleTextDuringTool).toBe(false);
    expect(ss.visibleTextAcc).toBe("最终答案");
    expect(maybeGenerateFirstTurnTitle).toHaveBeenCalledWith("/tmp/session.jsonl", ss);
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
      type: "text_delta",
      delta: "最终答案",
      sessionPath: "/tmp/session.jsonl",
    }));
  });

  it("trusted visible text strips pseudo-tool markup without withholding recovered content", () => {
    const { ss, broadcast, emitters } = makeHarness();

    const emitted = emitters.emitTrustedVisibleTextDelta(
      "/tmp/session.jsonl",
      ss,
      "<tool_call>bash\nrm delete-me.txt && ls\n",
    );

    expect(emitted).toBe(true);
    expect(ss.visibleTextAcc).toContain("rm delete-me.txt && ls");
    expect(ss.visibleTextAcc).not.toContain("<tool_call>");
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
      type: "text_delta",
      delta: expect.stringContaining("rm delete-me.txt && ls"),
      sessionPath: "/tmp/session.jsonl",
    }));
  });

  it("preserves provider metadata and status event payloads", () => {
    const { ss, broadcast, emitters } = makeHarness();
    const providerEvent = {
      type: "provider_meta",
      active_provider: "apex-spark-i-balanced",
      fallback_from: [{ id: "step-3.7-flash", reason: "cooldown" }],
    };
    const statusEvent = { type: "status", isStreaming: true, detail: "fallback-warm" };

    emitters.emitStreamEvent("/tmp/session.jsonl", ss, providerEvent);
    emitters.emitStreamEvent("/tmp/session.jsonl", ss, statusEvent);

    expect(ss.events.map((entry) => entry.event)).toEqual([providerEvent, statusEvent]);
    expect(broadcast).toHaveBeenNthCalledWith(1, expect.objectContaining({
      ...providerEvent,
      sessionPath: "/tmp/session.jsonl",
      seq: 1,
    }));
    expect(broadcast).toHaveBeenNthCalledWith(2, expect.objectContaining({
      ...statusEvent,
      sessionPath: "/tmp/session.jsonl",
      seq: 2,
    }));
  });

  it("buffers visible text while a tool is in flight and flushes it later", () => {
    const { ss, broadcast, scheduleToolFinalizationFallback, emitters } = makeHarness();
    ss.activeToolCallCount = 1;

    emitters.emitVisibleTextDelta("/tmp/session.jsonl", ss, "工具后正文");

    expect(broadcast).not.toHaveBeenCalled();
    expect(ss.bufferedVisibleTextDuringTool).toBe("工具后正文");
    expect(ss.hasBufferedVisibleTextDuringTool).toBe(true);
    expect(scheduleToolFinalizationFallback).toHaveBeenCalledWith("/tmp/session.jsonl", ss);

    ss.activeToolCallCount = 0;
    const flushed = emitters.flushBufferedToolVisibleText("/tmp/session.jsonl", ss);

    expect(flushed).toBe(true);
    expect(ss.bufferedVisibleTextDuringTool).toBe("");
    expect(ss.hasBufferedVisibleTextDuringTool).toBe(false);
    expect(ss.hasOutput).toBe(true);
    expect(ss.visibleTextAcc).toBe("工具后正文");
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
      type: "text_delta",
      delta: "工具后正文",
      sessionPath: "/tmp/session.jsonl",
    }));
  });

  it("suppresses pseudo tool markup before broadcasting visible text", () => {
    const { ss, broadcast, emitters } = makeHarness();

    emitters.emitVisibleTextDelta(
      "/tmp/session.jsonl",
      ss,
      "<tool_call>\n<function=bash>\n<parameter=command>find /Users/lynn/Desktop -name '*.md'</parameter>\n</function>\n</tool_call>\n我来读取文件。",
    );

    expect(ss.visibleTextAcc).toBe("我来读取文件。");
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
      type: "text_delta",
      delta: "我来读取文件。",
      sessionPath: "/tmp/session.jsonl",
    }));
  });
});
