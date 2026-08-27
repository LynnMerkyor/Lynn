import { describe, expect, it, vi } from "vitest";

import { createLocalModelBridge } from "../server/chat/local-model-bridge.js";

describe("local model bridge", () => {
  it("falls back through a one-turn Brain override without switching the session model", async () => {
    const switchCurrentSessionModel = vi.fn();
    const brainModel = {
      id: "brain-router",
      provider: "brain",
      api: "openai-completions",
      baseUrl: "https://brain.example.test/v1",
    };
    const hub = { send: vi.fn(async () => undefined) };
    const emitted = [];
    const bridge = createLocalModelBridge({
      engine: { currentSessionPath: "/tmp/session.jsonl", _sessionCoord: { switchCurrentSessionModel } },
      hub,
      lifecycleHooks: { run: vi.fn() },
      broadcast: vi.fn(),
      emitStreamEvent: (_sessionPath, _ss, event) => emitted.push(event),
      feedAssistantVisibleText: vi.fn(),
      flushBufferedAssistantText: vi.fn(),
      maybeAppendCodeVerificationPostscript: vi.fn(),
      resolveBrainFallbackModel: () => brainModel,
      hasToolExecutionInFlight: () => false,
      scheduleSilentBrainAbort: vi.fn(),
      scheduleToolFinalizationFallback: vi.fn(),
      scheduleReturnedTurnFinalizationFallback: vi.fn(),
      finalizeReturnedTurnWithoutStream: () => false,
    });
    const ss = { hasOutput: false, hasThinking: false, isStreaming: true };

    await expect(bridge.fallbackLocalQwen35DirectToBrain({
      sessionPath: "/tmp/session.jsonl",
      ss,
      promptText: "hello",
      effectivePromptText: "hello",
      modelInfo: { provider: "local-llamacpp" },
      msg: {},
      streamToken: "stream-1",
      disableTools: false,
      turnInstruction: "",
      reason: "empty_response",
    })).resolves.toBe(true);

    expect(switchCurrentSessionModel).not.toHaveBeenCalled();
    expect(hub.send).toHaveBeenCalledWith("hello", expect.objectContaining({
      sessionPath: "/tmp/session.jsonl",
      streamToken: "stream-1",
      modelOverride: brainModel,
    }));
    expect(ss.streamSource).toBe("brain_fallback");
    expect(emitted).toContainEqual(expect.objectContaining({
      type: "provider_meta",
      activeProvider: "brain",
    }));
    expect(emitted.some((event) => event.type === "model_hint")).toBe(false);
  });
});
