/**
 * Session stream state — 管理 WebSocket 会话的共享流状态
 *
 * 从 server/routes/chat.js 提取。负责 state Map 的 CRUD、淘汰、
 * stale 检测、stream token 生命周期。
 */
import {
  createChatTurnState,
} from "./turn-state.js";

interface SessionLike {
  lastActivity: number;
  lastAccessTime?: number;
  lastAccessSeq?: number;
  isStreaming: boolean;
  startedAt?: number;
  hasOutput?: boolean;
  hasToolCall?: boolean;
  hasThinking?: boolean;
  hasError?: boolean;
  activeStreamToken?: unknown;
  degenerationAbortRequested?: boolean;
  progressMarkerCount?: number;
  _turnEndDeferred?: boolean;
  _turnClosed?: boolean;
  internalRetryPending?: boolean;
  internalRetryInFlight?: boolean;
  internalRetryReason?: string;
  internalRetryOriginalVisibleLen?: number;
  internalRetryHadVisibleBeforeReset?: boolean;
  hasPrefetchToolCall?: boolean;
  activeToolCallCount?: number;
  activeToolCallStartedAt?: number | null;
  lastToolExecutionActivity?: number;
  visibleTextAcc?: string;
  bufferedVisibleTextDuringTool?: string;
  hasBufferedVisibleTextDuringTool?: boolean;
  rawTextAcc?: string;
  pseudoToolSteered?: boolean;
  pseudoToolRecoveryHandled?: boolean;
  pseudoToolCommandRecoveryAttempted?: boolean;
  pseudoToolXmlBlock?: unknown;
  successfulToolCount?: number;
  lastSuccessfulTools?: unknown[];
  hasFailedTool?: boolean;
  lastFailedTools?: unknown[];
  __slowToolTimers?: Map<unknown, ReturnType<typeof setTimeout>>;
  toolFinalizationRetryAttempted?: boolean;
  toolFailedFallbackRetryAttempted?: boolean;
  persistedAssistantTextBaseline?: number;
  persistedAssistantMessageBaseline?: number;
  rehydratedThisTurn?: boolean;
  postRehydrateEscalationAttempted?: boolean;
  postRehydrateDeterministicAttempted?: boolean;
  silentBrainAbortTimer?: ReturnType<typeof setTimeout> | null;
  turnHardAbortTimer?: ReturnType<typeof setTimeout> | null;
  toolFinalizationTimer?: ReturnType<typeof setTimeout> | null;
  deferredTurnEndSafetyTimer?: ReturnType<typeof setTimeout> | null;
  toolAuthorizationTimer?: ReturnType<typeof setTimeout> | null;
  toolAuthorizationPollTimer?: ReturnType<typeof setInterval> | null;
  returnedTurnFinalizationTimer?: ReturnType<typeof setTimeout> | null;
  persistedFinalAnswerPollTimer?: ReturnType<typeof setInterval> | null;
  thinkTagParser?: { reset(): void };
  progressParser?: { reset(): void };
  moodParser?: { reset(): void };
  xingParser?: { reset(): void };
  [key: string]: unknown;
}

export interface SessionStateStore {
  sessionState: Map<string, SessionLike>;
  getState(sessionPath: string): SessionLike | null;
  hasState(sessionPath: string): boolean;
  deleteState(sessionPath: string): void;
  destroy(): void;
}

const MAX_SESSION_STATES = 20;
const STALE_EMPTY_STREAM_MS = Number(process.env.LYNN_STALE_EMPTY_STREAM_MS || 90_000);
const STALE_THINKING_STREAM_MS = Number(process.env.LYNN_STALE_THINKING_STREAM_MS || 120_000);

export function createSessionStateStore(): SessionStateStore {
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
      if (sessionState.size >= MAX_SESSION_STATES) {
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
      if (!ss.isStreaming && now - (ss.lastActivity || 0) > 300_000) {
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

export function resetCompletedTurnState(ss: SessionLike): void {
  clearTurnTimers(ss);
  ss.activeStreamToken = null;
  ss.degenerationAbortRequested = false;
  ss.progressMarkerCount = 0;
  ss._turnEndDeferred = false;
  ss._turnClosed = false;
  ss.internalRetryPending = false;
  ss.internalRetryInFlight = false;
  ss.internalRetryReason = "";
  ss.internalRetryOriginalVisibleLen = 0;
  ss.internalRetryHadVisibleBeforeReset = false;
  ss.hasOutput = false;
  ss.hasToolCall = false;
  ss.hasPrefetchToolCall = false;
  ss.activeToolCallCount = 0;
  ss.activeToolCallStartedAt = null;
  ss.lastToolExecutionActivity = 0;
  ss.hasThinking = false;
  ss.hasError = false;
  ss.thinkTagParser?.reset();
  ss.progressParser?.reset();
  ss.moodParser?.reset();
  ss.xingParser?.reset();
  ss.visibleTextAcc = "";
  ss.bufferedVisibleTextDuringTool = "";
  ss.hasBufferedVisibleTextDuringTool = false;
  ss.rawTextAcc = "";
  ss.pseudoToolSteered = false;
  ss.pseudoToolRecoveryHandled = false;
  ss.pseudoToolCommandRecoveryAttempted = false;
  ss.pseudoToolXmlBlock = null;
  ss.successfulToolCount = 0;
  ss.lastSuccessfulTools = [];
  ss.hasFailedTool = false;
  ss.lastFailedTools = [];
  if (ss.__slowToolTimers?.size) {
    for (const timer of ss.__slowToolTimers.values()) {
      try { clearTimeout(timer); } catch { /* timer may already be cleared */ }
    }
    ss.__slowToolTimers.clear();
  }
  ss.toolFinalizationRetryAttempted = false;
  ss.toolFailedFallbackRetryAttempted = false;
  ss.persistedAssistantTextBaseline = 0;
  ss.persistedAssistantMessageBaseline = 0;
  ss.rehydratedThisTurn = false;
  ss.postRehydrateEscalationAttempted = false;
  ss.postRehydrateDeterministicAttempted = false;
}
