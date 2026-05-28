/**
 * WebSocket 聊天路由
 *
 * 桥接 Pi SDK streaming 事件 → WebSocket 消息
 * 支持多 session 并发：后台 session 静默运行，只转发当前活跃 session 的事件
 */
import { Hono } from "hono";
import { wsSend, wsParse } from "../ws-protocol.js";
import { debugLog } from "../../lib/debug-log.js";
import { t, getLocale } from "../i18n.js";
import {
  buildReportResearchContext,
} from "../chat/report-research-context.js";
import {
  resolveCurrentModelInfo,
} from "../chat/chat-recovery.js";
import { createLifecycleHooks } from "../chat/lifecycle-hooks.js";
import { classifyRouteIntent } from "../../shared/task-route-intent.js";
import {
  buildVisionUnsupportedMessage,
} from "../../shared/vision-prompt.js";
import {
  beginSessionStream,
  resumeSessionStream,
  finishSessionStream,
} from "../session-stream-store.js";
import { AppError } from "../../shared/errors.js";
import { errorBus } from "../../shared/error-bus.js";
import {
  BRAIN_DEFAULT_MODEL_ID,
  BRAIN_PROVIDER_ID,
} from "../../shared/brain-provider.js";
import {
  clearToolFinalizationTimer,
  clearTurnTimers,
  createSessionStateStore,
  isStaleEmptySessionStream,
  resetCompletedTurnState,
} from "../chat/stream-state.js";
import type { SessionLike } from "../chat/stream-state.js";
import {
  TOOL_USE_BEHAVIOR,
  buildNoToolTurnPrompt,
  buildPrefetchAugmentedPrompt,
  resolveInitialToolUseBehavior,
} from "../chat/tool-use-behavior.js";
import { extractText } from "../chat/content-utils.js";
import { buildCodeVerificationPostscript } from "../chat/code-verification-postscript.js";
import { createEditRollbackStore } from "../chat/edit-rollback-store.js";
import { createTokenBucketRateLimiter } from "../chat/rate-limit.js";
import {
  appendTextToLatestAssistantInMemory,
  appendTextToLatestAssistantRecord,
  countPersistedAssistantMessages,
  countPersistedAssistantVisibleTexts,
} from "../chat/session-persistence.js";
import {
  LOCAL_QWEN35_DIRECT_PREFETCH_MAX_TOKENS,
  resolveLocalQwen35DirectMaxTokens,
  resolveLocalQwen35DirectThinking,
  shouldUseLocalQwen35DirectBridge,
} from "../chat/local-qwen35-direct-policy.js";
import {
  buildPrefetchToolSummary,
  rememberFailedTool,
  rememberSuccessfulTool,
} from "../chat/tool-summary.js";
import {
  attachLocalQwen35BenchContext,
  isLocalQwen35Model,
} from "../chat/local-qwen35-bench-context.js";
import {
  consumeMutationConfirmation,
  recordPendingDeleteRequest,
} from "../chat/turn-retry-policy.js";
import { createStreamEmitters } from "../chat/stream-events.js";
import { createChatRouteContext } from "../chat/chat-route-context.js";
import { generateSessionTitle } from "../chat/title-generator.js";
import { createToolTurnFinalizer } from "../chat/tool-turn-finalizer.js";
import { createLocalModelBridge } from "../chat/local-model-bridge.js";
import {
  createPromptSession,
  normalizePromptRequest,
  resolveCreatedPromptSessionPath,
  validatePromptImages,
} from "../chat/request-normalizer.js";
import { createHubEventForwarder } from "../chat/hub-event-forwarder.js";

type TimerHandle = ReturnType<typeof setTimeout>;
type AnyRecord = Record<string, any>;

function hasStreamEvent(ss: any, type: any) {
  return Array.isArray(ss?.events) && ss.events.some((entry: any) => entry?.event?.type === type);
}

function hasScheduledInternalRetry(ss: any) {
  return !!(ss?.internalRetryPending || ss?.internalRetryInFlight);
}

function hasToolExecutionInFlight(ss: any) {
  return !!(ss?.recoveredBashInFlight || Number(ss?.activeToolCallCount || 0) > 0);
}

function hasDifferentActiveStreamToken(ss: any, streamToken: any) {
  return Boolean(streamToken && ss?.activeStreamToken && ss.activeStreamToken !== streamToken);
}

function resolveBrainFallbackModel(engine: any) {
  const models = Array.isArray(engine?.availableModels) ? engine.availableModels : [];
  return models.find((model: any) => model?.provider === BRAIN_PROVIDER_ID && model?.id === BRAIN_DEFAULT_MODEL_ID)
    || models.find((model: any) => model?.provider === BRAIN_PROVIDER_ID)
    || null;
}

export function createChatRoute(engine: any, hub: any, { upgradeWebSocket }: any) {
  const routeContext = createChatRouteContext(engine, hub, { upgradeWebSocket });
  const restRoute = new Hono();
  const wsRoute = new Hono();

  let activeWsClients = 0;
  let disconnectAbortTimer: TimerHandle | null = null;
  const DISCONNECT_ABORT_GRACE_MS = 15_000;
  const TURN_HARD_ABORT_MS = Number(process.env.LYNN_TURN_HARD_ABORT_MS || 120_000);
  const TURN_LONG_RESEARCH_HARD_ABORT_MS = Number(process.env.LYNN_TURN_LONG_RESEARCH_HARD_ABORT_MS || 240_000);
  const TOOL_FINALIZATION_GRACE_MS = Number(process.env.LYNN_TOOL_FINALIZATION_GRACE_MS || 8_000);
  const TOOL_AUTHORIZATION_GRACE_MS = Number(process.env.LYNN_TOOL_AUTHORIZATION_GRACE_MS || 45_000);
  const RETURNED_TURN_FINALIZATION_GRACE_MS = Number(process.env.LYNN_RETURNED_TURN_FINALIZATION_GRACE_MS || 3_000);

  const { sessionState, getState } = createSessionStateStore();
  const lifecycleHooks = createLifecycleHooks({
    onError: (err: any, meta: any) => {
      debugLog()?.warn("ws", `lifecycle hook failed · event=${meta?.eventName || "unknown"} · ${err?.message || err}`);
    },
  });
  lifecycleHooks.tap("prompt_start", ({ sessionPath, routeIntent, streamToken }: any) => {
    debugLog()?.span("prompt_start", { sessionPath, routeIntent, streamToken }, { module: "ws", level: "DEBUG" });
  });
  lifecycleHooks.tap("tool_start", ({ sessionPath, toolName }: any) => {
    debugLog()?.span("tool_start", { sessionPath, toolName }, { module: "ws", level: "DEBUG" });
  });
  lifecycleHooks.tap("tool_end", ({ sessionPath, toolName, success }: any) => {
    debugLog()?.span("tool_end", { sessionPath, toolName, success }, { module: "ws", level: "DEBUG" });
  });
  lifecycleHooks.tap("turn_end", ({ sessionPath, hasOutput, hasToolCall }: any) => {
    debugLog()?.span("turn_end", { sessionPath, hasOutput, hasToolCall }, { module: "ws", level: "DEBUG" });
  });
  lifecycleHooks.tap("turn_close", ({ sessionPath, reason }: any) => {
    debugLog()?.span("turn_close", { sessionPath, reason }, { module: "ws", level: "INFO" });
  });

  const checkRateLimit = createTokenBucketRateLimiter({ capacity: 5, refillMs: 10_000 });

  type ToolTurnFinalizers = ReturnType<typeof createToolTurnFinalizer>;
  let buildRealtimeToolFallbackText: ToolTurnFinalizers["buildRealtimeToolFallbackText"] = () => "";
  let closeStreamAfterError: ToolTurnFinalizers["closeStreamAfterError"] = () => {};
  let closeStreamWithVisibleFallback: ToolTurnFinalizers["closeStreamWithVisibleFallback"] = () => false;
  let finalizeReturnedTurnWithoutStream: ToolTurnFinalizers["finalizeReturnedTurnWithoutStream"] = () => false;
  let schedulePersistedFinalAnswerPoll: ToolTurnFinalizers["schedulePersistedFinalAnswerPoll"] = () => false;
  let scheduleReturnedTurnFinalizationFallback: ToolTurnFinalizers["scheduleReturnedTurnFinalizationFallback"] = () => false;
  let scheduleSilentBrainAbort: ToolTurnFinalizers["scheduleSilentBrainAbort"] = () => {};
  let scheduleToolAuthorizationFallback: ToolTurnFinalizers["scheduleToolAuthorizationFallback"] = () => {};
  let scheduleToolFinalizationFallback: ToolTurnFinalizers["scheduleToolFinalizationFallback"] = () => {};
  let scheduleTurnHardAbort: ToolTurnFinalizers["scheduleTurnHardAbort"] = () => {};

  function cancelDisconnectAbort() {
    if (disconnectAbortTimer) {
      clearTimeout(disconnectAbortTimer);
      disconnectAbortTimer = null;
    }
  }

  function scheduleDisconnectAbort() {
    if (disconnectAbortTimer || activeWsClients > 0) return;
    disconnectAbortTimer = setTimeout(() => {
      disconnectAbortTimer = null;
      if (activeWsClients > 0) return;
      debugLog()?.log("ws", `no clients for ${DISCONNECT_ABORT_GRACE_MS}ms, aborting all streaming`);
      engine.abortAllStreaming().catch(() => {});
    }, DISCONNECT_ABORT_GRACE_MS);
  }

  async function releaseStaleSessionStream(sessionPath: any, ss: any) {
    if (!sessionPath || !ss) return false;
    const isInternalRetryStream = ss.streamSource === "internal_retry";
    clearTurnTimers(ss);
    try {
      await engine.abortSessionByPath?.(sessionPath);
    } catch (err: any) {
      console.warn("[chat] failed to abort stale session stream:", err?.message || err);
    }
    if (ss.isStreaming) {
      if (isInternalRetryStream) {
        editRollbackStore.discardPendingForSession(sessionPath, ss.activeStreamToken || null);
        ss.internalRetryPending = false;
        ss.internalRetryInFlight = false;
        ss.internalRetryReason = "";
        if (ss.isThinking) {
          ss.isThinking = false;
          emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
        }
        if (!hasStreamEvent(ss, "turn_end")) {
          emitStreamEvent(sessionPath, ss, { type: "turn_end" });
        }
        finishSessionStream(ss);
        resetCompletedTurnState(ss);
        broadcast({ type: "status", isStreaming: false, sessionPath });
      } else {
        closeStreamAfterError(sessionPath, ss);
      }
    } else {
      editRollbackStore.discardPendingForSession(sessionPath, ss.activeStreamToken || null);
      finishSessionStream(ss);
      resetCompletedTurnState(ss);
      broadcast({ type: "status", isStreaming: false, sessionPath });
    }
    debugLog()?.warn("ws", `[STALE-STREAM-RELEASE v1] released stale stream · elapsed=${Date.now() - (ss.startedAt || Date.now())}ms · ${sessionPath}`);
    return true;
  }

  async function closeBusySessionBeforeNextPrompt(sessionPath: any, ss: any) {
    if (!sessionPath || !ss) return false;
    clearTurnTimers(ss);
    try {
      await engine.abortSessionByPath?.(sessionPath);
    } catch (err: any) {
      console.warn("[chat] failed to abort busy session stream:", err?.message || err);
    }
    if (ss.isThinking) {
      ss.isThinking = false;
      emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
    }
    if (!hasStreamEvent(ss, "turn_end")) {
      emitStreamEvent(sessionPath, ss, { type: "turn_end" });
    }
    lifecycleHooks.run("turn_close", { sessionPath, ss, reason: "busy_new_prompt", forced: true });
    broadcast({ type: "status", isStreaming: false, sessionPath });
    finishSessionStream(ss);
    resetCompletedTurnState(ss);
    debugLog()?.warn("ws", `[BUSY-STREAM-FENCE v1] closed active stream before accepting next prompt · session=${sessionPath}`);
    return true;
  }

  const clients = new Set<any>();

  const editRollbackStore = createEditRollbackStore({ maxSnapshots: 200 });

  function broadcast(msg: any) {
    for (const client of clients) {
      wsSend(client as any, msg);
    }
  }

  function maybeGenerateFirstTurnTitle(sessionPath: any, ss: any) {
    if (!sessionPath || !ss || ss.titleRequested) return;

    const session = engine.getSessionByPath(sessionPath);
    const messages = Array.isArray(session?.messages) ? session.messages : [];
    const userMsgCount = messages.filter((m: any) => m.role === "user").length;
    if (userMsgCount !== 1) return;

    const assistantMsg = messages.find((m: any) => m.role === "assistant");
    const assistantText = (ss.titlePreview || extractText(assistantMsg?.content)).trim();
    if (!assistantText) return;

    ss.titleRequested = true;
    generateSessionTitle(engine, broadcast, {
      sessionPath,
      assistantTextHint: assistantText,
    }).then((ok: any) => {
      if (!ok) ss.titleRequested = false;
    }).catch((err: any) => {
      ss.titleRequested = false;
      console.error("[chat] generateSessionTitle error:", err.message);
    });
  }

  const {
    emitStreamEvent,
    emitTrustedVisibleTextDelta,
    emitVisibleTextDelta,
    flushBufferedToolVisibleText,
    feedAssistantVisibleText,
    flushBufferedAssistantText,
  } = createStreamEmitters({
    broadcast,
    hasStreamEvent,
    hasToolExecutionInFlight,
    scheduleToolFinalizationFallback: (sessionPath, ss) => scheduleToolFinalizationFallback(sessionPath, ss as SessionLike),
    clearToolFinalizationTimer: (ss) => clearToolFinalizationTimer(ss as SessionLike),
    maybeGenerateFirstTurnTitle: (sessionPath, ss) => maybeGenerateFirstTurnTitle(sessionPath, ss),
  });

  function maybeAppendCodeVerificationPostscript(sessionPath: any, ss: any) {
    if (!sessionPath || !ss) return false;
    const addition = buildCodeVerificationPostscript(
      `${ss.originalPromptText || ""}\n${ss.effectivePromptText || ""}`,
      ss.visibleTextAcc || "",
    );
    if (!addition) return false;
    emitTrustedVisibleTextDelta(sessionPath, ss, addition);
    appendTextToLatestAssistantRecord(sessionPath, addition);
    appendTextToLatestAssistantInMemory(engine.getSessionByPath(sessionPath), addition);
    debugLog()?.log("ws", `[CODE-VERIFY-POSTSCRIPT v1] appended verification command · ${sessionPath}`);
    return true;
  }

  ({
    buildRealtimeToolFallbackText,
    closeStreamAfterError,
    closeStreamWithVisibleFallback,
    finalizeReturnedTurnWithoutStream,
    schedulePersistedFinalAnswerPoll,
    scheduleReturnedTurnFinalizationFallback,
    scheduleSilentBrainAbort,
    scheduleToolAuthorizationFallback,
    scheduleToolFinalizationFallback,
    scheduleTurnHardAbort,
  } = createToolTurnFinalizer({
    engine,
    editRollbackStore,
    lifecycleHooks,
    broadcast,
    emitStreamEvent,
    emitTrustedVisibleTextDelta,
    emitVisibleTextDelta,
    flushBufferedAssistantText,
    flushBufferedToolVisibleText,
    maybeAppendCodeVerificationPostscript,
    hasStreamEvent,
    hasScheduledInternalRetry,
    hasToolExecutionInFlight,
    hasDifferentActiveStreamToken,
    timeouts: {
      returnedTurnFinalizationGraceMs: RETURNED_TURN_FINALIZATION_GRACE_MS,
      turnHardAbortMs: TURN_HARD_ABORT_MS,
      turnLongResearchHardAbortMs: TURN_LONG_RESEARCH_HARD_ABORT_MS,
      toolFinalizationGraceMs: TOOL_FINALIZATION_GRACE_MS,
      toolAuthorizationGraceMs: TOOL_AUTHORIZATION_GRACE_MS,
    },
  }));

  const {
    fallbackLocalQwen35DirectToBrain,
    startLocalQwen35PrefetchFeedback,
    streamLocalQwen35DirectBridge,
  } = createLocalModelBridge({
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
  });

  createHubEventForwarder({
    hub,
    engine,
    sessionState,
    editRollbackStore,
    lifecycleHooks,
    broadcast,
    emitStreamEvent,
    feedAssistantVisibleText,
    flushBufferedAssistantText,
    maybeAppendCodeVerificationPostscript,
    maybeGenerateFirstTurnTitle,
    buildRealtimeToolFallbackText,
    closeStreamAfterError,
    scheduleToolAuthorizationFallback,
    scheduleToolFinalizationFallback,
    hasStreamEvent,
    hasToolExecutionInFlight,
  });

  // ── WebSocket 路由 ──

  wsRoute.get("/ws",
    routeContext.upgradeWebSocket((_c: any) => {
      let closed = false;

      return {
        onOpen(event: any, ws: any) {
          activeWsClients++;
          clients.add(ws);
          cancelDisconnectAbort();
          debugLog()?.log("ws", "client connected");
        },

        onMessage(event: any, ws: any) {
          const msg: AnyRecord | null = wsParse(event.data) as AnyRecord | null;
          if (!msg) return;

          (async () => {
            if (msg.type === "abort") {
              const abortPath = msg.sessionPath || engine.currentSessionPath;
              if (engine.isSessionStreaming(abortPath)) {
                try { await hub.abort(abortPath); } catch (err: any) { console.warn("[chat] abort failed:", err?.message || err); }
              }
              return;
            }

            if (msg.type === "steer" && msg.text) {
              debugLog()?.log("ws", `steer (${msg.text.length} chars)`);
              const steerPath = msg.sessionPath || engine.currentSessionPath;
              if (engine.steerSession(steerPath, msg.text)) {
                wsSend(ws, { type: "steered" });
                return;
              }
              debugLog()?.log("ws", `steer missed, falling back to prompt`);
              msg.type = "prompt";
            }

            if (msg.type === "resume_stream") {
              const currentPath = msg.sessionPath || engine.currentSessionPath;
              const ss = sessionState.get(currentPath);
              if (ss) {
                const resumed = resumeSessionStream(ss, {
                  streamId: typeof msg.streamId === "string" ? msg.streamId : null,
                  sinceSeq: Number(msg.sinceSeq || 0),
                });
                wsSend(ws, {
                  type: "stream_resume",
                  sessionPath: currentPath,
                  streamId: resumed.streamId,
                  sinceSeq: resumed.sinceSeq,
                  nextSeq: resumed.nextSeq,
                  reset: resumed.reset,
                  truncated: resumed.truncated,
                  isStreaming: resumed.isStreaming,
                  events: resumed.events,
                });
              } else {
                wsSend(ws, {
                  type: "stream_resume",
                  sessionPath: currentPath,
                  streamId: null,
                  sinceSeq: Number.isFinite(Number(msg.sinceSeq)) ? Math.max(0, Number(msg.sinceSeq)) : 0,
                  nextSeq: 1,
                  reset: false,
                  truncated: false,
                  isStreaming: false,
                  events: [],
                });
              }
              return;
            }

            if (msg.type === "context_usage") {
              const usagePath = msg.sessionPath || engine.currentSessionPath;
              const usageSession = engine.getSessionByPath(usagePath);
              const usage = usageSession?.getContextUsage?.();
              wsSend(ws, {
                type: "context_usage",
                sessionPath: usagePath,
                tokens: usage?.tokens ?? null,
                contextWindow: usage?.contextWindow ?? null,
                percent: usage?.percent ?? null,
              });
              return;
            }

            if (msg.type === "compact") {
              const compactPath = msg.sessionPath || engine.currentSessionPath;
              const session = engine.getSessionByPath(compactPath);
              if (!session) {
                wsSend(ws, { type: "error", message: t("error.noActiveSession") });
                return;
              }
              if (session.isCompacting) {
                wsSend(ws, { type: "error", message: t("error.compacting") });
                return;
              }
              if (engine.isSessionStreaming(compactPath)) {
                wsSend(ws, { type: "error", message: t("error.waitForReply") });
                return;
              }
              broadcast({ type: "compaction_start", sessionPath: compactPath });
              try {
                await session.compact();
                const usage = session.getContextUsage?.();
                broadcast({
                  type: "compaction_end",
                  sessionPath: compactPath,
                  tokens: usage?.tokens ?? null,
                  contextWindow: usage?.contextWindow ?? null,
                  percent: usage?.percent ?? null,
                });
              } catch (err: any) {
                const errMsg = err.message || "";
                if (errMsg.includes("Already compacted") || errMsg.includes("Nothing to compact")) {
                  broadcast({ type: "compaction_end", sessionPath: compactPath });
                } else {
                  broadcast({ type: "compaction_end", sessionPath: compactPath });
                  wsSend(ws, { type: "error", message: t("error.compactFailed", { msg: errMsg }) });
                }
              }
              return;
            }

            if (msg.type === "toggle_plan_mode") {
              const current = engine.planMode;
              engine.setPlanMode(!current);
              broadcast({ type: "plan_mode", enabled: !current });
              broadcast({ type: "security_mode", mode: !current ? "plan" : "authorized" });
              return;
            }

            if (msg.type === "prompt" && (msg.text || msg.images?.length)) {
              if (!checkRateLimit(ws)) {
                wsSend(ws, { type: "error", message: "Rate limit exceeded. Please wait before sending another message." });
                return;
              }
              const imageValidation = validatePromptImages(msg.images, t);
              if (!imageValidation.ok) {
                wsSend(ws, { type: "error", message: imageValidation.message || t("error.imageTooLarge") });
                return;
              }
              const _resolved = engine.resolveModelOverrides(engine.currentModel);
              if (msg.images?.length && _resolved?.vision === false) {
                wsSend(ws, { type: "error", message: buildVisionUnsupportedMessage({ locale: getLocale() }) });
                return;
              }
              let promptSessionPath = msg.sessionPath || engine.currentSessionPath;
              if (!promptSessionPath) {
                const createdSession = await createPromptSession(engine);
                promptSessionPath = resolveCreatedPromptSessionPath(createdSession, engine);
              }
              const { promptText } = normalizePromptRequest(msg, promptSessionPath, { locale: getLocale() });
              debugLog()?.log("ws", `user message (${promptText.length} chars, ${msg.images?.length || 0} images)`);
              const ss = getState(promptSessionPath);
              if (!ss) {
                wsSend(ws, { type: "error", message: t("error.noActiveSession") });
                return;
              }
              wsSend(ws, {
                type: "prompt_accepted",
                sessionPath: promptSessionPath,
                clientMessageId: msg.clientMessageId || null,
              });
              const engineStreaming = engine.isSessionStreaming(promptSessionPath);
              if (engineStreaming || ss?.isStreaming) {
                const isLegacySyntheticStream = ss?.streamSource === "internal_retry";
                const shouldReleaseStale = isStaleEmptySessionStream(ss)
                  || (engineStreaming && !ss?.isStreaming)
                  || isLegacySyntheticStream;
                let releasedStale = shouldReleaseStale
                  ? await releaseStaleSessionStream(promptSessionPath, ss)
                  : false;
                if (!releasedStale && ss?.isStreaming) {
                  releasedStale = await closeBusySessionBeforeNextPrompt(promptSessionPath, ss);
                }
                if (releasedStale && isLegacySyntheticStream) {
                  debugLog()?.warn("ws", `[STALE-STREAM-FENCE v1] released legacy synthetic stream on new user prompt · session=${promptSessionPath}`);
                }
                if (!releasedStale) {
                  wsSend(ws, { type: "error", message: t("error.stillStreaming", { name: engine.agentName }) });
                  return;
                }
              }
              try {
                ss.thinkTagParser.reset();
                ss.progressParser.reset();
                ss.moodParser.reset();
                ss.xingParser.reset();
                ss.titleRequested = false;
                ss.titlePreview = "";
                ss.visibleTextAcc = "";
                ss.bufferedVisibleTextDuringTool = "";
                ss.hasBufferedVisibleTextDuringTool = false;
                ss.rawTextAcc = "";
                ss.routeIntent = classifyRouteIntent(promptText, { imagesCount: msg.images?.length || 0 });
                ss.originalPromptText = promptText;
                ss.effectivePromptText = promptText;
                ss.hasLocalPrefetchEvidence = false;
                ss.pendingToolRetryAttempted = false;
                ss.internalRetryCounts = {};
                ss.internalRetryPending = false;
                ss.internalRetryInFlight = false;
                ss.internalRetryReason = "";
                ss.pseudoToolSteered = false;
                ss.pseudoToolRecoveryHandled = false;
                ss.pseudoToolCommandRecoveryAttempted = false;
                ss.pseudoToolXmlBlock = null;
                ss.emittedFileOutputPaths = new Set();
                ss.rehydratedThisTurn = false;
                ss.postRehydrateEscalationAttempted = false;
                ss.postRehydrateDeterministicAttempted = false;
                ss.hasOutput = false;
                ss.hasToolCall = false;
                ss.hasThinking = false;
                ss.hasError = false;
                ss.realtimeToolFallbackText = "";
                ss.persistedAssistantTextBaseline = countPersistedAssistantVisibleTexts(
                  engine.getSessionByPath(promptSessionPath),
                  promptSessionPath,
                );
                ss.persistedAssistantMessageBaseline = countPersistedAssistantMessages(
                  engine.getSessionByPath(promptSessionPath),
                  promptSessionPath,
                );
                const rehydratedMutation = consumeMutationConfirmation(ss, promptText);
                if (rehydratedMutation) {
                  ss.originalPromptText = rehydratedMutation.originalPrompt;
                  ss.routeIntent = classifyRouteIntent(rehydratedMutation.originalPrompt, { imagesCount: msg.images?.length || 0 });
                  ss._rehydratedEffectivePrompt = rehydratedMutation.retryPrompt;
                  ss.rehydratedThisTurn = true;
                  debugLog()?.warn("ws", `[MUTATION-CONFIRM-REHYDRATE v1] rehydrated prior delete request · session=${promptSessionPath}`);
                } else if (recordPendingDeleteRequest(ss, promptText)) {
                  debugLog()?.log("ws", `[PENDING-DELETE-REQUEST v1] tracked delete request for confirmation rehydrate · session=${promptSessionPath}`);
                }
                const streamToken = beginSessionStream(ss);
                ss.activeStreamToken = streamToken;
                ss.streamSource = "user";
                scheduleTurnHardAbort(promptSessionPath, ss);
                schedulePersistedFinalAnswerPoll(promptSessionPath, ss);
                broadcast({ type: "status", isStreaming: true, sessionPath: promptSessionPath });
                lifecycleHooks.run("prompt_start", {
                  ss,
                  sessionPath: promptSessionPath,
                  routeIntent: ss.routeIntent,
                  streamToken,
                });
                const currentModelInfo: AnyRecord = resolveCurrentModelInfo(engine) as AnyRecord;
                const initialToolUse = resolveInitialToolUseBehavior(promptText, { modelInfo: currentModelInfo });
                const budgetContext = initialToolUse.budgetContext || "";
                let effectivePromptText = initialToolUse.effectivePromptText || promptText;
                let disableTurnTools = !!initialToolUse.disableTools;
                effectivePromptText = attachLocalQwen35BenchContext(effectivePromptText, currentModelInfo);
                if (ss._rehydratedEffectivePrompt) {
                  effectivePromptText = String(ss._rehydratedEffectivePrompt);
                  disableTurnTools = false;
                  ss._rehydratedEffectivePrompt = null;
                }
                const noToolTurnInstruction = disableTurnTools ? buildNoToolTurnPrompt(effectivePromptText) : "";
                if (shouldUseLocalQwen35DirectBridge(promptText, {
                  isLocalModel: isLocalQwen35Model(currentModelInfo),
                  hasImages: Boolean(msg.images?.length),
                  rehydratedMutation: Boolean(rehydratedMutation),
                  toolBehavior: initialToolUse.behavior,
                  reason: initialToolUse.reason,
                  routeIntent: ss.routeIntent,
                })) {
                  ss.effectivePromptText = effectivePromptText;
                  try {
                    const localEnableThinking = resolveLocalQwen35DirectThinking(promptText, engine);
                    await streamLocalQwen35DirectBridge(promptSessionPath, ss, promptText, effectivePromptText, currentModelInfo, {
                      enableThinking: localEnableThinking,
                      maxTokens: resolveLocalQwen35DirectMaxTokens(promptText, localEnableThinking),
                    });
                  } catch (directErr: any) {
                    debugLog()?.warn("ws", `[LOCAL-QWEN35-DIRECT v1] failed · ${directErr?.message || directErr} · ${promptSessionPath}`);
                    const fallbackOk = await fallbackLocalQwen35DirectToBrain({
                      sessionPath: promptSessionPath,
                      ss,
                      promptText,
                      effectivePromptText,
                      modelInfo: currentModelInfo,
                      msg,
                      streamToken,
                      disableTools: disableTurnTools,
                      turnInstruction: noToolTurnInstruction,
                      reason: "local_qwen35_direct_failed",
                    });
                    if (!fallbackOk) {
                      closeStreamWithVisibleFallback(
                        promptSessionPath,
                        ss,
                        "",
                        "local_qwen35_direct_failed",
                        { trustedFallback: true },
                      );
                    }
                  }
                  return;
                }
                const localQwenSynthesisAfterPrefetch = isLocalQwen35Model(currentModelInfo);
                if (!rehydratedMutation && initialToolUse.behavior === TOOL_USE_BEHAVIOR.PREFETCH_THEN_RUN_OR_STOP) {
                  const toolName = initialToolUse.toolName;
                  ss.hasPrefetchToolCall = true;
                  emitStreamEvent(promptSessionPath, ss, { type: "tool_start", name: toolName, args: { query: promptText } });
                  const stopPrefetchFeedback = localQwenSynthesisAfterPrefetch
                    ? startLocalQwen35PrefetchFeedback(promptSessionPath, ss, toolName, promptText)
                    : () => {};
                  lifecycleHooks.run("tool_start", {
                    ss,
                    sessionPath: promptSessionPath,
                    toolName,
                    args: { query: promptText },
                    localPrefetch: true,
                  });
                  try {
                    const reportContext = await buildReportResearchContext(promptText, { userPrompt: promptText });
                    if (reportContext && reportContext.trim()) {
                      const toolSummary = buildPrefetchToolSummary(reportContext);
                      ss.hasLocalPrefetchEvidence = true;
                      effectivePromptText = buildPrefetchAugmentedPrompt(promptText, reportContext, budgetContext);
                      emitStreamEvent(promptSessionPath, ss, {
                        type: "tool_end",
                        name: toolName,
                        success: true,
                        summary: Object.keys(toolSummary).length > 0 ? toolSummary : undefined,
                      });
                      lifecycleHooks.run("tool_end", {
                        ss,
                        sessionPath: promptSessionPath,
                        toolName,
                        success: true,
                        summary: Object.keys(toolSummary).length > 0 ? toolSummary : undefined,
                        localPrefetch: true,
                      });
                      rememberSuccessfulTool(ss, toolName, toolSummary, { query: promptText });
                    } else {
                      emitStreamEvent(promptSessionPath, ss, { type: "tool_end", name: toolName, success: false, error: "no evidence returned" });
                      lifecycleHooks.run("tool_end", {
                        ss,
                        sessionPath: promptSessionPath,
                        toolName,
                        success: false,
                        error: "no evidence returned",
                        localPrefetch: true,
                      });
                      rememberFailedTool(ss, toolName);
                    }
                  } catch (prefetchErr: any) {
                    emitStreamEvent(promptSessionPath, ss, {
                      type: "tool_end",
                      name: toolName,
                      success: false,
                      error: prefetchErr?.message || "prefetch failed",
                    });
                    lifecycleHooks.run("tool_end", {
                      ss,
                      sessionPath: promptSessionPath,
                      toolName,
                      success: false,
                      error: prefetchErr?.message || "prefetch failed",
                      localPrefetch: true,
                    });
                    rememberFailedTool(ss, toolName);
                  } finally {
                    stopPrefetchFeedback();
                  }
                  if (localQwenSynthesisAfterPrefetch) {
                    ss.effectivePromptText = effectivePromptText;
                    try {
                      await streamLocalQwen35DirectBridge(promptSessionPath, ss, promptText, effectivePromptText, currentModelInfo, {
                        // The realtime tool result is already supplied as context.
                        // Keep this path as a fast local writer so weather/market
                        // asks do not spend a minute in hidden reasoning.
                        enableThinking: false,
                        maxTokens: Math.min(LOCAL_QWEN35_DIRECT_PREFETCH_MAX_TOKENS, 768),
                        timeoutMs: 45_000,
                        earlyCloseVisibleChars: 240,
                      });
                    } catch (directErr: any) {
                      debugLog()?.warn("ws", `[LOCAL-QWEN35-DIRECT v2] failed after prefetch · ${directErr?.message || directErr} · ${promptSessionPath}`);
                      const fallbackOk = await fallbackLocalQwen35DirectToBrain({
                        sessionPath: promptSessionPath,
                        ss,
                        promptText,
                        effectivePromptText,
                        modelInfo: currentModelInfo,
                        msg,
                        streamToken,
                        disableTools: disableTurnTools,
                        turnInstruction: noToolTurnInstruction,
                        reason: "local_qwen35_direct_after_prefetch_failed",
                      });
                      if (!fallbackOk) {
                        closeStreamWithVisibleFallback(
                          promptSessionPath,
                          ss,
                          "",
                          "local_qwen35_direct_after_prefetch_failed",
                          { trustedFallback: true },
                        );
                      }
                    }
                    return;
                  }
                }
                if (ss._lastTurnAborted) {
                  ss._lastTurnAborted = false;
                }
                ss.effectivePromptText = effectivePromptText;
                scheduleSilentBrainAbort(promptSessionPath, ss);
                await hub.send(
                  effectivePromptText,
                  msg.images
                    ? { images: msg.images, sessionPath: promptSessionPath, streamToken, disableTools: disableTurnTools, turnInstruction: noToolTurnInstruction }
                    : { sessionPath: promptSessionPath, streamToken, disableTools: disableTurnTools, turnInstruction: noToolTurnInstruction },
                );
                if (!ss.isStreaming) {
                  if (hasToolExecutionInFlight(ss)) {
                    scheduleToolFinalizationFallback(promptSessionPath, ss);
                    debugLog()?.log("ws", `[HUB-SEND v2] returned while tool is still in flight count=${ss.activeToolCallCount || 0}, recovered=${!!ss.recoveredBashInFlight}; defer close · ${promptSessionPath}`);
                  } else {
                    clearTurnTimers(ss);
                    if (!finalizeReturnedTurnWithoutStream(promptSessionPath, ss, "hub_send_returned_closed_without_turn_end")) {
                      broadcast({ type: "status", isStreaming: false, sessionPath: promptSessionPath });
                    }
                  }
                } else if (!hasToolExecutionInFlight(ss) && finalizeReturnedTurnWithoutStream(promptSessionPath, ss, "hub_send_returned_open_without_turn_end", { requirePersistedText: true })) {
                  // finalized from the persisted non-streaming assistant message
                } else {
                  scheduleReturnedTurnFinalizationFallback(promptSessionPath, ss, "hub_send_returned_open_safety_timeout");
                  debugLog()?.log("ws", `hub.send returned while server stream remains open · ${promptSessionPath}`);
                }
              } catch (err: any) {
                clearTurnTimers(ss);
                const aborted = err.message?.includes("aborted");
                if (!aborted) {
                  wsSend(ws, { type: "error", message: err.message, sessionPath: promptSessionPath });
                  if (ss) ss.hasError = true;
                } else if (!ss.hasOutput && !ss.hasToolCall && !ss.hasThinking && !ss.hasError) {
                  wsSend(ws, { type: "error", message: t("error.modelNoResponse"), sessionPath: promptSessionPath });
                }
                if (ss && !hasStreamEvent(ss, "turn_end")) {
                  closeStreamAfterError(promptSessionPath, ss);
                } else {
                  broadcast({ type: "status", isStreaming: false, sessionPath: promptSessionPath });
                }
              }
            }
          })().catch((err: any) => {
            const appErr = AppError.wrap(err);
            errorBus.report(appErr, { context: { wsMessageType: msg.type } });
            if (!appErr.message?.includes('aborted')) {
              wsSend(ws, { type: 'error', message: appErr.message || 'Unknown error', error: appErr.toJSON() });
            }
          });
        },

        onError(event: any, _ws: any) {
          const err = event.error || event;
          console.error("[ws] error:", err.message || err);
          debugLog()?.error("ws", err.message || String(err));
        },

        onClose(event: any, ws: any) {
          if (closed) return;
          closed = true;
          activeWsClients = Math.max(0, activeWsClients - 1);
          clients.delete(ws);
          debugLog()?.log("ws", "client disconnected");
          scheduleDisconnectAbort();
          if (activeWsClients === 0) {
            for (const [sp, ss] of sessionState) {
              if (!ss.isStreaming) sessionState.delete(sp);
            }
          }
        },
      };
    })
  );

  return { restRoute, wsRoute, broadcast, editRollbackStore, lifecycleHooks };
}
