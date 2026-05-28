/**
 * WebSocket 聊天路由
 *
 * 桥接 Pi SDK streaming 事件 → WebSocket 消息
 * 支持多 session 并发：后台 session 静默运行，只转发当前活跃 session 的事件
 */
import fs from "fs";
import path from "path";
import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import { wsSend, wsParse } from "../ws-protocol.js";
import { debugLog } from "../../lib/debug-log.js";
import { t, getLocale } from "../i18n.js";
import { BrowserManager } from "../../lib/browser/browser-manager.js";
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
  normalizeVisionPromptText,
} from "../../shared/vision-prompt.js";
import {
  beginSessionStream,
  finishSessionStream,
  resumeSessionStream,
} from "../session-stream-store.js";
import { AppError } from "../../shared/errors.js";
import { errorBus } from "../../shared/error-bus.js";
import {
  BRAIN_DEFAULT_MODEL_ID,
  BRAIN_PROVIDER_ID,
} from "../../shared/brain-provider.js";
import {
  clearPersistedFinalAnswerPollTimer,
  clearReturnedTurnFinalizationTimer,
  clearSilentBrainAbortTimer,
  clearToolAuthorizationPollTimer,
  clearToolAuthorizationTimer,
  clearToolFinalizationTimer,
  clearTurnHardAbortTimer,
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
import { buildLocalOfficeDirectAnswer } from "../chat/local-office-answer.js";
import { createTokenBucketRateLimiter } from "../chat/rate-limit.js";
import {
  appendTextToLatestAssistantInMemory,
  appendTextToLatestAssistantRecord,
  countPersistedAssistantMessages,
  countPersistedAssistantVisibleTexts,
  ensureSessionFileOnDisk,
  extractLatestAssistantVisibleText,
  extractLatestAssistantVisibleTextAfter,
  persistLocalQwen35DirectTurn,
} from "../chat/session-persistence.js";
import {
  LOCAL_QWEN35_DIRECT_ENDPOINT,
  LOCAL_QWEN35_EMPTY_CONTENT_FALLBACK_MESSAGE,
  LOCAL_QWEN35_DIRECT_MAX_TOKENS,
  LOCAL_QWEN35_DIRECT_PREFETCH_MAX_TOKENS,
  appendNoThinkHintToLastUserMessage,
  buildLocalQwen35DirectMessages,
  resolveLocalQwen35DirectMaxTokens,
  resolveLocalQwen35DirectThinking,
  shouldRetryLocalQwen35WithoutThinking,
  shouldUseLocalQwen35DirectBridge,
} from "../chat/local-qwen35-direct-policy.js";
import {
  TOOL_ARG_SUMMARY_KEYS,
  buildPrefetchToolSummary,
  normalizeToolArgsForSummary,
  rememberFailedTool,
  rememberSuccessfulTool,
  summarizeToolExecution,
} from "../chat/tool-summary.js";
import { streamLocalQwen35Completion } from "../chat/local-qwen35-direct-runner.js";
import {
  attachLocalQwen35BenchContext,
  isLocalQwen35Model,
  LOCAL_QWEN35_MODEL_ID,
  LOCAL_QWEN35_PROVIDER_ID,
} from "../chat/local-qwen35-bench-context.js";
import {
  artifactPreviewDedupeKey,
  artifactPreviewFromToolCall,
} from "../chat/artifact-recovery.js";
import { normalizeArtifactPayload } from "../chat/artifact-shape.js";
import {
  consumeMutationConfirmation,
  recordPendingDeleteRequest,
} from "../chat/turn-retry-policy.js";
import { extractProviderRouteMeta } from "../chat/provider-route-meta.js";
import { createStreamEmitters } from "../chat/stream-emitters.js";
import { createChatRouteContext } from "../chat/chat-route-context.js";
import { generateSessionTitle } from "../chat/title-generator.js";

type TimerHandle = ReturnType<typeof setTimeout>;
type IntervalHandle = ReturnType<typeof setInterval>;
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

function resolveEditSnapshotPath(session: any, engine: any, rawPath: any) {
  if (typeof rawPath !== "string") return null;
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.includes("\0")) return null;
  if (path.isAbsolute(trimmed)) return path.resolve(trimmed);

  const cwd = session?.sessionManager?.getCwd?.() || engine.cwd || process.cwd();
  return path.resolve(cwd, trimmed);
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

  function closeStreamWithVisibleFallback(sessionPath: any, ss: any, text: any, reason: any, opts: any = {}) {
    if (!sessionPath || !ss || ss._turnClosed || hasStreamEvent(ss, "turn_end")) return false;
    ss._turnClosed = true;
    ss.internalRetryPending = false;
    ss.internalRetryInFlight = false;
    ss.internalRetryReason = "";
    clearTurnTimers(ss);
    editRollbackStore.discardPendingForSession(sessionPath, ss.activeStreamToken || null);
    if (ss.isThinking) {
      ss.isThinking = false;
      emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
    }
    if (text && (!ss.hasOutput || opts.appendEvenIfHasOutput)) {
      const prefix = ss.hasOutput && opts.appendEvenIfHasOutput ? "\n\n" : "";
      if (opts.trustedFallback) {
        emitTrustedVisibleTextDelta(sessionPath, ss, prefix + text);
      } else {
        emitVisibleTextDelta(sessionPath, ss, prefix + text);
      }
    }
    maybeAppendCodeVerificationPostscript(sessionPath, ss);
    emitStreamEvent(sessionPath, ss, { type: "turn_end" });
    lifecycleHooks.run("turn_close", { sessionPath, ss, reason, forced: true });
    broadcast({ type: "status", isStreaming: false, sessionPath });
    finishSessionStream(ss);
    resetCompletedTurnState(ss);
    debugLog()?.warn("ws", `[TURN-CLOSE-FALLBACK v1] closed stream · reason=${reason} · session=${sessionPath}`);
    return true;
  }

  function normalizeVisibleForCompare(text: any) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function isMeaningfulPersistedFinalText(finalText: any, ss: any) {
    const final = normalizeVisibleForCompare(finalText);
    if (!final) return false;
    const visible = normalizeVisibleForCompare(ss?.visibleTextAcc || "");
    if (!visible) return true;
    if (final === visible) return false;
    if (final.length <= visible.length + 20 && (final.includes(visible) || visible.includes(final))) return false;
    return true;
  }

  function buildEmptyTurnFallbackText(ss: any, reason: any = "") {
    if (!ss || ss.hasOutput) return "";
    const toolFallback = String(ss.realtimeToolFallbackText || "").trim();
    if (toolFallback) return toolFallback;
    if (reason === "hard_turn_timeout" && !ss.hasToolCall) {
      return buildLocalOfficeDirectAnswer(ss.originalPromptText || ss.effectivePromptText || "");
    }
    return "";
  }

  function buildRealtimeToolFallbackText(toolName: any, event: any) {
    const name = String(toolName || event?.toolName || "");
    if (!["stock_market", "weather", "live_news", "sports_score"].includes(name)) return "";
    const text = extractText(event?.result?.content || "").trim();
    if (!text) return "";
    if (name === "stock_market") {
      const disclaimer = /不构成投资建议|not investment advice/i.test(text)
        ? ""
        : "\n\n说明：以上是工具返回的最近可用行情摘要，不构成投资建议；关键价格、时间戳和来源请以交易所、券商或专门行情源交叉核验。";
      return `${text}${disclaimer}`;
    }
    return text;
  }

  function finalizeReturnedTurnWithoutStream(sessionPath: any, ss: any, reason: any, opts: any = {}) {
    if (!sessionPath || !ss || ss._turnClosed || hasStreamEvent(ss, "turn_end")) return false;
    if (hasToolExecutionInFlight(ss)) return false;
    if (!opts.ignoreInternalRetry && hasScheduledInternalRetry(ss)) return false;
    const session = engine.getSessionByPath(sessionPath);
    const finalText = !ss.hasOutput
      ? extractLatestAssistantVisibleText(session, sessionPath)
      : "";
    if (opts.requirePersistedText && !ss.hasOutput && !finalText) return false;
    return closeStreamWithVisibleFallback(sessionPath, ss, finalText, reason);
  }

  function scheduleReturnedTurnFinalizationFallback(sessionPath: any, ss: any, reason: any) {
    clearReturnedTurnFinalizationTimer(ss);
    if (!sessionPath || !ss || !RETURNED_TURN_FINALIZATION_GRACE_MS) return false;
    const streamToken = ss.activeStreamToken || null;
    ss.returnedTurnFinalizationTimer = setTimeout(() => {
      ss.returnedTurnFinalizationTimer = null;
      if (
        hasDifferentActiveStreamToken(ss, streamToken) ||
        ss.hasError ||
        ss._turnClosed ||
        hasStreamEvent(ss, "turn_end") ||
        hasToolExecutionInFlight(ss) ||
        hasScheduledInternalRetry(ss)
      ) {
        return;
      }
      // hub.send may return before the provider SSE has delivered final text.
      // Do not synthesize or strip output here; only finalize when there is
      // already persisted assistant text to show.
      finalizeReturnedTurnWithoutStream(sessionPath, ss, reason, { requirePersistedText: true });
    }, RETURNED_TURN_FINALIZATION_GRACE_MS);
    if (ss.returnedTurnFinalizationTimer.unref) ss.returnedTurnFinalizationTimer.unref();
    return true;
  }

  function schedulePersistedFinalAnswerPoll(sessionPath: any, ss: any) {
    clearPersistedFinalAnswerPollTimer(ss);
    if (!sessionPath || !ss) return false;
    const streamToken = ss.activeStreamToken || null;
    ss.persistedFinalAnswerPollTimer = setInterval(() => {
      if (
        hasDifferentActiveStreamToken(ss, streamToken) ||
        ss.hasError ||
        ss.hasOutput ||
        ss._turnClosed ||
        hasStreamEvent(ss, "turn_end") ||
        hasScheduledInternalRetry(ss)
      ) {
        clearPersistedFinalAnswerPollTimer(ss);
        return;
      }
      if (hasToolExecutionInFlight(ss)) return;
      const finalText = extractLatestAssistantVisibleTextAfter(
        engine.getSessionByPath(sessionPath),
        sessionPath,
        ss.persistedAssistantTextBaseline || 0,
      );
      if (finalText) {
        closeStreamWithVisibleFallback(sessionPath, ss, finalText, "persisted_final_answer_poll");
      }
    }, 1000);
    if (ss.persistedFinalAnswerPollTimer.unref) ss.persistedFinalAnswerPollTimer.unref();
    return true;
  }

  function scheduleTurnHardAbort(sessionPath: any, ss: any) {
    clearTurnHardAbortTimer(ss);
    if (!sessionPath || !ss || !TURN_HARD_ABORT_MS) return;
    const streamToken = ss.activeStreamToken || null;
    const originalOrEffectivePrompt = `${ss.originalPromptText || ""}\n${ss.effectivePromptText || ""}`;
    const isLongResearchTurn =
      /(?:深度|深入|完整|系统性|多维度|全面|调研|研究|研报|报告|分析报告|形成\s*docx|docx\s*格式|来源包括|但不限于|学术界|咨询领域|小红书|抖音|快手|视频号|公众号)/i.test(originalOrEffectivePrompt);
    const timeoutMs = isLongResearchTurn
      ? Math.max(TURN_HARD_ABORT_MS, TURN_LONG_RESEARCH_HARD_ABORT_MS || TURN_HARD_ABORT_MS)
      : TURN_HARD_ABORT_MS;
    if (isLongResearchTurn && timeoutMs !== TURN_HARD_ABORT_MS) {
      debugLog()?.log("ws", `[TURN-HARD-ABORT v2] long research turn timeout=${timeoutMs}ms · session=${sessionPath}`);
    }
    ss.turnHardAbortTimer = setTimeout(() => {
      ss.turnHardAbortTimer = null;
      if (hasDifferentActiveStreamToken(ss, streamToken) || ss.hasError || hasStreamEvent(ss, "turn_end")) return;
      ss._lastTurnAborted = true;
      Promise.resolve(engine.abortSessionByPath?.(sessionPath)).catch(() => {});
      closeStreamWithVisibleFallback(
        sessionPath,
        ss,
        buildEmptyTurnFallbackText(ss, "hard_turn_timeout"),
        "hard_turn_timeout",
        { trustedFallback: true },
      );
    }, timeoutMs);
    if (ss.turnHardAbortTimer.unref) ss.turnHardAbortTimer.unref();
  }

  function scheduleToolFinalizationFallback(sessionPath: any, ss: any) {
    clearToolFinalizationTimer(ss);
    if (!sessionPath || !ss || !TOOL_FINALIZATION_GRACE_MS) return;
    const streamToken = ss.activeStreamToken || null;
    ss.toolFinalizationTimer = setTimeout(() => {
      ss.toolFinalizationTimer = null;
      if (
        hasDifferentActiveStreamToken(ss, streamToken) ||
        ss.hasError ||
        hasStreamEvent(ss, "turn_end")
      ) {
        return;
      }
      if (hasToolExecutionInFlight(ss)) {
        flushBufferedAssistantText(sessionPath, ss);
        const toolStartedAt = Number.isFinite(ss.activeToolCallStartedAt)
          ? ss.activeToolCallStartedAt
          : (Number.isFinite(ss.lastToolExecutionActivity) ? ss.lastToolExecutionActivity : Date.now());
        const toolAgeMs = Date.now() - toolStartedAt;
        if ((ss.hasOutput || ss.hasBufferedVisibleTextDuringTool) && toolAgeMs >= TOOL_FINALIZATION_GRACE_MS) {
          const finalText = extractLatestAssistantVisibleTextAfter(
            engine.getSessionByPath(sessionPath),
            sessionPath,
            ss.persistedAssistantTextBaseline || 0,
          );
          ss.activeToolCallCount = 0;
          ss.activeToolCallStartedAt = null;
          ss.recoveredBashInFlight = false;
          flushBufferedToolVisibleText(
            sessionPath,
            ss,
            isMeaningfulPersistedFinalText(finalText, ss) ? finalText : "",
          );
          debugLog()?.warn("ws", `[TOOL-MISSING-END-FENCE v1] closing turn with visible output despite missing tool_end · age=${toolAgeMs}ms · session=${sessionPath}`);
          Promise.resolve(engine.abortSessionByPath?.(sessionPath)).catch(() => {});
          closeStreamWithVisibleFallback(
            sessionPath,
            ss,
            "",
            "tool_missing_end_after_output",
          );
          return;
        }
        scheduleToolFinalizationFallback(sessionPath, ss);
        return;
      }
      Promise.resolve(engine.abortSessionByPath?.(sessionPath)).catch(() => {});
      if (ss.hasBufferedVisibleTextDuringTool && !ss.hasOutput) {
        const finalText = extractLatestAssistantVisibleTextAfter(
          engine.getSessionByPath(sessionPath),
          sessionPath,
          ss.persistedAssistantTextBaseline || 0,
        );
        flushBufferedToolVisibleText(
          sessionPath,
          ss,
          isMeaningfulPersistedFinalText(finalText, ss) ? finalText : "",
        );
      }
      closeStreamWithVisibleFallback(
        sessionPath,
        ss,
        buildEmptyTurnFallbackText(ss, "tool_finalization_timeout"),
        "tool_finalization_timeout",
        { trustedFallback: true },
      );
    }, TOOL_FINALIZATION_GRACE_MS);
    if (ss.toolFinalizationTimer.unref) ss.toolFinalizationTimer.unref();
  }

  function scheduleToolAuthorizationFallback(sessionPath: any, ss: any) {
    clearToolAuthorizationTimer(ss);
    clearToolAuthorizationPollTimer(ss);
    if (!sessionPath || !ss || !TOOL_AUTHORIZATION_GRACE_MS || !ss.isStreaming || ss._turnClosed || hasStreamEvent(ss, "turn_end")) return;
    clearSilentBrainAbortTimer(ss);
    const streamToken = ss.activeStreamToken || null;
    ss.toolAuthorizationPollTimer = setInterval(() => {
      if (
        hasDifferentActiveStreamToken(ss, streamToken) ||
        ss.hasError ||
        hasStreamEvent(ss, "turn_end")
      ) {
        clearToolAuthorizationPollTimer(ss);
        return;
      }
      const finalText = extractLatestAssistantVisibleText(engine.getSessionByPath(sessionPath), sessionPath);
      if (isMeaningfulPersistedFinalText(finalText, ss)) {
        if (hasToolExecutionInFlight(ss)) return;
        closeStreamWithVisibleFallback(sessionPath, ss, finalText, "tool_authorization_persisted_final");
      }
    }, 1000);
    if (ss.toolAuthorizationPollTimer.unref) ss.toolAuthorizationPollTimer.unref();
    ss.toolAuthorizationTimer = setTimeout(() => {
      ss.toolAuthorizationTimer = null;
      if (hasDifferentActiveStreamToken(ss, streamToken) || ss.hasError || hasStreamEvent(ss, "turn_end")) return;
      if (hasToolExecutionInFlight(ss)) {
        scheduleToolAuthorizationFallback(sessionPath, ss);
        return;
      }
      Promise.resolve(engine.abortSessionByPath?.(sessionPath)).catch(() => {});
      const finalText = extractLatestAssistantVisibleText(engine.getSessionByPath(sessionPath), sessionPath);
      const meaningfulFinalText = isMeaningfulPersistedFinalText(finalText, ss) ? finalText : "";
      closeStreamWithVisibleFallback(
        sessionPath,
        ss,
        meaningfulFinalText || "",
        "tool_authorization_timeout",
      );
    }, TOOL_AUTHORIZATION_GRACE_MS);
    if (ss.toolAuthorizationTimer.unref) ss.toolAuthorizationTimer.unref();
  }

  function scheduleSilentBrainAbort(sessionPath: any, ss: any) {
    clearSilentBrainAbortTimer(ss);
  }

  const clients = new Set<any>();

  const editRollbackStore = createEditRollbackStore({ maxSnapshots: 200 });

  function broadcast(msg: any) {
    for (const client of clients) {
      wsSend(client as any, msg);
    }
  }

  // 浏览器缩略图 30s 定时刷新
  let _browserThumbTimer: IntervalHandle | null = null;
  function startBrowserThumbPoll() {
    if (_browserThumbTimer) return;
    _browserThumbTimer = setInterval(async () => {
      const browser = BrowserManager.instance();
      if (!browser.isRunning) { stopBrowserThumbPoll(); return; }
      const thumbnail = await browser.thumbnail();
      if (thumbnail) {
        broadcast({ type: "browser_status", running: true, url: browser.currentUrl, thumbnail });
      }
    }, 30_000);
  }
  function stopBrowserThumbPoll() {
    if (_browserThumbTimer) { clearInterval(_browserThumbTimer); _browserThumbTimer = null; }
  }

  function emitFileOutputsFromDetails(sessionPath: any, ss: any, details: any = {}) {
    const files = Array.isArray(details.files) ? [...details.files] : [];
    if (files.length === 0 && details.filePath) {
      files.push({ filePath: details.filePath, label: details.label, ext: details.ext || "" });
    }
    if (!ss.emittedFileOutputPaths || typeof ss.emittedFileOutputPaths.has !== "function") {
      ss.emittedFileOutputPaths = new Set();
    }
    let emitted = 0;
    for (const f of files) {
      if (!f?.filePath) continue;
      const key = path.resolve(String(f.filePath));
      if (ss.emittedFileOutputPaths.has(key)) continue;
      ss.emittedFileOutputPaths.add(key);
      emitStreamEvent(sessionPath, ss, {
        type: "file_output",
        filePath: f.filePath,
        label: f.label || path.basename(f.filePath),
        ext: f.ext || path.extname(f.filePath).replace(/^\./, ""),
      });
      emitted += 1;
    }
    return emitted;
  }

  function emitRecoveredArtifact(sessionPath: any, ss: any, artifact: any, source: any = "toolcall") {
    if (!ss || !artifact?.content) return false;
    ss.recoveredArtifactKeys = ss.recoveredArtifactKeys || new Set();
    const key = artifactPreviewDedupeKey(artifact);
    if (ss.recoveredArtifactKeys.has(key)) return false;
    ss.recoveredArtifactKeys.add(key);
    ss.hasOutput = true;
    emitStreamEvent(sessionPath, ss, artifact);
    debugLog()?.log("ws", `recovered artifact from ${source} · tool=${artifact.recoveredFromTool || "unknown"} · title=${artifact.title || ""} · session=${sessionPath || "unknown"}`);
    return true;
  }

  function maybeRecoverArtifactFromMessageUpdate(sessionPath: any, ss: any, event: any, source: any = "message_update") {
    const sub = event?.assistantMessageEvent;
    const preview = artifactPreviewFromToolCall(sub?.toolCall);
    return preview ? emitRecoveredArtifact(sessionPath, ss, preview, source) : false;
  }

  function closeStreamAfterError(sessionPath: any, ss: any) {
    if (!sessionPath || !ss || hasStreamEvent(ss, "turn_end")) return;
    if (!ss.hasOutput && !ss.hasToolCall) ss._lastTurnAborted = true;
    closeStreamWithVisibleFallback(sessionPath, ss, "", "model_tool_error");
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

  function startLocalQwen35PrefetchFeedback(sessionPath: any, ss: any, toolName: any, promptText: any) {
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
    // Local llama.cpp streams may finish with a short final chunk still held by
    // the ThinkTag/Mood/Xing parsers. Flush before turn_end so the real model
    // output is visible immediately instead of only appearing after reload.
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

  function isAssistantStreamScopedEvent(event: any) {
    return event?.type === "message_update"
      || event?.type === "tool_execution_start"
      || event?.type === "tool_execution_end"
      || event?.type === "turn_end"
      || event?.type === "provider_meta"
      || event?.type === "provider_update"
      || event?.type === "lynn.provider"
      || event?.object === "lynn.provider";
  }

  // 单订阅：事件只写入一次，再按需广播到所有连接中的客户端。
  hub.subscribe((event: any, sessionPath: any) => {
    const isActive = sessionPath === engine.currentSessionPath;
    const ss = sessionPath ? sessionState.get(sessionPath) : null;

    if (isAssistantStreamScopedEvent(event) && (!ss || !ss.isStreaming)) {
      if (event?.type === "message_update" && ss) {
        maybeRecoverArtifactFromMessageUpdate(sessionPath, ss, event, "late_message_update");
      }
      debugLog()?.warn("ws", `ignored late stream event after turn close · type=${event?.type} · session=${sessionPath || "unknown"}`);
      return;
    }
    const eventStreamToken = event?._hubContext?.streamToken || null;
    if (isAssistantStreamScopedEvent(event) && eventStreamToken && ss?.activeStreamToken && eventStreamToken !== ss.activeStreamToken) {
      debugLog()?.warn("ws", `ignored stale stream event · type=${event?.type} · eventStream=${eventStreamToken} activeStream=${ss.activeStreamToken} · session=${sessionPath || "unknown"}`);
      return;
    }

    const providerRouteMeta = extractProviderRouteMeta(event);
    if (providerRouteMeta) {
      if (!ss) return;
      emitStreamEvent(sessionPath, ss, { type: "provider_meta", ...providerRouteMeta });
      return;
    }

    if (event.type === "message_update") {
      if (!ss) return;
      const sub = event.assistantMessageEvent?.type;

      if (sub === "text_delta") {
        if (ss.isThinking) {
          ss.isThinking = false;
          emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
        }

        const delta = event.assistantMessageEvent.delta;
        feedAssistantVisibleText(sessionPath, ss, delta);
      } else if (sub === "thinking_delta") {
        ss.hasThinking = true;
        if (!ss.isThinking) {
          ss.isThinking = true;
          emitStreamEvent(sessionPath, ss, { type: "thinking_start" });
        }
        emitStreamEvent(sessionPath, ss, {
          type: "thinking_delta",
          delta: event.assistantMessageEvent.delta || "",
        });
      } else if (sub === "toolcall_start") {
        // 不在这里关闭 thinking 状态
      } else if (sub === "toolcall_end") {
        maybeRecoverArtifactFromMessageUpdate(sessionPath, ss, event, "toolcall_end");
      } else if (sub === "error") {
        ss.hasError = true;
        if (isActive) broadcast({ type: "error", message: event.assistantMessageEvent.error || "Unknown error" });
        closeStreamAfterError(sessionPath, ss);
      }
    } else if (event.type === "tool_execution_start") {
      if (!ss) return;
      ss.hasToolCall = true;
      ss.activeToolCallCount = Math.max(0, Number(ss.activeToolCallCount || 0)) + 1;
      ss.lastToolExecutionActivity = Date.now();
      if (Number(ss.activeToolCallCount || 0) === 1) {
        ss.activeToolCallStartedAt = ss.lastToolExecutionActivity;
      }
      if (ss.isThinking) {
        ss.isThinking = false;
        emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
      }

      if ((event.toolName === "edit" || event.toolName === "edit-diff") && event.toolCallId) {
        const session = engine.getSessionByPath(sessionPath);
        const rawPath = event.args?.file_path || event.args?.path || "";
        const resolvedPath = resolveEditSnapshotPath(session, engine, rawPath);

        if (resolvedPath) {
          try {
            const originalContent = fs.readFileSync(resolvedPath, "utf-8");
            editRollbackStore.setPending(event.toolCallId, {
              sessionPath,
              streamToken: typeof ss.activeStreamToken === "string" ? ss.activeStreamToken : null,
              cwd: session?.sessionManager?.getCwd?.() || engine.cwd || process.cwd(),
              filePath: resolvedPath,
              originalContent,
            });
          } catch {
            editRollbackStore.discardPending(event.toolCallId);
          }
        }
      }

      const rawArgs = normalizeToolArgsForSummary(event.toolName || "", event.args);
      let args: AnyRecord | undefined;
      if (rawArgs && typeof rawArgs === "object") {
        args = {};
        const rawArgRecord = rawArgs as AnyRecord;
        for (const k of TOOL_ARG_SUMMARY_KEYS) { if (rawArgRecord[k] !== undefined) args[k] = rawArgRecord[k]; }
      }
      emitStreamEvent(sessionPath, ss, { type: "tool_start", name: event.toolName || "", args });
      lifecycleHooks.run("tool_start", {
        event,
        ss,
        sessionPath,
        toolName: event.toolName || "",
        args,
      });
      try {
        const __slowName = event.toolName || "";
        const __slowToolCallId = event.toolCallId || null;
        const __slowTimer = setTimeout(() => {
          try { emitStreamEvent(sessionPath, ss, { type: "tool_progress", name: __slowName, event: "slow_warning", elapsedMs: 15000, toolCallId: __slowToolCallId }); } catch { /* stream may have closed */ }
        }, 15000);
        ss.__slowToolTimers = ss.__slowToolTimers || new Map();
        ss.__slowToolTimers.set(__slowToolCallId || __slowName, __slowTimer);
      } catch {
        // Slow-tool warnings are best-effort progress hints.
      }
    } else if (event.type === "tool_execution_end") {
      if (!ss) return;
      ss.activeToolCallCount = Math.max(0, Number(ss.activeToolCallCount || 0) - 1);
      ss.lastToolExecutionActivity = Date.now();
      if (Number(ss.activeToolCallCount || 0) === 0) {
        ss.activeToolCallStartedAt = null;
      }
      try {
        const __key = event.toolCallId || event.toolName || "";
        const __t = ss.__slowToolTimers?.get(__key);
        if (__t) { clearTimeout(__t); ss.__slowToolTimers?.delete(__key); }
      } catch {
        // Timer cleanup should never fail the tool result path.
      }

      const {
        rawDetails,
        summary: toolSummary,
        toolName,
        normalizedArgs,
        toolIsError,
        publicSummary,
      } = summarizeToolExecution(event);

      emitStreamEvent(sessionPath, ss, {
        type: "tool_end",
        name: toolName,
        success: !toolIsError,
        details: rawDetails,
        summary: publicSummary,
      });
      lifecycleHooks.run("tool_end", {
        event,
        ss,
        sessionPath,
        toolName,
        success: !toolIsError,
        summary: publicSummary,
      });

      if (!toolIsError) {
        rememberSuccessfulTool(ss, toolName, toolSummary, normalizedArgs);
        const realtimeToolFallback = buildRealtimeToolFallbackText(toolName, event);
        if (realtimeToolFallback) ss.realtimeToolFallbackText = realtimeToolFallback;
      } else {
        rememberFailedTool(ss, toolName);
      }
      clearToolAuthorizationTimer(ss);
      scheduleToolFinalizationFallback(sessionPath, ss);

      if ((toolName === "edit" || toolName === "edit-diff") && event.toolCallId) {
        if (toolIsError || !rawDetails.diff) {
          editRollbackStore.discardPending(event.toolCallId);
        }
      }

      if (event.toolName === "present_files" || event.toolName === "create_docx" || event.toolName === "create_pptx" || event.toolName === "create_report" || event.toolName === "create_poster") {
        emitFileOutputsFromDetails(sessionPath, ss, event.result?.details || {});
      }

      if (event.toolName === "write" && !toolIsError && toolSummary.filePath) {
        emitFileOutputsFromDetails(sessionPath, ss, {
          filePath: toolSummary.filePath,
          label: path.basename(toolSummary.filePath),
          ext: path.extname(toolSummary.filePath).replace(/^\./, ""),
        });
      }

      if ((event.toolName === "edit" || event.toolName === "edit-diff") && rawDetails.diff && !toolIsError) {
        const diffFilePath = event.args?.file_path || event.args?.path || "";
        const rollback = event.toolCallId ? editRollbackStore.finalize(event.toolCallId) : null;
        emitStreamEvent(sessionPath, ss, {
          type: "file_diff",
          filePath: diffFilePath,
          diff: rawDetails.diff,
          linesAdded: toolSummary.linesAdded || 0,
          linesRemoved: toolSummary.linesRemoved || 0,
          rollbackId: rollback?.rollbackId,
        });
      }

      if (event.toolName === "create_artifact" || event.toolName === "create_report") {
        const d = event.result?.details || {};
        const artifact = normalizeArtifactPayload(d, { messageType: "artifact" });
        if (artifact) {
          emitStreamEvent(sessionPath, ss, artifact as AnyRecord);
        }
      }

      if (event.toolName === "browser") {
        const d = event.result?.details || {};
        if (d.action === "screenshot" && event.result?.content) {
          const imgBlock = event.result.content.find((c: any) => c.type === "image");
          if (imgBlock?.data) {
            emitStreamEvent(sessionPath, ss, {
              type: "browser_screenshot",
              base64: imgBlock.data,
              mimeType: imgBlock.mimeType || "image/jpeg",
            });
          }
        }

        const statusMsg: AnyRecord = {
          type: "browser_status",
          running: d.running ?? false,
          url: d.url || null,
        };
        if (d.thumbnail) statusMsg.thumbnail = d.thumbnail;
        emitStreamEvent(sessionPath, ss, statusMsg);
        if (statusMsg.running) startBrowserThumbPoll();
        else stopBrowserThumbPoll();
      }

      if (event.toolName === "cron") {
        const d = event.result?.details || {};
        if (d.action === "pending_add" && d.jobData) {
          emitStreamEvent(sessionPath, ss, { type: "cron_confirmation", jobData: d.jobData });
        }
      }

      if (isActive && ["write", "edit", "bash"].includes(event.toolName)) {
        broadcast({ type: "desk_changed" });
      }
    } else if (event.type === "jian_update") {
      broadcast({ type: "jian_update", content: event.content });
    } else if (event.type === "devlog") {
      broadcast({ type: "devlog", text: event.text, level: event.level });
    } else if (event.type === "browser_bg_status") {
      broadcast({ type: "browser_bg_status", running: event.running, url: event.url });
    } else if (event.type === "cron_confirmation" && event.confirmId) {
      if (!ss) return;
      emitStreamEvent(sessionPath, ss, {
        type: "cron_confirmation",
        confirmId: event.confirmId,
        jobData: event.jobData,
      });
    } else if (event.type === "settings_confirmation") {
      if (!ss) return;
      emitStreamEvent(sessionPath, ss, {
        type: "settings_confirmation",
        confirmId: event.confirmId,
        settingKey: event.settingKey,
        cardType: event.cardType,
        currentValue: event.currentValue,
        proposedValue: event.proposedValue,
        options: event.options,
        optionLabels: event.optionLabels || null,
        label: event.label,
        description: event.description,
        frontend: event.frontend,
      });
    } else if (event.type === "tool_authorization") {
      if (!ss) return;
      emitStreamEvent(sessionPath, ss, {
        type: "tool_authorization",
        confirmId: event.confirmId,
        command: event.command,
        reason: event.reason,
        description: event.description,
        category: event.category,
        identifier: event.identifier,
        trustedRoot: event.trustedRoot || null,
      });
      scheduleToolAuthorizationFallback(sessionPath, ss);
    } else if (event.type === "skill_activated") {
      if (!ss) return;
      emitStreamEvent(sessionPath, ss, {
        type: "skill_activated",
        skillName: event.skillName,
        skillFilePath: event.skillFilePath,
      });
    } else if (event.type === "confirmation_resolved") {
      if (sessionPath && ss && ss.isStreaming && !ss._turnClosed && !hasStreamEvent(ss, "turn_end")) {
        scheduleToolAuthorizationFallback(sessionPath, ss);
      }
      broadcast({
        type: "confirmation_resolved",
        confirmId: event.confirmId,
        action: event.action,
        value: event.value,
      });
    } else if (event.type === "apply_frontend_setting") {
      broadcast({
        type: "apply_frontend_setting",
        key: event.key,
        value: event.value,
      });
    } else if (event.type === "task_update") {
      broadcast({ type: "task_update", task: event.task });
    } else if (event.type === "activity_update") {
      broadcast({ type: "activity_update", activity: event.activity });
    } else if (event.type === "bridge_message") {
      broadcast({ type: "bridge_message", message: event.message });
    } else if (event.type === "bridge_status") {
      broadcast({ type: "bridge_status", platform: event.platform, status: event.status, error: event.error });
    } else if (event.type === "plan_mode") {
      broadcast({ type: "plan_mode", enabled: event.enabled });
    } else if (event.type === "security_mode") {
      broadcast({ type: "security_mode", mode: event.mode });
    } else if (event.type === "notification") {
      broadcast({ type: "notification", title: event.title, body: event.body });
    } else if (event.type === "channel_new_message") {
      broadcast({ type: "channel_new_message", channelName: event.channelName, sender: event.sender });
    } else if (event.type === "channel_archived") {
      broadcast({
        type: "channel_archived",
        channelName: event.channelName,
        archived: event.archived ?? true,
        archivedAt: event.archivedAt || null,
      });
    } else if (event.type === "dm_new_message") {
      broadcast({ type: "dm_new_message", from: event.from, to: event.to });
    } else if (event.type === "turn_end") {
      if (!ss) return;
      if (ss.isThinking) {
        ss.isThinking = false;
        emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
      }
      flushBufferedAssistantText(sessionPath, ss);
      if (hasToolExecutionInFlight(ss)) {
        scheduleToolFinalizationFallback(sessionPath, ss);
        debugLog()?.log("ws", `[TURN-END v4] defer turn_end (tool still in flight count=${ss.activeToolCallCount || 0}, recovered=${!!ss.recoveredBashInFlight}) · hasOutput=${ss.hasOutput} · ${sessionPath}`);
        return;
      }
      if (ss.hasToolCall && !ss.hasError && !ss._turnEndDeferred) {
        ss._turnEndDeferred = true;
        scheduleToolFinalizationFallback(sessionPath, ss);
        debugLog()?.log("ws", `[TURN-END v2] defer tool-phase turn_end (awaiting final assistant text) · hasOutput=${ss.hasOutput} · ${sessionPath}`);
        return;
      }
      if (ss._turnEndDeferred) {
        debugLog()?.log("ws", `[TURN-END v1] resuming deferred turn_end · hasOutput=${ss.hasOutput} hasToolCall=${ss.hasToolCall} · ${sessionPath}`);
      }
      lifecycleHooks.run("turn_end", {
        event,
        ss,
        sessionPath,
        hasOutput: ss.hasOutput,
        hasToolCall: ss.hasToolCall,
      });
      clearTurnTimers(ss);
      if (ss.streamSource === "internal_retry") {
        ss.internalRetryPending = false;
        ss.internalRetryInFlight = false;
        ss.internalRetryReason = "";
      }
      if (ss.isThinking) {
        ss.isThinking = false;
        emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
      }
      maybeAppendCodeVerificationPostscript(sessionPath, ss);
      emitStreamEvent(sessionPath, ss, { type: "turn_end" });
      broadcast({ type: "status", isStreaming: false, sessionPath });
      (async () => {
        try {
          const raw = await readFile(sessionPath, "utf-8").catch(() => "");
          if (!raw) return;
          const lines = raw.split("\n").filter(Boolean);
          for (let i = lines.length - 1; i >= 0; i--) {
            try {
              const entry = JSON.parse(lines[i]);
              const mm = entry?.message;
              if (mm?.role === "assistant" && mm.model) {
                const model = String(mm.model || "").trim();
                const provider = String(mm.provider || "").trim();
                emitStreamEvent(sessionPath, ss, { type: "model_hint", model: provider ? `${provider}/${model}` : model });
                return;
              }
            } catch { /* skip */ }
          }
        } catch { /* non-fatal */ }
      })();
      finishSessionStream(ss);
      if (ss.progressMarkerCount > 0 && !ss.hasToolCall) {
        debugLog()?.warn("ws", `observed ${ss.progressMarkerCount} hallucinated <lynn_tool_progress> markers (no real tool_call) · session=${sessionPath}`);
      }
      resetCompletedTurnState(ss);
      if (isActive) debugLog()?.log("ws", "assistant reply done");
      maybeGenerateFirstTurnTitle(sessionPath, ss);
    } else if (event.type === "auto_compaction_start") {
      broadcast({ type: "compaction_start", sessionPath });
    } else if (event.type === "auto_compaction_end") {
      const s = engine.getSessionByPath(sessionPath);
      const usage = s?.getContextUsage?.();
      broadcast({
        type: "compaction_end",
        sessionPath,
        tokens: usage?.tokens ?? null,
        contextWindow: usage?.contextWindow ?? null,
        percent: usage?.percent ?? null,
      });
    } else if (event.type === "session_relay") {
      broadcast({
        type: "session_relay",
        oldSessionPath: event.oldSessionPath || sessionPath,
        newSessionPath: event.newSessionPath || null,
        summary: event.summary || "",
        summaryTokens: event.summaryTokens ?? null,
        compactionCount: event.compactionCount ?? null,
        reason: event.reason || "auto_compaction_limit",
      });
    }
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
              if (msg.images?.length) {
                const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
                const MAX_IMAGES = 10;
                const MAX_BYTES = 20 * 1024 * 1024;
                if (msg.images.length > MAX_IMAGES) {
                  wsSend(ws, { type: "error", message: t("error.maxImages", { max: MAX_IMAGES }) });
                  return;
                }
                for (const img of msg.images) {
                  if (!img?.mimeType || !ALLOWED_MIME.has(img.mimeType)) {
                    wsSend(ws, { type: "error", message: t("error.unsupportedImageFormat", { mime: img?.mimeType || "unknown" }) });
                    return;
                  }
                  if (img.data && img.data.length > MAX_BYTES) {
                    wsSend(ws, { type: "error", message: t("error.imageTooLarge") });
                    return;
                  }
                }
              }
              const _resolved = engine.resolveModelOverrides(engine.currentModel);
              if (msg.images?.length && _resolved?.vision === false) {
                wsSend(ws, { type: "error", message: buildVisionUnsupportedMessage({ locale: getLocale() }) });
                return;
              }
              const promptText = normalizeVisionPromptText(msg.text || "", msg.images, { locale: getLocale() });
              debugLog()?.log("ws", `user message (${promptText.length} chars, ${msg.images?.length || 0} images)`);
              let promptSessionPath = msg.sessionPath || engine.currentSessionPath;
              if (!promptSessionPath) {
                const createdSession = await engine.createSession(null, engine.homeCwd || process.cwd());
                promptSessionPath = createdSession?.sessionManager?.getSessionFile?.() || engine.currentSessionPath || "";
              }
              ensureSessionFileOnDisk(promptSessionPath);
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
