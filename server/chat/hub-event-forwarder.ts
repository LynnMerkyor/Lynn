import fs from "fs";
import { debugLog } from "../../lib/debug-log.js";
import { finishSessionStream } from "../session-stream-store.js";
import { extractText } from "./content-utils.js";
import { buildDirectSportsAnswer } from "./report-research-answer.js";
import { buildToolCompletionSummary } from "./tool-turn-finalizer.js";
import {
  clearToolAuthorizationTimer,
  clearTurnTimers,
  resetCompletedTurnState,
} from "./stream-state.js";
import {
  TOOL_ARG_SUMMARY_KEYS,
  normalizeToolArgsForSummary,
  rememberFailedTool,
  rememberSuccessfulTool,
  summarizeToolExecution,
} from "./tool-summary.js";
import { normalizeArtifactPayload } from "./artifact-shape.js";
import { createBrowserThumbnailPoller } from "./hub-browser-poll.js";
import {
  emitFileOutputFromPath as emitFileOutputFromPathBase,
  emitFileOutputsFromDetails as emitFileOutputsFromDetailsBase,
  maybeRecoverArtifactFromMessageUpdate as maybeRecoverArtifactFromMessageUpdateBase,
} from "./hub-event-artifacts.js";
import {
  isAssistantStreamScopedEvent,
  resolveEditSnapshotPath,
} from "./hub-event-utils.js";
import { emitModelHintFromSessionTail } from "./model-hint-recovery.js";
import { extractProviderRouteMeta } from "./provider-meta.js";
import { scheduleAutoReviewForTurn } from "./auto-review.js";
import {
  buildToolStormFallbackText,
  updateToolStormGuard,
} from "./tool-storm-guard.js";

type AnyRecord = Record<string, any>;
type ExtractableContent = Parameters<typeof extractText>[0];

const REALTIME_EVIDENCE_TOOL_NAMES = new Set([
  "web_search",
  "websearch",
  "web_fetch",
  "webfetch",
  "sports_score",
  "sportsscore",
  "live_news",
  "livenews",
  "weather",
  "stock_market",
  "stockmarket",
  "exchange_rate",
  "exchangerate",
]);
const SHORT_VISIBLE_AFTER_THINKING_MAX_CHARS = Number(process.env.LYNN_SHORT_VISIBLE_AFTER_THINKING_MAX_CHARS || 40);
const SHORT_VISIBLE_AFTER_THINKING_MIN_THINKING_CHARS = Number(process.env.LYNN_SHORT_VISIBLE_AFTER_THINKING_MIN_THINKING_CHARS || 800);

function isRealtimeEvidenceToolName(name: any): boolean {
  return REALTIME_EVIDENCE_TOOL_NAMES.has(String(name || "").trim());
}

function canonicalToolName(name: unknown): string {
  return String(name || "").trim().toLowerCase().replace(/-/g, "_");
}

function isSportsScoreToolName(name: unknown): boolean {
  const canonical = canonicalToolName(name);
  return canonical === "sports_score" || canonical === "sportsscore";
}

function shouldForceCloseSportsDirectTurn(promptText: unknown, answer: unknown): boolean {
  const prompt = String(promptText || "");
  const text = String(answer || "").trim();
  if (!prompt || !text) return false;
  if (/预测|预估|猜|看好|可能比分|比分预测|predict|prediction|forecast/i.test(prompt)) return false;
  if (/(?:深度|完整|全面|系统(?:性)?|调研|研究|报告|分析|对比|比较|引用|来源列表|research|report|analysis|compare)/i.test(prompt)) return false;
  return /(?:今晚|今夜|今天|今日|明天|明日|昨晚|昨天|昨日|半决赛|准决赛|决赛|哪一天|什么时候|时间|日期|赛程|比赛|几场|几轮|对阵|比分|赛果|结果|score|scores|schedule|fixture|fixtures|match|matches|game|games|result|results|semifinal|semi-final|final)/i.test(prompt);
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function eventPayloadOf(entry: unknown): Record<string, unknown> {
  const record = recordOf(entry);
  if (record.event && typeof record.event === "object" && !Array.isArray(record.event)) return record.event as Record<string, unknown>;
  if (record.payload && typeof record.payload === "object" && !Array.isArray(record.payload)) return record.payload as Record<string, unknown>;
  return record;
}

function countThinkingDeltaChars(ss: unknown): number {
  const events = Array.isArray(recordOf(ss).events) ? recordOf(ss).events as unknown[] : [];
  return events.reduce<number>((total, entry) => {
    const event = eventPayloadOf(entry);
    if (event.type !== "thinking_delta") return total;
    return total + String(event.delta || event.text || "").length;
  }, 0);
}

function shouldGuardShortVisibleAfterThinking(ss: unknown, hasToolEvidence: boolean): boolean {
  if (hasToolEvidence) return false;
  const state = recordOf(ss);
  if (!state.hasOutput || !state.hasThinking || state.hasError) return false;
  const visibleLen = String(state.visibleTextAcc || "").trim().length;
  if (visibleLen <= 0 || visibleLen > SHORT_VISIBLE_AFTER_THINKING_MAX_CHARS) return false;
  return countThinkingDeltaChars(ss) >= SHORT_VISIBLE_AFTER_THINKING_MIN_THINKING_CHARS;
}

function hasToolEvidenceState(ss: any): boolean {
  return !!(ss?.hasToolCall || ss?.hasPrefetchToolCall || Number(ss?.successfulToolCount || 0) > 0);
}

function isRecoverableModelCompletionError(message: unknown): boolean {
  return /(?:LLM request timed out|timed out|timeout|aborted|AbortError|fetch failed|socket hang up|ECONNRESET|ETIMEDOUT)/iu.test(String(message || ""));
}

function buildSportsDirectToolAnswer(ss: unknown, toolName: unknown, event: unknown): string {
  if (!isSportsScoreToolName(toolName)) return "";
  const eventRecord = recordOf(event);
  const resultRecord = recordOf(eventRecord.result);
  const argsRecord = recordOf(eventRecord.args);
  const stateRecord = recordOf(ss);
  const toolText = extractText(resultRecord.content as ExtractableContent).trim();
  if (
    !toolText
    || !/体育查询结果/.test(toolText)
    || /directSourceStatus:\s*unavailable/i.test(toolText)
  ) return "";
  const prompt = String(stateRecord.originalPromptText || stateRecord.effectivePromptText || argsRecord.query || "");
  const answer = buildDirectSportsAnswer(`【体育比分工具资料】\n\n${toolText}`, prompt);
  return shouldForceCloseSportsDirectTurn(prompt, answer) ? answer : "";
}

export interface HubEventForwarderDeps {
  hub: any;
  engine: any;
  sessionState: { get(sessionPath: any): any };
  editRollbackStore: any;
  lifecycleHooks: any;
  broadcast: (msg: any) => void;
  emitStreamEvent: (sessionPath: any, ss: any, event: any) => void;
  feedAssistantVisibleText: (sessionPath: any, ss: any, delta: any) => void;
  flushBufferedAssistantText: (sessionPath: any, ss: any) => void;
  maybeAppendCodeVerificationPostscript: (sessionPath: any, ss: any) => boolean;
  maybeGenerateFirstTurnTitle: (sessionPath: any, ss: any) => void;
  buildRealtimeToolFallbackText: (toolName: any, event: any) => string;
  closeStreamAfterError: (sessionPath: any, ss: any) => void;
  closeStreamWithVisibleFallback: (sessionPath: any, ss: any, text: any, reason: any, options?: any) => boolean;
  scheduleToolAuthorizationFallback: (sessionPath: any, ss: any) => void;
  scheduleToolFinalizationFallback: (sessionPath: any, ss: any) => void;
  hasStreamEvent: (ss: any, type: any) => boolean;
  hasToolExecutionInFlight: (ss: any) => boolean;
}

export function createHubEventForwarder({
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
  closeStreamWithVisibleFallback,
  scheduleToolAuthorizationFallback,
  scheduleToolFinalizationFallback,
  hasStreamEvent,
  hasToolExecutionInFlight,
}: HubEventForwarderDeps) {
  const browserThumbPoll = createBrowserThumbnailPoller(broadcast);

  function emitFileOutputsFromDetails(sessionPath: any, ss: any, details: any = {}) {
    return emitFileOutputsFromDetailsBase(sessionPath, ss, emitStreamEvent, details);
  }

  function emitFileOutputFromPath(sessionPath: any, ss: any, filePath: any) {
    return emitFileOutputFromPathBase(sessionPath, ss, emitStreamEvent, filePath);
  }

  function maybeRecoverArtifactFromMessageUpdate(sessionPath: any, ss: any, event: any, source: any = "message_update") {
    return maybeRecoverArtifactFromMessageUpdateBase(sessionPath, ss, emitStreamEvent, event, source);
  }

  return hub.subscribe((event: any, sessionPath: any) => {
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
        // Tool call start is reflected by tool_execution_start.
      } else if (sub === "toolcall_end") {
        maybeRecoverArtifactFromMessageUpdate(sessionPath, ss, event, "toolcall_end");
      } else if (sub === "error") {
        const message = event.assistantMessageEvent.error || "Unknown error";
        if (!ss.hasOutput && hasToolEvidenceState(ss) && isRecoverableModelCompletionError(message)) {
          const fallbackText = String(ss.realtimeToolFallbackText || "").trim() || buildToolCompletionSummary(ss);
          if (fallbackText && closeStreamWithVisibleFallback(
            sessionPath,
            ss,
            fallbackText,
            "tool_evidence_model_error_fallback",
            { trustedFallback: true },
          )) {
            return;
          }
        }
        ss.hasError = true;
        if (isActive) broadcast({ type: "error", message });
        closeStreamAfterError(sessionPath, ss);
      }
    } else if (event.type === "tool_execution_start") {
      if (!ss) return;
      ss.hasToolCall = true;
      if (isRealtimeEvidenceToolName(event.toolName)) ss.hasRealtimeEvidenceToolCall = true;
      ss.activeToolCallCount = Math.max(0, Number(ss.activeToolCallCount || 0)) + 1;
      ss.lastToolExecutionActivity = Date.now();
      // The finalization fence should measure grace from the most recent
      // active tool transition. Multiple overlapping tools can otherwise make
      // a later slow tool inherit an older start time and get aborted early.
      ss.activeToolCallStartedAt = ss.lastToolExecutionActivity;
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
        const slowName = event.toolName || "";
        const slowToolCallId = event.toolCallId || null;
        const slowTimer = setTimeout(() => {
          try {
            emitStreamEvent(sessionPath, ss, { type: "tool_progress", name: slowName, event: "slow_warning", elapsedMs: 15000, toolCallId: slowToolCallId });
          } catch {
            // Stream may have closed.
          }
        }, 15000);
        ss.__slowToolTimers = ss.__slowToolTimers || new Map();
        ss.__slowToolTimers.set(slowToolCallId || slowName, slowTimer);
      } catch {
        // Slow-tool warnings are best-effort progress hints.
      }
    } else if (event.type === "tool_execution_end") {
      if (!ss) return;
      ss.activeToolCallCount = Math.max(0, Number(ss.activeToolCallCount || 0) - 1);
      ss.lastToolExecutionActivity = Date.now();
      if (Number(ss.activeToolCallCount || 0) === 0) {
        ss.activeToolCallStartedAt = null;
      } else {
        ss.activeToolCallStartedAt = ss.lastToolExecutionActivity;
      }
      try {
        const key = event.toolCallId || event.toolName || "";
        const timer = ss.__slowToolTimers?.get(key);
        if (timer) { clearTimeout(timer); ss.__slowToolTimers?.delete(key); }
      } catch {
        // Timer cleanup should never fail the tool result path.
      }

      const {
        rawDetails,
        publicDetails,
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
        details: publicDetails || rawDetails,
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
        const sportsDirectAnswer = buildSportsDirectToolAnswer(ss, toolName, event);
        if (sportsDirectAnswer) {
          ss.realtimeToolFallbackText = sportsDirectAnswer;
          ss.realtimeToolFallbackKind = "sports_score_direct_answer";
        }
      } else {
        rememberFailedTool(ss, toolName);
      }
      if (
        ss.realtimeToolFallbackKind === "sports_score_direct_answer"
        && !ss.hasOutput
        && !ss.hasError
        && !ss._turnClosed
        && !hasStreamEvent(ss, "turn_end")
        && !hasToolExecutionInFlight(ss)
      ) {
        try {
          void Promise.resolve(engine.abortSessionByPath?.(sessionPath)).catch(() => {});
        } catch {
          // Best effort: the local deterministic close below is authoritative.
        }
        closeStreamWithVisibleFallback(
          sessionPath,
          ss,
          ss.realtimeToolFallbackText,
          "sports_score_direct_answer_after_tool",
          { trustedFallback: true },
        );
        return;
      }
      const stormDecision = updateToolStormGuard(ss, toolName, normalizedArgs);
      if (
        stormDecision.exceeded
        && !ss.toolStormClosed
        && !ss.hasOutput
        && !ss.hasError
        && !ss._turnClosed
        && !hasStreamEvent(ss, "turn_end")
        && !hasToolExecutionInFlight(ss)
      ) {
        ss.toolStormClosed = true;
        try {
          emitStreamEvent(sessionPath, ss, {
            type: "tool_progress",
            name: toolName,
            event: "storm_guard",
            reason: stormDecision.reason,
            count: stormDecision.count,
            limit: stormDecision.limit,
          });
        } catch {
          // Stream may already be closing.
        }
        try {
          void Promise.resolve(engine.abortSessionByPath?.(sessionPath)).catch(() => {});
        } catch {
          // Abort is best-effort; fallback closing below is authoritative.
        }
        const fallbackText = buildToolStormFallbackText(stormDecision, buildToolCompletionSummary(ss));
        if (closeStreamWithVisibleFallback(
          sessionPath,
          ss,
          fallbackText,
          "tool_storm_budget_exceeded",
          { trustedFallback: true },
        )) {
          scheduleAutoReviewForTurn({
            engine,
            broadcast,
            sessionPath,
            ss,
            mode: "fallback",
            reason: "tool_storm_budget_exceeded",
            sourceText: fallbackText,
          });
        }
        return;
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
        emitFileOutputFromPath(sessionPath, ss, toolSummary.filePath);
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
        if (statusMsg.running) browserThumbPoll.start();
        else browserThumbPoll.stop();
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
      const hasToolEvidence = hasToolEvidenceState(ss);
      if (hasToolEvidence && !ss.hasError && !ss._turnEndDeferred) {
        ss._turnEndDeferred = true;
        scheduleToolFinalizationFallback(sessionPath, ss);
        debugLog()?.log("ws", `[TURN-END v2] defer tool-phase turn_end (awaiting final assistant text) · hasOutput=${ss.hasOutput} · ${sessionPath}`);
        return;
      }
      if (ss._turnEndDeferred) {
        debugLog()?.log("ws", `[TURN-END v1] resuming deferred turn_end · hasOutput=${ss.hasOutput} hasToolCall=${ss.hasToolCall} hasPrefetchToolCall=${ss.hasPrefetchToolCall} · ${sessionPath}`);
      }
      if (!ss.hasOutput && ss.hasThinking && !hasToolEvidence && !ss.hasError) {
        const fallbackText = "模型这次只返回了思考过程，没有给出最终可见答案。请点「编辑重发」重试，或切到 /fast 后再发。";
        if (closeStreamWithVisibleFallback(
          sessionPath,
          ss,
          fallbackText,
          "reasoning_only_without_visible_answer",
          { trustedFallback: true },
        )) {
          scheduleAutoReviewForTurn({
            engine,
            broadcast,
            sessionPath,
            ss,
            mode: "fallback",
            reason: "reasoning_only_without_visible_answer",
            sourceText: fallbackText,
          });
        }
        return;
      }
      if (shouldGuardShortVisibleAfterThinking(ss, hasToolEvidence)) {
        const fallbackText = "模型这次完成了大量隐藏推理，但最终可见答案只剩下半句。这不是你的输入问题，也不是工具失败；当前模型在隐藏推理阶段已经消耗了主要输出预算，却没有把结论完整写出来。Lynn 已把这轮安全收口，保留会话状态，并阻断半句残片继续污染下一轮上下文；请点「编辑重发」重试，或切到 /fast 后重新发送，我会重新生成完整答案。";
        if (closeStreamWithVisibleFallback(
          sessionPath,
          ss,
          fallbackText,
          "short_visible_after_hidden_reasoning",
          { trustedFallback: true, appendEvenIfHasOutput: true },
        )) {
          scheduleAutoReviewForTurn({
            engine,
            broadcast,
            sessionPath,
            ss,
            mode: "fallback",
            reason: "short_visible_after_hidden_reasoning",
            sourceText: `${String(ss.visibleTextAcc || "").trim()}\n\n${fallbackText}`.trim(),
          });
        }
        return;
      }
      if (!ss.hasOutput && !hasToolEvidence && !ss.hasError) {
        const fallbackText = "模型这次没有返回可见内容。本轮已安全结束，避免空回复污染后续上下文；Hanako 会尝试给出兜底复查。你也可以点「编辑重发」重试，或切换模型后再发。";
        if (closeStreamWithVisibleFallback(
          sessionPath,
          ss,
          fallbackText,
          "empty_turn_without_visible_answer",
          { trustedFallback: true },
        )) {
          scheduleAutoReviewForTurn({
            engine,
            broadcast,
            sessionPath,
            ss,
            mode: "fallback",
            reason: "empty_turn_without_visible_answer",
            sourceText: fallbackText,
          });
        }
        return;
      }
      if (!ss.hasOutput && hasToolEvidence && !ss.hasError) {
        const fallbackText = String(ss.realtimeToolFallbackText || "").trim()
          || buildToolCompletionSummary(ss);
        if (fallbackText) {
          if (closeStreamWithVisibleFallback(
            sessionPath,
            ss,
            fallbackText,
            "tool_turn_end_without_visible_answer",
            { trustedFallback: true },
          )) {
            scheduleAutoReviewForTurn({
              engine,
              broadcast,
              sessionPath,
              ss,
              mode: "fallback",
              reason: "tool_turn_end_without_visible_answer",
              sourceText: fallbackText,
            });
          }
          return;
        }
      }
      lifecycleHooks.run("turn_end", {
        event,
        ss,
        sessionPath,
        hasOutput: ss.hasOutput,
        hasToolCall: hasToolEvidence,
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
      void emitModelHintFromSessionTail(sessionPath, ss, emitStreamEvent);
      finishSessionStream(ss);
      scheduleAutoReviewForTurn({
        engine,
        broadcast,
        sessionPath,
        ss,
        mode: "background",
        reason: "turn_end",
        sourceText: String(ss.visibleTextAcc || ""),
      });
      if (ss.progressMarkerCount > 0 && !hasToolEvidence) {
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
}
