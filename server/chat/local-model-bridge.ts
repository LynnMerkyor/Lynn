import { debugLog } from "../../lib/debug-log.js";
import {
  BRAIN_DEFAULT_MODEL_ID,
  BRAIN_PROVIDER_ID,
} from "../../shared/brain-provider.js";
import { finishSessionStream } from "../session-stream-store.js";
import {
  clearTurnTimers,
  resetCompletedTurnState,
} from "./stream-state.js";
import {
  appendNoThinkHintToLastUserMessage,
  buildLocalQwen35DirectMessages,
  LOCAL_QWEN35_DIRECT_ENDPOINT,
  LOCAL_QWEN35_DIRECT_MAX_TOKENS,
  LOCAL_QWEN35_EMPTY_CONTENT_FALLBACK_MESSAGE,
  resolveLocalQwen35DirectMaxTokens,
  shouldRetryLocalQwen35WithoutThinking,
} from "./local-qwen35-direct-policy.js";
import {
  LOCAL_QWEN35_MODEL_ID,
  LOCAL_QWEN35_PROVIDER_ID,
} from "./local-qwen35-bench-context.js";
import { streamLocalQwen35Completion } from "./local-qwen35-direct-runner.js";
import { persistLocalQwen35DirectTurn } from "./session-persistence.js";

export interface LocalModelBridgeDeps {
  engine: any;
  hub: any;
  lifecycleHooks: any;
  broadcast: (msg: any) => void;
  emitStreamEvent: (sessionPath: string, ss: any, event: any) => void;
  feedAssistantVisibleText: (sessionPath: string, ss: any, delta: string) => void;
  flushBufferedAssistantText: (sessionPath: string, ss: any) => void;
  maybeAppendCodeVerificationPostscript: (sessionPath: string, ss: any) => boolean;
  resolveBrainFallbackModel: (engine: any) => any;
  hasToolExecutionInFlight: (ss: any) => boolean;
  scheduleSilentBrainAbort: (sessionPath: string, ss: any) => void;
  scheduleToolFinalizationFallback: (sessionPath: string, ss: any) => void;
  scheduleReturnedTurnFinalizationFallback: (sessionPath: string, ss: any, reason: string) => void;
  finalizeReturnedTurnWithoutStream: (sessionPath: string, ss: any, reason: string, opts?: any) => boolean;
}

export function createLocalModelBridge({
  engine,
  hub,
  lifecycleHooks,
  broadcast,
  emitStreamEvent,
  feedAssistantVisibleText,
  flushBufferedAssistantText,
  maybeAppendCodeVerificationPostscript,
  resolveBrainFallbackModel,
  hasToolExecutionInFlight,
  scheduleSilentBrainAbort,
  scheduleToolFinalizationFallback,
  scheduleReturnedTurnFinalizationFallback,
  finalizeReturnedTurnWithoutStream,
}: LocalModelBridgeDeps) {
  function emitLocalThinkingDelta(sessionPath: any, ss: any, delta: any) {
    const text = String(delta || "");
    if (!text) return;
    if (!ss.isThinking) {
      ss.isThinking = true;
      ss.hasThinking = true;
      emitStreamEvent(sessionPath, ss, { type: "thinking_start" });
    }
    ss.hasThinking = true;
    emitStreamEvent(sessionPath, ss, { type: "thinking_delta", delta: text });
  }

  function startLocalQwen35WarmupFeedback(sessionPath: any, _ss: any) {
    debugLog()?.log("ws", `[LOCAL-QWEN35-DIRECT v3] warmup started outside model stream · ${sessionPath}`);
    return () => {};
  }

  function startLocalQwen35PrefetchFeedback(sessionPath: any, _ss: any, toolName: any, promptText: any) {
    debugLog()?.log("ws", `[LOCAL-QWEN35-DIRECT v3] prefetch started outside model stream · tool=${toolName || ""} · ${sessionPath} · prompt=${String(promptText || "").slice(0, 80)}`);
    return () => {};
  }

  function closeLocalQwen35DirectTurn(sessionPath: any, ss: any, opts: any = {}) {
    clearTurnTimers(ss);
    if (ss.isThinking) {
      ss.isThinking = false;
      emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
    }
    emitStreamEvent(sessionPath, ss, { type: "model_hint", model: `${LOCAL_QWEN35_PROVIDER_ID}/${LOCAL_QWEN35_MODEL_ID}` });
    maybeAppendCodeVerificationPostscript(sessionPath, ss);
    emitStreamEvent(sessionPath, ss, { type: "turn_end" });
    lifecycleHooks.run("turn_end", {
      ss,
      sessionPath,
      hasOutput: ss.hasOutput,
      hasToolCall: ss.hasToolCall,
      direct: true,
      source: "local_qwen35_direct",
    });
    broadcast({ type: "status", isStreaming: false, sessionPath });
    finishSessionStream(ss);
    resetCompletedTurnState(ss);
    if (opts.debugLabel) {
      debugLog()?.log("ws", `[LOCAL-QWEN35-DIRECT v1] closed · ${opts.debugLabel} · ${sessionPath}`);
    }
  }

  async function switchCurrentSessionToBrainFallback(sessionPath: any, ss: any, reason: any, modelInfo: any = {}) {
    const brainModel = resolveBrainFallbackModel(engine);
    if (!brainModel) {
      debugLog()?.warn("ws", `[LOCAL-QWEN35-FALLBACK v1] no brain fallback model available · reason=${reason} · ${sessionPath}`);
      return null;
    }
    if (engine.currentSessionPath && engine.currentSessionPath !== sessionPath) {
      debugLog()?.warn("ws", `[LOCAL-QWEN35-FALLBACK v1] session is no longer focused; cannot switch current model · reason=${reason} · ${sessionPath}`);
      return null;
    }
    const switcher = engine?._sessionCoord?.switchCurrentSessionModel;
    if (typeof switcher !== "function") {
      debugLog()?.warn("ws", `[LOCAL-QWEN35-FALLBACK v1] session model switcher unavailable · reason=${reason} · ${sessionPath}`);
      return null;
    }
    await switcher.call(engine._sessionCoord, brainModel);
    emitStreamEvent(sessionPath, ss, {
      type: "provider_meta",
      activeProvider: BRAIN_PROVIDER_ID,
      fallbackFrom: [{
        id: String(modelInfo?.provider || LOCAL_QWEN35_PROVIDER_ID),
        reason,
      }],
    });
    emitStreamEvent(sessionPath, ss, { type: "model_hint", model: `${BRAIN_PROVIDER_ID}/${brainModel.id || BRAIN_DEFAULT_MODEL_ID}` });
    debugLog()?.warn("ws", `[LOCAL-QWEN35-FALLBACK v1] switched session to brain fallback · reason=${reason} · model=${brainModel.id || ""} · ${sessionPath}`);
    return brainModel;
  }

  async function continueTurnViaHub(sessionPath: any, ss: any, text: any, {
    images,
    streamToken,
    disableTools,
    turnInstruction,
    returnedOpenReason = "hub_send_returned_open_safety_timeout",
    returnedClosedReason = "hub_send_returned_closed_without_turn_end",
  }: any = {}) {
    scheduleSilentBrainAbort(sessionPath, ss);
    await hub.send(
      text,
      images
        ? { images, sessionPath, streamToken, disableTools, turnInstruction }
        : { sessionPath, streamToken, disableTools, turnInstruction },
    );
    if (!ss.isStreaming) {
      if (hasToolExecutionInFlight(ss)) {
        scheduleToolFinalizationFallback(sessionPath, ss);
        debugLog()?.log("ws", `[HUB-SEND v2] returned while tool is still in flight count=${ss.activeToolCallCount || 0}, recovered=${!!ss.recoveredBashInFlight}; defer close · ${sessionPath}`);
      } else {
        clearTurnTimers(ss);
        if (!finalizeReturnedTurnWithoutStream(sessionPath, ss, returnedClosedReason)) {
          broadcast({ type: "status", isStreaming: false, sessionPath });
        }
      }
    } else if (!hasToolExecutionInFlight(ss) && finalizeReturnedTurnWithoutStream(sessionPath, ss, "hub_send_returned_open_without_turn_end", { requirePersistedText: true })) {
      // finalized from the persisted non-streaming assistant message
    } else {
      scheduleReturnedTurnFinalizationFallback(sessionPath, ss, returnedOpenReason);
      debugLog()?.log("ws", `hub.send returned while server stream remains open · ${sessionPath}`);
    }
  }

  async function fallbackLocalQwen35DirectToBrain({ sessionPath, ss, promptText, effectivePromptText, modelInfo, msg, streamToken, disableTools, turnInstruction, reason }: any) {
    if (ss.hasOutput || ss.hasThinking) {
      return false;
    }
    const fallbackModel = await switchCurrentSessionToBrainFallback(sessionPath, ss, reason, modelInfo);
    if (!fallbackModel) return false;
    ss.streamSource = "brain_fallback";
    ss.effectivePromptText = effectivePromptText || promptText;
    await continueTurnViaHub(sessionPath, ss, effectivePromptText || promptText, {
      images: msg?.images,
      streamToken,
      disableTools,
      turnInstruction,
      returnedOpenReason: `local_qwen35_${reason}_fallback_open_safety_timeout`,
      returnedClosedReason: `local_qwen35_${reason}_fallback_closed_without_turn_end`,
    });
    return true;
  }

  async function streamLocalQwen35DirectBridge(sessionPath: any, ss: any, originalPromptText: any, effectivePromptText: any, modelInfo: any = {}, opts: any = {}) {
    const startedAt = Date.now();
    const localProviderId = String(modelInfo?.provider || LOCAL_QWEN35_PROVIDER_ID);
    const localModelId = String(modelInfo?.modelId || modelInfo?.id || LOCAL_QWEN35_MODEL_ID);
    const enableThinking = opts.enableThinking !== false;
    const maxTokens = Number.isFinite(Number(opts.maxTokens)) && Number(opts.maxTokens) > 0
      ? Number(opts.maxTokens)
      : LOCAL_QWEN35_DIRECT_MAX_TOKENS;
    let assistantText = "";
    let reasoningText = "";
    let usage = null;
    const stopWarmupFeedback = startLocalQwen35WarmupFeedback(sessionPath, ss);
    let warmupStopped = false;
    const stopWarmupOnce = () => {
      if (warmupStopped) return;
      warmupStopped = true;
      stopWarmupFeedback();
    };
    let firstModelDeltaSeen = false;
    const timeoutMs = Number.isFinite(Number(opts.timeoutMs)) && Number(opts.timeoutMs) > 0
      ? Number(opts.timeoutMs)
      : (enableThinking ? 150_000 : 60_000);
    const earlyCloseVisibleChars = Number.isFinite(Number(opts.earlyCloseVisibleChars)) && Number(opts.earlyCloseVisibleChars) > 0
      ? Number(opts.earlyCloseVisibleChars)
      : 0;

    const buildAttemptMessages = (attemptEnableThinking: any) => {
      const attemptMessages = buildLocalQwen35DirectMessages(sessionPath, originalPromptText, effectivePromptText);
      if (!attemptEnableThinking) appendNoThinkHintToLastUserMessage(attemptMessages);
      return attemptMessages;
    };

    const runAttempt = async ({ attemptEnableThinking, attemptMaxTokens, attemptTimeoutMs, allowEarlyClose }: any) => {
      const attemptMessages = buildAttemptMessages(attemptEnableThinking);
      const attempt = await streamLocalQwen35Completion({
        endpoint: LOCAL_QWEN35_DIRECT_ENDPOINT,
        model: localModelId,
        messages: attemptMessages,
        enableThinking: attemptEnableThinking,
        maxTokens: attemptMaxTokens,
        timeoutMs: attemptTimeoutMs,
        onFirstDelta: () => {
          if (!firstModelDeltaSeen) {
            firstModelDeltaSeen = true;
            stopWarmupOnce();
          }
        },
        onUsage: (nextUsage: any) => { usage = nextUsage; },
        onReasoningDelta: (reasoningDelta: any) => {
          reasoningText += reasoningDelta;
          emitLocalThinkingDelta(sessionPath, ss, reasoningDelta);
        },
        onContentDelta: (contentDelta: any) => {
          if (ss.isThinking) {
            ss.isThinking = false;
            emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
          }
          assistantText += contentDelta;
          feedAssistantVisibleText(sessionPath, ss, contentDelta);
        },
        shouldStopEarly: () => (
          !!(allowEarlyClose && earlyCloseVisibleChars && assistantText.trim().length >= earlyCloseVisibleChars)
        ),
      });
      if (attempt.timedOutAfterVisibleOutput) {
        debugLog()?.warn("ws", `[LOCAL-QWEN35-DIRECT v1] timed out after visible output · chars=${attempt.assistantText.length} timeout=${attemptTimeoutMs}ms · ${sessionPath}`);
      }
      return attempt;
    };

    const firstAttempt = await runAttempt({
      attemptEnableThinking: enableThinking,
      attemptMaxTokens: maxTokens,
      attemptTimeoutMs: timeoutMs,
      allowEarlyClose: true,
    });
    if (shouldRetryLocalQwen35WithoutThinking({
      enableThinking,
      assistantText: firstAttempt.assistantText,
      reasoningText: firstAttempt.reasoningText,
    })) {
      if (ss.isThinking) {
        ss.isThinking = false;
        emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
      }
      debugLog()?.warn("ws", `[LOCAL-QWEN35-DIRECT v1] thinking-only output, retrying with thinking-off · reasoningChars=${firstAttempt.reasoningText.length} · ${sessionPath}`);
      const retryAttempt = await runAttempt({
        attemptEnableThinking: false,
        attemptMaxTokens: resolveLocalQwen35DirectMaxTokens(originalPromptText, false),
        attemptTimeoutMs: 60_000,
        allowEarlyClose: false,
      });
      if (!retryAttempt.assistantText.trim()) {
        assistantText += LOCAL_QWEN35_EMPTY_CONTENT_FALLBACK_MESSAGE;
        feedAssistantVisibleText(sessionPath, ss, LOCAL_QWEN35_EMPTY_CONTENT_FALLBACK_MESSAGE);
      }
    }
    stopWarmupOnce();
    flushBufferedAssistantText(sessionPath, ss);
    persistLocalQwen35DirectTurn(sessionPath, originalPromptText, assistantText, {
      reasoningText,
      usage,
      provider: localProviderId,
      model: localModelId,
    });
    closeLocalQwen35DirectTurn(sessionPath, ss, {
      debugLabel: `chars=${assistantText.length} ms=${Date.now() - startedAt}`,
    });
    return true;
  }

  return {
    fallbackLocalQwen35DirectToBrain,
    startLocalQwen35PrefetchFeedback,
    streamLocalQwen35DirectBridge,
  };
}
