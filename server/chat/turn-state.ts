import { MoodParser, XingParser, ThinkTagParser, LynnProgressParser } from "../../core/events.js";
import { createSessionStreamState } from "../session-stream-store.js";
import type { SessionStreamEntry } from "../session-stream-store.js";
import type { ToolSuccessRecord } from "./tool-summary.js";

type TimerHandle = ReturnType<typeof setTimeout>;
type IntervalHandle = ReturnType<typeof setInterval>;

interface SessionStreamStateFields {
  streamId: string | null;
  nextSeq: number;
  isStreaming: boolean;
  startedAt: number;
  endedAt: number;
  events: SessionStreamEntry[];
  maxEvents: number;
}

export interface ToolStormGuardSnapshot {
  total: number;
  evidenceTotal: number;
  byName: Record<string, number>;
  bySignature: Record<string, number>;
  lastDecisionReason: string;
}

export function createEmptyToolStormGuard(): ToolStormGuardSnapshot {
  return {
    total: 0,
    evidenceTotal: 0,
    byName: {},
    bySignature: {},
    lastDecisionReason: "",
  };
}

export interface ChatTurnState extends SessionStreamStateFields {
  thinkTagParser: ThinkTagParser;
  progressParser: LynnProgressParser;
  moodParser: MoodParser;
  xingParser: XingParser;
  isThinking: boolean;
  hasOutput: boolean;
  hasToolCall: boolean;
  hasRealtimeEvidenceToolCall: boolean;
  hasPrefetchToolCall: boolean;
  activeToolCallCount: number;
  activeToolCallStartedAt: number | null;
  lastToolExecutionActivity: number;
  recoveredBashInFlight?: boolean;
  hasThinking: boolean;
  hasError: boolean;
  titleRequested: boolean;
  titlePreview: string;
  visibleTextAcc: string;
  bufferedVisibleTextDuringTool: string;
  hasBufferedVisibleTextDuringTool: boolean;
  rawTextAcc: string;
  pseudoToolSteered: boolean;
  pseudoToolRecoveryHandled: boolean;
  pseudoToolCommandRecoveryAttempted: boolean;
  pseudoToolXmlBlock: unknown | null;
  routeIntent: string;
  originalPromptText: string;
  effectivePromptText: string;
  hasLocalPrefetchEvidence: boolean;
  pendingToolRetryAttempted: boolean;
  successfulToolCount: number;
  lastSuccessfulTools: ToolSuccessRecord[];
  hasFailedTool: boolean;
  lastFailedTools: string[];
  toolStormGuard: ToolStormGuardSnapshot;
  toolStormClosed: boolean;
  realtimeToolFallbackText: string;
  realtimeToolFallbackKind: string;
  emittedFileOutputPaths: Set<string>;
  recoveredArtifactKeys: Set<string>;
  sanitizerCarry: string;
  autoReviewStarted: boolean;
  rehydratedThisTurn: boolean;
  postRehydrateEscalationAttempted: boolean;
  postRehydrateDeterministicAttempted: boolean;
  _rehydratedEffectivePrompt: string | null;
  pendingMutationContext?: {
    originalPrompt: string;
    requirement: Record<string, unknown> | null;
    recordedAt: number;
  } | null;
  __slowToolTimers?: Map<string, TimerHandle>;
  toolFailedFallbackRetryAttempted: boolean;
  toolFinalizationRetryAttempted: boolean;
  silentBrainAbortTimer: TimerHandle | null;
  turnHardAbortTimer: TimerHandle | null;
  toolFinalizationTimer: TimerHandle | null;
  deferredTurnEndSafetyTimer: TimerHandle | null;
  toolAuthorizationTimer: TimerHandle | null;
  toolAuthorizationPollTimer: IntervalHandle | null;
  returnedTurnFinalizationTimer: TimerHandle | null;
  persistedFinalAnswerPollTimer: IntervalHandle | null;
  persistedAssistantTextBaseline: number;
  persistedAssistantMessageBaseline: number;
  activeStreamToken: unknown | null;
  streamSource: "user" | "brain_fallback" | null;
  degenerationAbortRequested: boolean;
  _lastTurnAborted: boolean;
  progressMarkerCount: number;
  _turnEndDeferred: boolean;
  _turnClosed: boolean;
  lastActivity: number;
}

export function createChatTurnState(): ChatTurnState {
  return {
    thinkTagParser: new ThinkTagParser(),
    progressParser: new LynnProgressParser(),
    moodParser: new MoodParser(),
    xingParser: new XingParser(),
    isThinking: false,
    hasOutput: false,
    hasToolCall: false,
    hasRealtimeEvidenceToolCall: false,
    hasPrefetchToolCall: false,
    activeToolCallCount: 0,
    activeToolCallStartedAt: null,
    lastToolExecutionActivity: 0,
    hasThinking: false,
    hasError: false,
    titleRequested: false,
    titlePreview: "",
    visibleTextAcc: "",
    bufferedVisibleTextDuringTool: "",
    hasBufferedVisibleTextDuringTool: false,
    rawTextAcc: "",
    pseudoToolSteered: false,
    pseudoToolRecoveryHandled: false,
    pseudoToolCommandRecoveryAttempted: false,
    pseudoToolXmlBlock: null,
    routeIntent: "chat",
    originalPromptText: "",
    effectivePromptText: "",
    hasLocalPrefetchEvidence: false,
    pendingToolRetryAttempted: false,
    successfulToolCount: 0,
    lastSuccessfulTools: [],
    hasFailedTool: false,
    lastFailedTools: [],
    toolStormGuard: createEmptyToolStormGuard(),
    toolStormClosed: false,
    realtimeToolFallbackText: "",
    realtimeToolFallbackKind: "",
    emittedFileOutputPaths: new Set(),
    recoveredArtifactKeys: new Set(),
    sanitizerCarry: "",
    autoReviewStarted: false,
    rehydratedThisTurn: false,
    postRehydrateEscalationAttempted: false,
    postRehydrateDeterministicAttempted: false,
    _rehydratedEffectivePrompt: null,
    toolFailedFallbackRetryAttempted: false,
    toolFinalizationRetryAttempted: false,
    silentBrainAbortTimer: null,
    turnHardAbortTimer: null,
    toolFinalizationTimer: null,
    deferredTurnEndSafetyTimer: null,
    toolAuthorizationTimer: null,
    toolAuthorizationPollTimer: null,
    returnedTurnFinalizationTimer: null,
    persistedFinalAnswerPollTimer: null,
    persistedAssistantTextBaseline: 0,
    persistedAssistantMessageBaseline: 0,
    activeStreamToken: null,
    streamSource: null,
    degenerationAbortRequested: false,
    _lastTurnAborted: false,
    progressMarkerCount: 0,
    _turnEndDeferred: false,
    _turnClosed: false,
    lastActivity: Date.now(),
    ...(createSessionStreamState() as SessionStreamStateFields),
  };
}
