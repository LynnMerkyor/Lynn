import { debugLog } from "../../lib/debug-log.js";
import { finishSessionStream } from "../session-stream-store.js";
import { buildLocalOfficeDirectAnswer } from "./local-office-answer.js";
import { extractText } from "./content-utils.js";
import {
  clearPersistedFinalAnswerPollTimer,
  clearReturnedTurnFinalizationTimer,
  clearSilentBrainAbortTimer,
  clearToolAuthorizationPollTimer,
  clearToolAuthorizationTimer,
  clearToolFinalizationTimer,
  clearTurnHardAbortTimer,
  clearTurnTimers,
  resetCompletedTurnState,
} from "./stream-state.js";
import {
  extractLatestAssistantVisibleText,
  extractLatestAssistantVisibleTextAfter,
} from "./session-persistence.js";

/**
 * 工具回合结束但模型没有产出收尾文本时的事实行(issue #72 第三类的 GUI 变体:
 * 命令执行成功、授权卡片也在,turn 却静默结束)。V0.79 禁止合成内容 —— 这里
 * 只复述真实 tool_end 计数(stream-state 的 successfulToolCount / lastFailedTools),
 * 不替模型编任何话。纯函数,导出供单测。
 */
export function buildToolCompletionSummary(ss: any): string {
  const okCount = Number(ss?.successfulToolCount || 0);
  const failedTools = Array.isArray(ss?.lastFailedTools) ? ss.lastFailedTools.filter(Boolean).map(String) : [];
  const failCount = ss?.hasFailedTool ? Math.max(1, failedTools.length) : 0;
  if (okCount + failCount === 0) return "";
  // 措辞必须诚实:工具跑完≠任务完成 —— 模型没给总结时,明说"没有总结回复",
  // 不写"✅ 全部成功"那种读起来像任务完成的句式(2026-06-10 用户纠偏:"自报完成")。
  if (failCount === 0) {
    return `已执行 ${okCount} 个操作(工具均成功),但模型没有返回总结回复。可点「编辑重发」让它基于工具结果直接作答,详情见上方工具卡片。`;
  }
  const failDetail = failedTools.length ? `(${failedTools.slice(0, 3).join("、")})` : "";
  return `已执行 ${okCount + failCount} 个操作:${okCount} 个成功,${failCount} 个失败${failDetail},且模型没有返回总结回复。可点「编辑重发」重试,详情见上方工具卡片。`;
}

export interface ToolTurnFinalizerDeps {
  engine: any;
  editRollbackStore: any;
  lifecycleHooks: any;
  broadcast: (msg: any) => void;
  emitStreamEvent: (sessionPath: string, ss: any, event: any) => void;
  emitTrustedVisibleTextDelta: (sessionPath: string, ss: any, delta: unknown) => boolean;
  emitVisibleTextDelta: (sessionPath: string, ss: any, delta: unknown) => void;
  flushBufferedAssistantText: (sessionPath: string, ss: any) => void;
  flushBufferedToolVisibleText: (sessionPath: string, ss: any, finalText?: string) => void;
  maybeAppendCodeVerificationPostscript: (sessionPath: string, ss: any) => boolean;
  hasStreamEvent: (ss: any, type: string) => boolean;
  hasScheduledInternalRetry: (ss: any) => boolean;
  hasToolExecutionInFlight: (ss: any) => boolean;
  hasDifferentActiveStreamToken: (ss: any, streamToken: any) => boolean;
  timeouts: {
    returnedTurnFinalizationGraceMs: number;
    turnHardAbortMs: number;
    turnLongResearchHardAbortMs: number;
    toolFinalizationGraceMs: number;
    toolAuthorizationGraceMs: number;
  };
}

export function createToolTurnFinalizer({
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
  timeouts,
}: ToolTurnFinalizerDeps) {
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
    // 工具都跑完了但模型没给收尾文本(issue #72 第三类的 GUI 变体:"有授权卡片但最后没有反馈")。
    // V0.79 禁止编造内容 —— 这里只输出基于真实 tool_end 计数的事实行,不替模型说话。
    return buildToolCompletionSummary(ss);
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
    if (!sessionPath || !ss || !timeouts.returnedTurnFinalizationGraceMs) return false;
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
      finalizeReturnedTurnWithoutStream(sessionPath, ss, reason, { requirePersistedText: true });
    }, timeouts.returnedTurnFinalizationGraceMs);
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
    if (!sessionPath || !ss || !timeouts.turnHardAbortMs) return;
    const streamToken = ss.activeStreamToken || null;
    const originalOrEffectivePrompt = `${ss.originalPromptText || ""}\n${ss.effectivePromptText || ""}`;
    const isLongResearchTurn =
      /(?:深度|深入|完整|系统性|多维度|全面|调研|研究|研报|报告|分析报告|形成\s*docx|docx\s*格式|来源包括|但不限于|学术界|咨询领域|小红书|抖音|快手|视频号|公众号)/i.test(originalOrEffectivePrompt);
    const deterministicFallbackText = buildLocalOfficeDirectAnswer(ss.originalPromptText || ss.effectivePromptText || "");
    const localOfficeFallbackMs = Number(process.env.LYNN_LOCAL_OFFICE_FALLBACK_MS || 35_000);
    const baseTimeoutMs = isLongResearchTurn
      ? Math.max(timeouts.turnHardAbortMs, timeouts.turnLongResearchHardAbortMs || timeouts.turnHardAbortMs)
      : timeouts.turnHardAbortMs;
    const timeoutMs = deterministicFallbackText && !isLongResearchTurn
      ? Math.min(baseTimeoutMs, Math.max(10_000, localOfficeFallbackMs))
      : baseTimeoutMs;
    if (isLongResearchTurn && timeoutMs !== timeouts.turnHardAbortMs) {
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

  function scheduleToolFinalizationFallback(sessionPath: any, ss: any): void {
    clearToolFinalizationTimer(ss);
    if (!sessionPath || !ss || !timeouts.toolFinalizationGraceMs) return;
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
        if ((ss.hasOutput || ss.hasBufferedVisibleTextDuringTool) && toolAgeMs >= timeouts.toolFinalizationGraceMs) {
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
    }, timeouts.toolFinalizationGraceMs);
    if (ss.toolFinalizationTimer.unref) ss.toolFinalizationTimer.unref();
  }

  function scheduleToolAuthorizationFallback(sessionPath: any, ss: any): void {
    clearToolAuthorizationTimer(ss);
    clearToolAuthorizationPollTimer(ss);
    if (!sessionPath || !ss || !timeouts.toolAuthorizationGraceMs || !ss.isStreaming || ss._turnClosed || hasStreamEvent(ss, "turn_end")) return;
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
      // 没有模型收尾文本时,给一行真实工具结果的事实反馈,而不是静默关流
      //(用户视角:命令执行成功了却没有任何回应)。
      const fallbackText = meaningfulFinalText || buildEmptyTurnFallbackText(ss, "tool_authorization_timeout");
      closeStreamWithVisibleFallback(
        sessionPath,
        ss,
        fallbackText,
        "tool_authorization_timeout",
        meaningfulFinalText ? {} : { trustedFallback: true },
      );
    }, timeouts.toolAuthorizationGraceMs);
    if (ss.toolAuthorizationTimer.unref) ss.toolAuthorizationTimer.unref();
  }

  function scheduleSilentBrainAbort(_sessionPath: any, ss: any): void {
    clearSilentBrainAbortTimer(ss);
  }

  function closeStreamAfterError(sessionPath: any, ss: any) {
    if (!sessionPath || !ss || hasStreamEvent(ss, "turn_end")) return;
    if (!ss.hasOutput && !ss.hasToolCall) ss._lastTurnAborted = true;
    closeStreamWithVisibleFallback(sessionPath, ss, "", "model_tool_error");
  }

  return {
    buildRealtimeToolFallbackText,
    closeStreamAfterError,
    closeStreamWithVisibleFallback,
    finalizeReturnedTurnWithoutStream,
    isMeaningfulPersistedFinalText,
    schedulePersistedFinalAnswerPoll,
    scheduleReturnedTurnFinalizationFallback,
    scheduleSilentBrainAbort,
    scheduleToolAuthorizationFallback,
    scheduleToolFinalizationFallback,
    scheduleTurnHardAbort,
  };
}
