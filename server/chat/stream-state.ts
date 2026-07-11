/**
 * Session stream state — 管理 WebSocket 会话的共享流状态
 *
 * 从 server/routes/chat.js 提取。负责 state Map 的 CRUD、淘汰、
 * stale 检测、stream token 生命周期。
 */
import {
  createEmptyToolStormGuard,
  createChatTurnState,
} from "./turn-state.js";
import type { ChatTurnState } from "./turn-state.js";

export interface SessionLike extends ChatTurnState {
  lastAccessTime?: number;
  lastAccessSeq?: number;
  [key: string]: unknown;
}

export interface SessionStateStore {
  sessionState: Map<string, SessionLike>;
  getState(sessionPath: string): SessionLike | null;
  hasState(sessionPath: string): boolean;
  deleteState(sessionPath: string): void;
  destroy(): void;
}

export interface PrepareChatTurnStateOptions {
  promptText: string;
  routeIntent: string;
  persistedAssistantTextBaseline?: number;
  persistedAssistantMessageBaseline?: number;
}

const MAX_SESSION_STATES = Math.max(20, Number(process.env.LYNN_MAX_SESSION_STREAM_STATES || 100));
const INACTIVE_SESSION_STATE_TTL_MS = Math.max(300_000, Number(process.env.LYNN_SESSION_STREAM_STATE_TTL_MS || 1_800_000));
const STALE_EMPTY_STREAM_MS = Number(process.env.LYNN_STALE_EMPTY_STREAM_MS || 90_000);
const STALE_THINKING_STREAM_MS = Number(process.env.LYNN_STALE_THINKING_STREAM_MS || 120_000);

export function createSessionStateStore({ maxSessionStates = MAX_SESSION_STATES }: { maxSessionStates?: number } = {}): SessionStateStore {
  const sessionState = new Map<string, SessionLike>();
  let accessSeq = 0;

  function touchState(ss: SessionLike): void {
    const now = Date.now();
    ss.lastActivity = now;
    ss.lastAccessTime = now;
    ss.lastAccessSeq = ++accessSeq;
  }

  function evictLeastRecentlyUsed(excludePath: string): boolean {
    let evictPath: string | null = null;
    let evictSeq = Infinity;
    let evictActivity = Infinity;
    for (const [sp, ss] of sessionState) {
      if (sp === excludePath || ss.isStreaming) continue;
      const seq = Number.isFinite(ss.lastAccessSeq) ? ss.lastAccessSeq! : 0;
      const activity = Number.isFinite(ss.lastActivity) ? ss.lastActivity : 0;
      if (seq < evictSeq || (seq === evictSeq && activity < evictActivity)) {
        evictPath = sp;
        evictSeq = seq;
        evictActivity = activity;
      }
    }
    if (!evictPath) return false;
    sessionState.delete(evictPath);
    return true;
  }

  function getState(sessionPath: string): SessionLike | null {
    if (!sessionPath) return null;
    if (!sessionState.has(sessionPath)) {
      if (sessionState.size >= maxSessionStates) {
        evictLeastRecentlyUsed(sessionPath);
      }
      sessionState.set(sessionPath, createChatTurnState() as SessionLike);
    }
    const ss = sessionState.get(sessionPath)!;
    if (ss) touchState(ss);
    return ss;
  }

  function hasState(sessionPath: string): boolean {
    return sessionState.has(sessionPath);
  }

  function deleteState(sessionPath: string): void {
    sessionState.delete(sessionPath);
  }

  const _sessionEvictTimer = setInterval(() => {
    const now = Date.now();
    for (const [sp, ss] of sessionState) {
      if (!ss.isStreaming && now - (ss.lastActivity || 0) > INACTIVE_SESSION_STATE_TTL_MS) {
        sessionState.delete(sp);
      }
    }
  }, 60_000);
  if (_sessionEvictTimer.unref) _sessionEvictTimer.unref();

  function destroy(): void {
    clearInterval(_sessionEvictTimer);
    sessionState.clear();
  }

  return { sessionState, getState, hasState, deleteState, destroy };
}

export function isStaleEmptySessionStream(ss: SessionLike | null | undefined, now: number = Date.now()): boolean {
  if (!ss) return false;
  const elapsed = now - (ss.startedAt || 0);
  const hasUserVisibleProgress = !!(ss.hasOutput || ss.hasToolCall);
  if (hasUserVisibleProgress) return false;
  if (elapsed > STALE_THINKING_STREAM_MS) return true;
  return elapsed > STALE_EMPTY_STREAM_MS && !ss.hasThinking && !ss.hasError;
}

type ClearFn = (id: unknown) => void;

function clearTimerField(ss: SessionLike, field: string, clearFn: ClearFn = clearTimeout as unknown as ClearFn): void {
  if (!ss?.[field]) return;
  try { clearFn(ss[field]); } catch { /* timer may already be cleared */ }
  ss[field] = null;
}

export function clearSilentBrainAbortTimer(ss: SessionLike): void {
  clearTimerField(ss, "silentBrainAbortTimer");
}

export function clearTurnHardAbortTimer(ss: SessionLike): void {
  clearTimerField(ss, "turnHardAbortTimer");
}

export function clearToolFinalizationTimer(ss: SessionLike): void {
  clearTimerField(ss, "toolFinalizationTimer");
}

export function clearDeferredTurnEndSafetyTimer(ss: SessionLike): void {
  clearTimerField(ss, "deferredTurnEndSafetyTimer");
}

export function clearToolAuthorizationTimer(ss: SessionLike): void {
  clearTimerField(ss, "toolAuthorizationTimer");
}

export function clearToolAuthorizationPollTimer(ss: SessionLike): void {
  clearTimerField(ss, "toolAuthorizationPollTimer", clearInterval as unknown as ClearFn);
}

export function clearReturnedTurnFinalizationTimer(ss: SessionLike): void {
  clearTimerField(ss, "returnedTurnFinalizationTimer");
}

export function clearPersistedFinalAnswerPollTimer(ss: SessionLike): void {
  clearTimerField(ss, "persistedFinalAnswerPollTimer", clearInterval as unknown as ClearFn);
}

export function clearTurnTimers(ss: SessionLike): void {
  clearSilentBrainAbortTimer(ss);
  clearTurnHardAbortTimer(ss);
  clearToolFinalizationTimer(ss);
  clearDeferredTurnEndSafetyTimer(ss);
  clearToolAuthorizationTimer(ss);
  clearToolAuthorizationPollTimer(ss);
  clearReturnedTurnFinalizationTimer(ss);
  clearPersistedFinalAnswerPollTimer(ss);
}

function resetTurnParsers(ss: SessionLike): void {
  ss.thinkTagParser?.reset();
  ss.progressParser?.reset();
  ss.moodParser?.reset();
  ss.xingParser?.reset();
}

function clearSlowToolTimers(ss: SessionLike): void {
  if (!ss.__slowToolTimers?.size) return;
  for (const timer of ss.__slowToolTimers.values()) {
    try { clearTimeout(timer); } catch { /* timer may already be cleared */ }
  }
  ss.__slowToolTimers.clear();
}

function resetToolEvidenceState(ss: SessionLike): void {
  ss.hasToolCall = false;
  ss.hasRealtimeEvidenceToolCall = false;
  ss.hasPrefetchToolCall = false;
  ss.hasLocalPrefetchEvidence = false;
  ss.activeToolCallCount = 0;
  ss.activeToolCallStartedAt = null;
  ss.lastToolExecutionActivity = 0;
  ss.recoveredBashInFlight = false;
  ss.successfulToolCount = 0;
  ss.lastSuccessfulTools = [];
  ss.hasFailedTool = false;
  ss.lastFailedTools = [];
  ss.toolStormGuard = createEmptyToolStormGuard();
  ss.toolStormClosed = false;
  ss.realtimeToolFallbackText = "";
  ss.realtimeToolFallbackKind = "";
  ss.emittedFileOutputPaths = new Set();
  ss.recoveredArtifactKeys = new Set();
}

/**
 * Establish one clean turn boundary while preserving session-scoped state such as a pending
 * destructive-action confirmation. Every user prompt must pass through this function before a
 * new stream starts, including turns that follow stale-stream recovery.
 */
export function prepareChatTurnState(ss: SessionLike, options: PrepareChatTurnStateOptions): SessionLike {
  clearTurnTimers(ss);
  clearSlowToolTimers(ss);
  resetTurnParsers(ss);
  resetToolEvidenceState(ss);

  ss.isThinking = false;
  ss.hasThinking = false;
  ss.hasOutput = false;
  ss.hasError = false;
  ss.titleRequested = false;
  ss.titlePreview = "";
  ss.visibleTextAcc = "";
  ss.bufferedVisibleTextDuringTool = "";
  ss.hasBufferedVisibleTextDuringTool = false;
  ss.rawTextAcc = "";
  ss.sanitizerCarry = "";
  ss.pseudoToolSteered = false;
  ss.pseudoToolRecoveryHandled = false;
  ss.pseudoToolCommandRecoveryAttempted = false;
  ss.pseudoToolXmlBlock = null;
  ss.routeIntent = options.routeIntent || "chat";
  ss.originalPromptText = options.promptText;
  ss.effectivePromptText = options.promptText;
  ss.pendingToolRetryAttempted = false;
  ss.toolFailedFallbackRetryAttempted = false;
  ss.toolFinalizationRetryAttempted = false;
  ss.persistedAssistantTextBaseline = Math.max(0, Number(options.persistedAssistantTextBaseline || 0));
  ss.persistedAssistantMessageBaseline = Math.max(0, Number(options.persistedAssistantMessageBaseline || 0));
  ss.rehydratedThisTurn = false;
  ss.postRehydrateEscalationAttempted = false;
  ss.postRehydrateDeterministicAttempted = false;
  ss._rehydratedEffectivePrompt = null;
  ss.autoReviewStarted = false;
  ss.activeStreamToken = null;
  ss.streamSource = null;
  ss.degenerationAbortRequested = false;
  ss.progressMarkerCount = 0;
  ss._turnEndDeferred = false;
  ss._turnClosed = false;
  ss._lastTurnAborted = false;
  ss.lastActivity = Date.now();
  return ss;
}

export function resetCompletedTurnState(ss: SessionLike): void {
  clearTurnTimers(ss);
  clearSlowToolTimers(ss);
  ss.activeStreamToken = null;
  ss.degenerationAbortRequested = false;
  ss.progressMarkerCount = 0;
  ss._turnEndDeferred = false;
  ss._turnClosed = false;
  ss.hasOutput = false;
  resetToolEvidenceState(ss);
  ss.hasThinking = false;
  ss.hasError = false;
  resetTurnParsers(ss);
  ss.visibleTextAcc = "";
  ss.bufferedVisibleTextDuringTool = "";
  ss.hasBufferedVisibleTextDuringTool = false;
  ss.rawTextAcc = "";
  ss.sanitizerCarry = "";
  ss.pseudoToolSteered = false;
  ss.pseudoToolRecoveryHandled = false;
  ss.pseudoToolCommandRecoveryAttempted = false;
  ss.pseudoToolXmlBlock = null;
  ss.autoReviewStarted = false;
  ss.pendingToolRetryAttempted = false;
  ss.toolFinalizationRetryAttempted = false;
  ss.toolFailedFallbackRetryAttempted = false;
  ss.persistedAssistantTextBaseline = 0;
  ss.persistedAssistantMessageBaseline = 0;
  ss.rehydratedThisTurn = false;
  ss.postRehydrateEscalationAttempted = false;
  ss.postRehydrateDeterministicAttempted = false;
  ss._rehydratedEffectivePrompt = null;
}
