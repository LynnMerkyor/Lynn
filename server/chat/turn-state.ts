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

export interface ChatTurnState extends SessionStreamStateFields {
  thinkTagParser: ThinkTagParser;
  progressParser: LynnProgressParser;
  moodParser: MoodParser;
  xingParser: XingParser;
  isThinking: boolean;
  hasOutput: boolean;
  hasToolCall: boolean;
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
  internalRetryCounts: Record<string, number>;
  internalRetryPending: boolean;
  internalRetryInFlight: boolean;
  internalRetryReason: string;
  internalRetryOriginalVisibleLen: number;
  internalRetryHadVisibleBeforeReset: boolean;
  successfulToolCount: number;
  lastSuccessfulTools: ToolSuccessRecord[];
  hasFailedTool: boolean;
  lastFailedTools: string[];
  toolStormGuard: {
    total: number;
    evidenceTotal: number;
    byName: Record<string, number>;
    bySignature: Record<string, number>;
    lastDecisionReason: string;
  };
  toolStormClosed: boolean;
  realtimeToolFallbackText?: string;
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
  streamSource: unknown | null;
  degenerationAbortRequested: boolean;
  _lastTurnAborted: boolean;
  progressMarkerCount: number;
  _turnEndDeferred: boolean;
  _turnClosed: boolean;
  lastActivity: number;
  [key: string]: unknown;
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
    internalRetryCounts: {},
    internalRetryPending: false,
    internalRetryInFlight: false,
    internalRetryReason: "",
    internalRetryOriginalVisibleLen: 0,
    internalRetryHadVisibleBeforeReset: false,
    successfulToolCount: 0,
    lastSuccessfulTools: [],
    hasFailedTool: false,
    lastFailedTools: [],
    toolStormGuard: {
      total: 0,
      evidenceTotal: 0,
      byName: {},
      bySignature: {},
      lastDecisionReason: "",
    },
    toolStormClosed: false,
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
