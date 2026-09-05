/** Review types layer. Extracted without changing policy or routing. */
import type { LLMApi, ModelId, ProviderId } from "../../../core/types.js";
import { errorCode } from './policy.js';

export type ReviewerKind = "hanako" | "butter";


export type ReviewProgressStage = "packing_context" | "reviewing" | "structuring" | "arbitrating" | "done";


export type ReviewVerdict = "pass" | "concerns" | "blocker";


export type JsonRecord = Record<string, unknown>;

export interface RuntimeAgentLike {
  id?: string;
  yuan?: string;
  tier?: string;
  agentName?: string;
  config?: {
    agent?: {
      yuan?: string;
      tier?: string;
    };
    api?: {
      provider?: string | null;
    };
    models?: {
      chat?: string | {
        id?: string | null;
        provider?: string | null;
      } | null;
    };
  };
  updateConfig?: (patch: unknown) => unknown;
}

export interface AgentListItem {
  id: string;
  name?: string;
  yuan?: string;
  tier?: string;
  hasAvatar?: boolean;
}

export interface ModelLike {
  id?: string | null;
  provider?: string | null;
  [key: string]: unknown;
}

export interface UtilityConfigLike {
  utility_large?: string | null;
  utility_large_provider?: string | null;
  utility_large_fallbacks?: Array<{ model?: string | null; provider?: string | null }>;
  utility?: string | null;
  utility_provider?: string | null;
  utility_fallbacks?: Array<{ model?: string | null; provider?: string | null }>;
}

export interface ReviewPreferences {
  review?: {
    defaultReviewer?: unknown;
    hanakoReviewerId?: unknown;
    butterReviewerId?: unknown;
  };
  [key: string]: unknown;
}

export interface ReviewConfig {
  defaultReviewer: ReviewerKind;
  hanakoReviewerId: string | null;
  butterReviewerId: string | null;
}

export interface ReviewCandidate {
  id: string;
  name: string;
  displayName: string;
  yuan: ReviewerKind;
  hasAvatar: boolean;
  isCurrent: boolean;
  modelId: string | null;
  modelProvider: string | null;
}

export interface GroupedReviewCandidates {
  hanako: ReviewCandidate[];
  butter: ReviewCandidate[];
}

export interface BuiltReviewConfig extends ReviewConfig {
  candidates: GroupedReviewCandidates;
  resolvedReviewer: (ReviewCandidate & { reviewerName: string }) | null;
}

export interface ReviewRouteEngine {
  currentAgentId?: string | null;
  currentSessionPath?: string | null;
  deskCwd?: string | null;
  homeCwd?: string | null;
  currentModel?: ModelLike | null;
  availableModels?: ModelLike[];
  getPreferences?: () => ReviewPreferences;
  savePreferences?: (prefs: ReviewPreferences) => unknown;
  listAgents?: () => AgentListItem[];
  getAgent?: (id: string) => RuntimeAgentLike | null | undefined;
  createAgent?: (opts: { name: string; yuan: ReviewerKind }) => Promise<{ id?: string | null } | null | undefined>;
  ensureAgentLoaded?: (id: string) => Promise<RuntimeAgentLike | null | undefined>;
  invalidateAgentListCache?: () => unknown;
  resolveUtilityConfig?: () => UtilityConfigLike | null | undefined;
  resolveProviderCredentials?: (provider: string | null | undefined) => {
    api_key?: string;
    base_url?: string;
    api?: LLMApi;
  } | null | undefined;
  authStorage?: {
    get?: (provider: string | null | undefined) => { type?: string; resourceUrl?: string } | null | undefined;
    getApiKey?: (provider: string | null | undefined) => Promise<string | null | undefined> | string | null | undefined;
  } | null;
  providerRegistry?: {
    get?: (provider: string | null | undefined) => {
      authType?: string;
      baseUrl?: string;
      api?: LLMApi;
    } | null | undefined;
  } | null;
}

export interface BroadcastPayload extends JsonRecord {
  type: string;
}


export type BroadcastFn = (payload: BroadcastPayload) => unknown;

export interface ReviewTaskRuntime {
  createReviewFollowUpTask(input: JsonRecord): unknown;
}

export interface CreateReviewRouteOptions {
  broadcast?: BroadcastFn;
  taskRuntime?: ReviewTaskRuntime | null;
}

export interface StartReviewRunRequest {
  context: string;
  reviewerKind?: unknown;
  sessionPath?: string | null;
  reviewId?: string | null;
  autoReview?: boolean;
  reviewMode?: "background" | "fallback" | string | null;
  triggerReasons?: string[];
  sourceResponse?: string | null;
}

export interface StartReviewRunResult {
  reviewId: string;
  sessionPath: string | null;
  reviewerName: string;
  reviewerAgent: string;
  reviewerAgentName: string;
  reviewerYuan: ReviewerKind;
  reviewerHasAvatar: boolean;
}

export interface CodedError extends Error {
  code?: string;
}

export interface ReviewRunResult {
  content: string;
  fallbackNote: string | null;
  errorCode: string | null;
  usedModelId: string | null;
  usedModelProvider: string | null;
  usedModelLabel: string | null;
}

export interface DirectReviewModelConfig {
  model: ModelId;
  provider: ProviderId;
  api: LLMApi;
  apiKey: string;
  baseUrl: string;
  label: string | null;
  requestHeaders?: Record<string, string> | null;
}

export interface StructuredReviewFinding {
  severity?: string;
  title?: string;
  detail?: string;
  suggestion?: string;
  filePath?: string;
}

export interface StructuredReviewLike extends JsonRecord {
  summary?: string;
  verdict?: ReviewVerdict | string;
  findings?: StructuredReviewFinding[];
  nextStep?: string;
  workflowGate?: string;
  secondOpinion?: ReviewSecondOpinion;
}

export interface ReviewSecondOpinion {
  status: "pending" | "completed" | "unavailable" | "timeout" | "circuit_open";
  modelLabel: string;
  verdict?: string;
  summary?: string;
  agreement?: boolean;
  latencyMs?: number;
  reason?: string;
}

export interface SessionContextPack {
  userText: string;
  assistantText: string;
  toolUses: Array<{ name: string; argsPreview: string }>;
  recentMessages: Array<{ role: string; text: string }>;
}

export interface ReviewContextPack {
  request: string;
  gitContext: { sessionPath: string; sessionFile: string } | null;
  sessionContext: SessionContextPack | null;
  workspacePath?: string;
}

export interface FollowUpContextPackShape {
  request?: string;
  workspacePath?: string;
  sessionContext?: {
    userText?: string;
    assistantText?: string;
  };
}

export interface ReviewerShapePatch {
  yuan?: ReviewerKind;
  tier?: "local" | "reviewer";
}

export interface ReviewFollowUpBody extends JsonRecord {
  structuredReview?: unknown;
  sessionPath?: unknown;
  followUpPrompt?: unknown;
  contextPack?: unknown;
  reviewerName?: unknown;
  sourceResponse?: unknown;
  executionResolution?: unknown;
  reviewId?: unknown;
}

export interface ReviewConfigBody extends JsonRecord {
  defaultReviewer?: unknown;
  hanakoReviewerId?: unknown;
  butterReviewerId?: unknown;
}

export interface ReviewRequestBody extends JsonRecord {
  context?: unknown;
  reviewerKind?: unknown;
  reviewId?: unknown;
  autoReview?: unknown;
  reviewMode?: unknown;
  triggerReasons?: unknown;
  sourceResponse?: unknown;
}

export interface ReviewProgressEmitterArgs {
  broadcast: BroadcastFn;
  reviewId: string;
  sessionPath: string | null;
  reviewer: ReviewCandidate;
}

export interface ToolUseBlock extends JsonRecord {
  type?: unknown;
  input?: unknown;
  arguments?: unknown;
  name?: unknown;
}

export interface SessionMessageBlock extends JsonRecord {
  type?: unknown;
  text?: unknown;
}

export interface SessionMessageRecord extends JsonRecord {
  type?: unknown;
  message?: {
    role?: unknown;
    content?: unknown;
  };
}
