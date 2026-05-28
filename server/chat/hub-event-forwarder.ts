import fs from "fs";
import path from "path";
import { readFile } from "node:fs/promises";
import { BrowserManager } from "../../lib/browser/browser-manager.js";
import { debugLog } from "../../lib/debug-log.js";
import { finishSessionStream } from "../session-stream-store.js";
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
import {
  artifactPreviewDedupeKey,
  artifactPreviewFromToolCall,
} from "./artifact-recovery.js";
import { normalizeArtifactPayload } from "./artifact-shape.js";
import { extractProviderRouteMeta } from "./provider-meta.js";

type AnyRecord = Record<string, any>;
type IntervalHandle = ReturnType<typeof setInterval>;

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
  scheduleToolAuthorizationFallback: (sessionPath: any, ss: any) => void;
  scheduleToolFinalizationFallback: (sessionPath: any, ss: any) => void;
  hasStreamEvent: (ss: any, type: any) => boolean;
  hasToolExecutionInFlight: (ss: any) => boolean;
}

function resolveEditSnapshotPath(session: any, engine: any, rawPath: any) {
  if (typeof rawPath !== "string") return null;
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.includes("\0")) return null;
  if (path.isAbsolute(trimmed)) return path.resolve(trimmed);

  const cwd = session?.sessionManager?.getCwd?.() || engine.cwd || process.cwd();
  return path.resolve(cwd, trimmed);
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
  scheduleToolAuthorizationFallback,
  scheduleToolFinalizationFallback,
  hasStreamEvent,
  hasToolExecutionInFlight,
}: HubEventForwarderDeps) {
  let browserThumbTimer: IntervalHandle | null = null;

  function startBrowserThumbPoll() {
    if (browserThumbTimer) return;
    browserThumbTimer = setInterval(async () => {
      const browser = BrowserManager.instance();
      if (!browser.isRunning) { stopBrowserThumbPoll(); return; }
      const thumbnail = await browser.thumbnail();
      if (thumbnail) {
        broadcast({ type: "browser_status", running: true, url: browser.currentUrl, thumbnail });
      }
    }, 30_000);
  }

  function stopBrowserThumbPoll() {
    if (browserThumbTimer) {
      clearInterval(browserThumbTimer);
      browserThumbTimer = null;
    }
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
            } catch {
              // Skip malformed JSONL rows.
            }
          }
        } catch {
          // Model hint recovery is best-effort.
        }
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
}
