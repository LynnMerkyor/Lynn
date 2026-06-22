/**
 * review.js — 按需 Review 路由
 *
 * POST /api/review
 *   body: { context, reviewerKind? }
 *
 * 仅允许 Hanako / Butter 作为审查人。
 * 可在设置中分别绑定对应 persona 的 reviewer agent，并设置默认审查人。
 *
 * GET /api/review/config
 * PUT /api/review/config
 * GET /api/review/agents
 */

import fs from "fs";
import path from "path";
import { Hono } from "hono";
import { runAgentSession, type AgentSessionRound, type RunAgentSessionOptions } from "../../hub/agent-executor.js";
import { callText } from "../../core/llm-client.js";
import type { LLMApi, ModelId, ProviderId } from "../../core/types.js";
import { getLocale } from "../i18n.js";
import { buildReviewFollowUp, parseStructuredReview } from "../review-result.js";
import { buildReviewFollowUpTaskPrompt, buildReviewFollowUpTaskTitle } from "../review-follow-up.js";
import {
  getRoleDefaultModelRefs,
  getUserFacingModelAlias,
  getUserFacingRoleModelLabel,
} from "../../shared/assistant-role-models.js";

export type ReviewerKind = "hanako" | "butter";
type ReviewProgressStage = "packing_context" | "reviewing" | "structuring" | "done";
type ReviewVerdict = "pass" | "concerns" | "blocker";
type JsonRecord = Record<string, unknown>;

interface RuntimeAgentLike {
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

interface AgentListItem {
  id: string;
  name?: string;
  yuan?: string;
  tier?: string;
  hasAvatar?: boolean;
}

interface ModelLike {
  id?: string | null;
  provider?: string | null;
  [key: string]: unknown;
}

interface UtilityConfigLike {
  utility_large?: string | null;
  utility_large_provider?: string | null;
  utility_large_fallbacks?: Array<{ model?: string | null; provider?: string | null }>;
  utility?: string | null;
  utility_provider?: string | null;
  utility_fallbacks?: Array<{ model?: string | null; provider?: string | null }>;
}

interface ReviewPreferences {
  review?: {
    defaultReviewer?: unknown;
    hanakoReviewerId?: unknown;
    butterReviewerId?: unknown;
  };
  [key: string]: unknown;
}

interface ReviewConfig {
  defaultReviewer: ReviewerKind;
  hanakoReviewerId: string | null;
  butterReviewerId: string | null;
}

interface ReviewCandidate {
  id: string;
  name: string;
  displayName: string;
  yuan: ReviewerKind;
  hasAvatar: boolean;
  isCurrent: boolean;
  modelId: string | null;
  modelProvider: string | null;
}

interface GroupedReviewCandidates {
  hanako: ReviewCandidate[];
  butter: ReviewCandidate[];
}

interface BuiltReviewConfig extends ReviewConfig {
  candidates: GroupedReviewCandidates;
  resolvedReviewer: (ReviewCandidate & { reviewerName: string }) | null;
}

interface ReviewRouteEngine {
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

interface BroadcastPayload extends JsonRecord {
  type: string;
}

type BroadcastFn = (payload: BroadcastPayload) => unknown;

interface ReviewTaskRuntime {
  createReviewFollowUpTask(input: JsonRecord): unknown;
}

interface CreateReviewRouteOptions {
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

interface CodedError extends Error {
  code?: string;
}

interface ReviewRunResult {
  content: string;
  fallbackNote: string | null;
  errorCode: string | null;
  usedModelId: string | null;
  usedModelProvider: string | null;
  usedModelLabel: string | null;
}

interface DirectReviewModelConfig {
  model: ModelId;
  provider: ProviderId;
  api: LLMApi;
  apiKey: string;
  baseUrl: string;
  label: string | null;
}

interface StructuredReviewFinding {
  severity?: string;
  title?: string;
  detail?: string;
  suggestion?: string;
  filePath?: string;
}

interface StructuredReviewLike extends JsonRecord {
  summary?: string;
  verdict?: ReviewVerdict | string;
  findings?: StructuredReviewFinding[];
  nextStep?: string;
  workflowGate?: string;
}

interface SessionContextPack {
  userText: string;
  assistantText: string;
  toolUses: Array<{ name: string; argsPreview: string }>;
  recentMessages: Array<{ role: string; text: string }>;
}

interface ReviewContextPack {
  request: string;
  gitContext: { sessionPath: string; sessionFile: string } | null;
  sessionContext: SessionContextPack | null;
  workspacePath?: string;
}

interface FollowUpContextPackShape {
  request?: string;
  workspacePath?: string;
  sessionContext?: {
    userText?: string;
    assistantText?: string;
  };
}

interface ReviewerShapePatch {
  yuan?: ReviewerKind;
  tier?: "local" | "reviewer";
}

interface ReviewFollowUpBody extends JsonRecord {
  structuredReview?: unknown;
  sessionPath?: unknown;
  followUpPrompt?: unknown;
  contextPack?: unknown;
  reviewerName?: unknown;
  sourceResponse?: unknown;
  executionResolution?: unknown;
  reviewId?: unknown;
}

interface ReviewConfigBody extends JsonRecord {
  defaultReviewer?: unknown;
  hanakoReviewerId?: unknown;
  butterReviewerId?: unknown;
}

interface ReviewRequestBody extends JsonRecord {
  context?: unknown;
  reviewerKind?: unknown;
  reviewId?: unknown;
  autoReview?: unknown;
  reviewMode?: unknown;
  triggerReasons?: unknown;
  sourceResponse?: unknown;
}

interface ReviewProgressEmitterArgs {
  broadcast: BroadcastFn;
  reviewId: string;
  sessionPath: string | null;
  reviewer: ReviewCandidate;
}

interface ToolUseBlock extends JsonRecord {
  type?: unknown;
  input?: unknown;
  arguments?: unknown;
  name?: unknown;
}

interface SessionMessageBlock extends JsonRecord {
  type?: unknown;
  text?: unknown;
}

interface SessionMessageRecord extends JsonRecord {
  type?: unknown;
  message?: {
    role?: unknown;
    content?: unknown;
  };
}

const REVIEWER_YUANS = new Set<ReviewerKind>(["hanako", "butter"]);
const BUILT_IN_REVIEWER_IDS = new Set(["hanako", "butter"]);
const REVIEW_PROGRESS_STAGES: ReviewProgressStage[] = ["packing_context", "reviewing", "structuring", "done"];
const MAX_CONTEXT_PREVIEW_CHARS = 2200;
const MAX_SESSION_LINES = 120;
const MAX_TOOL_ITEMS = 10;
const REVIEW_EXEC_TIMEOUT_MS = 45_000;
const REVIEW_FALLBACK_TIMEOUT_MS = 22_000;
const AUTO_REVIEW_EXEC_TIMEOUT_MS = Number(process.env.LYNN_AUTO_REVIEW_TIMEOUT_MS || 35_000);
const AUTO_REVIEW_FALLBACK_TIMEOUT_MS = Number(process.env.LYNN_AUTO_REVIEW_FALLBACK_TIMEOUT_MS || 18_000);
const AUTO_REVIEW_CHAIN_TIMEOUT_MS = Math.max(
  AUTO_REVIEW_EXEC_TIMEOUT_MS + AUTO_REVIEW_FALLBACK_TIMEOUT_MS + 15_000,
  AUTO_REVIEW_EXEC_TIMEOUT_MS * 3,
);
const AUTO_REVIEW_MAX_OUTPUT_TOKENS = Math.max(1200, Math.min(2400, Number(process.env.LYNN_AUTO_REVIEW_MAX_TOKENS || 2000)));
const AUTO_REVIEW_MODEL_LABEL = "Hanako · DS V4";
const AUTO_REVIEW_FALLBACK_LABEL = "Hanako · DS V4/GLM/Brain";
const AUTO_REVIEW_FALLBACK_PROVIDERS = new Set(["deepseek", "zhipu", "zhipu-coding", "brain"]);
const AUTO_REVIEW_DEEPSEEK_PROVIDERS = new Set(["deepseek"]);
const AUTO_REVIEW_GLM_PROVIDERS = new Set(["zhipu", "zhipu-coding"]);
const AUTO_REVIEW_BRAIN_PROVIDERS = new Set(["brain"]);
const AUTO_REVIEW_GLM_MAX_CONCURRENCY = Math.max(1, Number(process.env.LYNN_AUTO_REVIEW_GLM_MAX_CONCURRENCY || 1));
const reviewExecutionQueues = new Map<string, Promise<void>>();
let activeAutoReviewGlmCalls = 0;
const autoReviewGlmWaiters: Array<() => void> = [];

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function asStructuredReview(value: unknown): StructuredReviewLike | null {
  const record = asRecord(value);
  if (!record) return null;
  const findings = Array.isArray(record.findings)
    ? record.findings
        .map((finding) => asRecord(finding))
        .filter((finding): finding is JsonRecord => !!finding)
        .map((finding) => ({
          severity: typeof finding.severity === "string" ? finding.severity : undefined,
          title: typeof finding.title === "string" ? finding.title : undefined,
          detail: typeof finding.detail === "string" ? finding.detail : undefined,
          suggestion: typeof finding.suggestion === "string" ? finding.suggestion : undefined,
          filePath: typeof finding.filePath === "string" ? finding.filePath : undefined,
        }))
    : undefined;
  return {
    ...record,
    summary: typeof record.summary === "string" ? record.summary : undefined,
    verdict: typeof record.verdict === "string" ? record.verdict : undefined,
    findings,
    nextStep: typeof record.nextStep === "string" ? record.nextStep : undefined,
    workflowGate: typeof record.workflowGate === "string" ? record.workflowGate : undefined,
  };
}

function errorMessage(err: unknown, fallback = ""): string {
  return err instanceof Error ? err.message : (fallback || String(err || ""));
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "";
}

function errorCode(err: unknown): string | null {
  const record = asRecord(err);
  return typeof record?.code === "string" ? record.code : null;
}

function stripThinkTags(raw: unknown): string {
  return String(raw || "")
    .replace(/<think>[\s\S]*?<\/think>\n*/gi, "")
    .trim();
}

function isZh(): boolean {
  return getLocale().startsWith("zh");
}

function buildReviewSystemAppend(options: { autoReview?: boolean; reviewMode?: string | null } = {}): string {
  const autoReview = !!options.autoReview;
  const fallbackMode = options.reviewMode === "fallback";
  if (isZh()) {
    if (autoReview) {
      return [
        "你是 Hanako 自动复查员。请用中文简洁复查另一个回答。",
        "重点检查：事实、数字、日期、工具证据、明显遗漏、空答或工具成功但无总结。",
        fallbackMode
          ? "原回答可能为空或不完整；证据足够时给出简短替代答案，证据不足时明确说明缺口。"
          : "不要重写原回答；没有问题就直接说通过。",
        "先给自然语言结论，随后追加一个 ```json 代码块。",
        "JSON 结构必须是 { summary, verdict, findings, nextStep? }。",
        "verdict 只能是 pass / concerns / blocker。",
        "findings 是数组；每项包含 severity(high|medium|low), title, detail, suggestion?。",
        "最多 5 条要点。",
      ].filter(Boolean).join("\n");
    }
    const lines = [
      "你现在是 Review 角色。另一个 Agent 刚刚完成了一项任务，用户请求你复查。",
      "",
      "要求：",
      "- 保留你的 MOOD / PULSE / REFLECT 区块（这是你的思维框架，review 时同样有用）",
      "- 聚焦于：逻辑漏洞、遗漏的边界情况、可改进的点、潜在风险",
      "- 如果一切看起来没问题，简短确认即可，不要为了挑刺而挑刺",
      ...(autoReview
        ? [
            "- 这是后台自动复查：请保持精炼，正文最多 5 条要点，不要重写整篇答案",
            "- 优先检查事实、数字、时间、工具证据和明显遗漏；没有问题就直接说通过",
            "- 不要写长篇解释；目标是在 600-1200 token 内完成",
          ]
        : []),
      ...(fallbackMode
        ? [
            "- 原回答可能为空或不完整：如果上下文里有足够证据，请给出一个简短可用的替代答案",
            "- 如果证据不足，请明确说还缺什么，而不是编造",
          ]
        : []),
      "- 先在正文给出你自然语言的 review 结论",
      "- 然后严格追加一个 ```json 代码块，结构必须是 { summary, verdict, findings, nextStep? }",
      "- verdict 只能是 pass / concerns / blocker",
      "- findings 必须是数组；每项包含 severity(high|medium|low), title, detail, suggestion?, filePath?",
      "- 如果没有问题，findings 返回空数组",
      "- 语气：像一个认真但友善的同事在帮忙把关",
    ];
    return lines.join("\n");
  }

  if (autoReview) {
    return [
      "You are Hanako, an automatic reviewer. Review the other answer concisely.",
      "Check facts, numbers, dates, tool evidence, obvious omissions, empty answers, and cases where tools succeeded but no summary was given.",
      fallbackMode
        ? "The source answer may be empty or incomplete. If evidence is enough, provide a short substitute answer; otherwise state what is missing."
        : "Do not rewrite the whole answer. If it looks fine, say it passes.",
      "First provide a natural-language conclusion, then append one strict ```json code block.",
      "JSON shape: { summary, verdict, findings, nextStep? }.",
      "verdict must be pass / concerns / blocker.",
      "findings must be an array; each item includes severity(high|medium|low), title, detail, suggestion?.",
      "Use at most 5 bullets.",
    ].filter(Boolean).join("\n");
  }

  return [
    "You are now in Review mode. Another agent just completed a task, and the user asked you to review it.",
    "",
    "Requirements:",
    "- Keep your MOOD / PULSE / REFLECT block (it's your thinking framework, useful for review too)",
    "- Focus on: logic gaps, missed edge cases, areas for improvement, potential risks",
    "- If everything looks fine, confirm briefly. Do not nitpick for the sake of it",
    ...(autoReview
      ? [
          "- This is an automatic background review: keep it concise, with at most 5 visible bullets",
          "- Prioritize factual claims, numbers, dates, tool evidence, and obvious omissions",
          "- Do not rewrite the whole answer. Aim to finish within 600-1200 tokens",
        ]
      : []),
    ...(fallbackMode
      ? [
          "- The source answer may be empty or incomplete. If the provided evidence is enough, produce a short usable substitute answer",
          "- If evidence is insufficient, state what is missing instead of inventing details",
        ]
      : []),
    "- First give your natural-language review conclusion",
    "- Then append a strict ```json code block with { summary, verdict, findings, nextStep? }",
    "- verdict must be one of pass / concerns / blocker",
    "- findings must be an array; each item should include severity(high|medium|low), title, detail, suggestion?, filePath?",
    "- If there are no issues, return an empty findings array",
    "- Tone: like a thoughtful colleague doing a careful review",
  ].join("\n");
}

function normalizeReviewerKind(kind: unknown): ReviewerKind {
  return kind === "butter" ? "butter" : "hanako";
}

function normalizeReviewerId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function reviewerDisplayName(yuan: ReviewerKind | string | null | undefined): string {
  return yuan === "butter" ? "Butter" : "Hanako";
}

function ensureReviewerAgentShape(engine: ReviewRouteEngine, kind: ReviewerKind, reviewerId: unknown): boolean {
  const agentId = normalizeReviewerId(reviewerId);
  if (!agentId || typeof engine.getAgent !== "function") return false;

  const agent = engine.getAgent(agentId);
  if (!agent || typeof agent.updateConfig !== "function") return false;

  const currentYuan = String(agent?.config?.agent?.yuan || agent?.yuan || "").trim().toLowerCase();
  const currentTier = String(agent?.config?.agent?.tier || agent?.tier || "").trim().toLowerCase();
  const nextAgent: ReviewerShapePatch = {};
  const isBuiltInReviewer = BUILT_IN_REVIEWER_IDS.has(agentId);

  if (currentYuan !== kind) nextAgent.yuan = kind;
  if (isBuiltInReviewer) {
    if (currentTier === "reviewer") nextAgent.tier = "local";
  } else if (currentTier !== "reviewer") {
    nextAgent.tier = "reviewer";
  }
  if (Object.keys(nextAgent).length === 0) return false;

  try {
    agent.updateConfig({ agent: nextAgent });
    engine.invalidateAgentListCache?.();
    return true;
  } catch {
    return false;
  }
}

function normalizeReviewConfig(prefs: ReviewPreferences = {}): ReviewConfig {
  const raw = prefs.review && typeof prefs.review === "object" ? prefs.review : {};
  return {
    defaultReviewer: normalizeReviewerKind(raw.defaultReviewer),
    hanakoReviewerId: normalizeReviewerId(raw.hanakoReviewerId),
    butterReviewerId: normalizeReviewerId(raw.butterReviewerId),
  };
}

function getAgentModel(agent: RuntimeAgentLike | null | undefined): { modelId: string | null; modelProvider: string | null } {
  const raw = agent?.config?.models?.chat;
  if (typeof raw === "object" && raw) {
    return {
      modelId: raw.id || null,
      modelProvider: raw.provider || agent?.config?.api?.provider || null,
    };
  }

  return {
    modelId: raw || null,
    modelProvider: agent?.config?.api?.provider || null,
  };
}

function isTimeoutLikeError(err: unknown): boolean {
  const name = errorName(err);
  const message = errorMessage(err);
  return name === "AbortError"
    || /aborted due to timeout/i.test(message)
    || /\btimeout\b/i.test(message);
}

function isRetryableReviewError(err: unknown): boolean {
  if (errorCode(err) === "review_model_busy") return true;
  if (errorCode(err) === "LLM_AUTH_FAILED") return true;
  if (isTimeoutLikeError(err)) return true;
  const message = errorMessage(err);
  if (/review returned no output|没有产出可显示的复查结果|no review output/i.test(message)) return true;
  return /\b(429|500|502|503|504)\b/.test(message)
    || /rate limit/i.test(message)
    || /overload/i.test(message)
    || /network/i.test(message)
    || /fetch failed/i.test(message)
    || /ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(message);
}

function hasMeaningfulReviewOutput(content: unknown): content is string {
  return typeof content === "string" && content.trim().length > 0;
}

function buildDeterministicReviewFallbackContent(input: {
  autoReview?: boolean;
  attemptedModels?: string[];
  lastError?: unknown;
} = {}): string {
  const attempted = Array.isArray(input.attemptedModels) ? input.attemptedModels.filter(Boolean) : [];
  const reason = isTimeoutLikeError(input.lastError)
    ? (isZh() ? "复查模型在时限内没有完成输出" : "the review model did not finish within the timeout")
    : (isZh() ? "复查模型暂时没有返回可见文本" : "the review model did not return visible text");
  const tried = attempted.length
    ? (isZh() ? `，已尝试 ${attempted.length} 个 ${AUTO_REVIEW_FALLBACK_LABEL} 候选` : ` after trying ${attempted.length} ${AUTO_REVIEW_FALLBACK_LABEL} candidate(s)`)
    : "";
  const summary = isZh()
    ? `${reason}${tried}。本次已降级为最低限度复查：没有生成新的模型判断；请把此结论视为可继续讨论的兜底状态。`
    : `Hanako review degraded because ${reason}${tried}. No new model judgment was produced; treat this as a fallback state that lets the conversation continue.`;
  const nextStep = isZh()
    ? (input.autoReview ? "可以先继续讨论原回答；涉及事实、数字、时效性时建议稍后手动复查。" : "建议稍后重试复查，或继续讨论原回答中的具体可疑点。")
    : (input.autoReview ? "You can continue with the original answer for now; manually re-run review later for factual or time-sensitive claims." : "Retry the review later, or continue by pointing at the specific claim you want checked.");
  const findingTitle = isZh() ? "复查模型未返回可见文本" : "Review model returned no visible text";
  const findingDetail = summary;
  const findingSuggestion = nextStep;
  const json = {
    summary,
    verdict: "concerns",
    findings: [{
      severity: "low",
      title: findingTitle,
      detail: findingDetail,
      suggestion: findingSuggestion,
    }],
    nextStep,
  };
  const lead = isZh()
    ? [
        "Hanako 这次没有拿到可见的模型复查文本，已自动降级为兜底复查。",
        "",
        summary,
        nextStep,
      ].join("\n")
    : [
        "Hanako did not receive visible review text this time, so it fell back to a deterministic review status.",
        "",
        summary,
        nextStep,
      ].join("\n");
  return `${lead}\n\n\`\`\`json\n${JSON.stringify(json, null, 2)}\n\`\`\``;
}

function createReviewNoOutputError(): CodedError {
  const err: CodedError = new Error(isZh()
    ? "这次复查没有产出可显示的复查结果。"
    : "This review returned no output.");
  err.code = "review_no_output";
  return err;
}

function enqueueReviewerExecution(reviewerId: string, run: () => Promise<void>): void {
  const key = reviewerId || "reviewer";
  const previous = reviewExecutionQueues.get(key) || Promise.resolve();
  let next: Promise<void>;
  next = previous
    .catch(() => undefined)
    .then(run)
    .catch(() => undefined)
    .finally(() => {
      if (reviewExecutionQueues.get(key) === next) {
        reviewExecutionQueues.delete(key);
      }
    });
  reviewExecutionQueues.set(key, next);
}

function getAvailableModel(engine: ReviewRouteEngine, modelId: string | null | undefined, providerId: string | null = null): ModelLike | null {
  if (!modelId) return null;
  const models = Array.isArray(engine.availableModels) ? engine.availableModels : [];
  return models.find((model) => model.id === modelId && (!providerId || model.provider === providerId))
    || models.find((model) => model.id === modelId)
    || null;
}

function reviewModelDisplayLabel(
  reviewer: Pick<ReviewCandidate, "yuan"> | { yuan?: string | null } | null | undefined,
  modelId: string | null | undefined,
  providerId: string | null | undefined,
  fallbackLabel: string | null = null,
): string | null {
  const alias = getUserFacingModelAlias({
    modelId,
    provider: providerId,
    role: reviewer?.yuan,
    purpose: "review",
  });
  return alias
    || getUserFacingRoleModelLabel(reviewer?.yuan, "review")
    || fallbackLabel
    || null;
}

function isAutoReviewFallbackAllowed(model: ModelLike | null | undefined): boolean {
  const provider = String(model?.provider || "").trim().toLowerCase();
  if (!provider || !AUTO_REVIEW_FALLBACK_PROVIDERS.has(provider)) return false;
  if (AUTO_REVIEW_DEEPSEEK_PROVIDERS.has(provider)) {
    const id = normalizeModelId(model?.id);
    return id === "deepseek-v4-flash" || id.startsWith("deepseek-v4-flash-");
  }
  return true;
}

function normalizeProviderId(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

function normalizeModelId(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

function isAutoReviewGlmProvider(provider: unknown): boolean {
  return AUTO_REVIEW_GLM_PROVIDERS.has(normalizeProviderId(provider));
}

function autoReviewProviderTier(provider: unknown): number {
  const normalized = normalizeProviderId(provider);
  if (AUTO_REVIEW_DEEPSEEK_PROVIDERS.has(normalized)) return 0;
  if (AUTO_REVIEW_GLM_PROVIDERS.has(normalized)) return 1;
  if (AUTO_REVIEW_BRAIN_PROVIDERS.has(normalized)) return 2;
  return 9;
}

function autoReviewModelPreference(model: ModelLike | null | undefined): number {
  const provider = normalizeProviderId(model?.provider);
  const id = normalizeModelId(model?.id);
  if (AUTO_REVIEW_DEEPSEEK_PROVIDERS.has(provider)) {
    if (id === "deepseek-v4-flash") return 0;
    if (id.startsWith("deepseek-v4-flash-")) return 1;
    return 9;
  }
  if (AUTO_REVIEW_GLM_PROVIDERS.has(provider)) {
    if (id === "glm-5-turbo" || id === "glm-5.0-turbo") return 0;
    if (id.includes("glm-5") && id.includes("turbo")) return 1;
    if (id.includes("glm-5")) return 2;
    return 4;
  }
  if (AUTO_REVIEW_BRAIN_PROVIDERS.has(provider)) {
    if (id === "lynn-brain-router") return 0;
    if (id.includes("brain")) return 1;
    return 4;
  }
  return 9;
}

function sortAutoReviewModels(models: ModelLike[]): ModelLike[] {
  return [...models].sort((a, b) => {
    const providerTierDiff = autoReviewProviderTier(a?.provider) - autoReviewProviderTier(b?.provider);
    if (providerTierDiff !== 0) return providerTierDiff;
    const preferenceDiff = autoReviewModelPreference(a) - autoReviewModelPreference(b);
    if (preferenceDiff !== 0) return preferenceDiff;
    return `${a?.provider || ""}/${a?.id || ""}`.localeCompare(`${b?.provider || ""}/${b?.id || ""}`);
  });
}

function buildAutoReviewFallbackCandidates(
  engine: ReviewRouteEngine,
  originalModel: ModelLike | null | undefined,
  reviewerModel: { modelId: string | null; modelProvider: string | null } | null | undefined,
): ModelLike[] {
  const candidates: ModelLike[] = [];
  const seen = new Set<string>();
  const pushCandidate = (model: ModelLike | null | undefined) => {
    if (!model?.id || !model?.provider || !isAutoReviewFallbackAllowed(model)) return;
    const key = `${model.provider}/${model.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(model);
  };

  pushCandidate(originalModel);
  if (reviewerModel?.modelId) {
    pushCandidate(getAvailableModel(engine, reviewerModel.modelId, reviewerModel.modelProvider));
  }

  for (const model of Array.isArray(engine.availableModels) ? engine.availableModels : []) {
    pushCandidate(model);
  }

  return sortAutoReviewModels(candidates);
}

function makeAbortError(): Error {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

async function reserveAutoReviewModelSlot(
  config: DirectReviewModelConfig,
  autoReview?: boolean,
  signal?: AbortSignal,
): Promise<() => void> {
  if (!autoReview || !isAutoReviewGlmProvider(config.provider)) return () => {};

  const buildRelease = () => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activeAutoReviewGlmCalls = Math.max(0, activeAutoReviewGlmCalls - 1);
      const next = autoReviewGlmWaiters.shift();
      next?.();
    };
  };

  if (activeAutoReviewGlmCalls < AUTO_REVIEW_GLM_MAX_CONCURRENCY) {
    activeAutoReviewGlmCalls += 1;
    return buildRelease();
  }

  if (signal?.aborted) throw signal.reason || makeAbortError();

  return new Promise<() => void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
    };
    const grant = () => {
      if (settled) return;
      settled = true;
      cleanup();
      activeAutoReviewGlmCalls += 1;
      resolve(buildRelease());
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      const index = autoReviewGlmWaiters.indexOf(grant);
      if (index >= 0) autoReviewGlmWaiters.splice(index, 1);
      reject(signal?.reason || makeAbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    autoReviewGlmWaiters.push(grant);
  });
}

function buildReviewFallbackCandidates(
  engine: ReviewRouteEngine,
  reviewer: ReviewCandidate,
  options: { autoReview?: boolean } = {},
): ModelLike[] {
  const candidates: ModelLike[] = [];
  const seen = new Set();
  const runtimeAgent = engine.getAgent?.(reviewer.id);
  const reviewerModel = runtimeAgent ? getAgentModel(runtimeAgent) : null;
  if (reviewerModel?.modelId) {
    seen.add(`${reviewerModel.modelProvider || ""}/${reviewerModel.modelId}`);
  }

  const pushCandidate = (model: ModelLike | null | undefined) => {
    if (!model?.id || !model?.provider) return;
    if (options.autoReview && !isAutoReviewFallbackAllowed(model)) return;
    const key = `${model.provider}/${model.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(model);
  };

  for (const ref of getRoleDefaultModelRefs(reviewer?.yuan || null, "review")) {
    pushCandidate(getAvailableModel(engine, ref.id, ref.provider || null));
  }

  try {
    const utilityConfig = engine.resolveUtilityConfig?.();
    pushCandidate(getAvailableModel(engine, utilityConfig?.utility_large, utilityConfig?.utility_large_provider));
    for (const candidate of utilityConfig?.utility_large_fallbacks || []) {
      pushCandidate(getAvailableModel(engine, candidate?.model, candidate?.provider));
    }
    pushCandidate(getAvailableModel(engine, utilityConfig?.utility, utilityConfig?.utility_provider));
    for (const candidate of utilityConfig?.utility_fallbacks || []) {
      pushCandidate(getAvailableModel(engine, candidate?.model, candidate?.provider));
    }
  } catch {
    // Fallback to the current model when utility config is unavailable.
  }

  pushCandidate(engine.currentModel);
  return candidates;
}

async function resolveDirectReviewModelConfig(
  engine: ReviewRouteEngine,
  reviewer: ReviewCandidate,
  model: ModelLike | null | undefined,
  modelIdFallback: string | null | undefined = null,
  providerFallback: string | null | undefined = null,
): Promise<DirectReviewModelConfig | null> {
  const modelId = String(model?.id || modelIdFallback || "").trim();
  const provider = String(model?.provider || providerFallback || "").trim();
  if (!modelId || !provider) return null;

  const creds = engine.resolveProviderCredentials?.(provider) || {};
  const oauthCred = engine.authStorage?.get?.(provider);
  const oauthBaseUrl = oauthCred?.type === "oauth" ? String(oauthCred.resourceUrl || "") : "";
  const providerEntry = engine.providerRegistry?.get?.(provider);
  const baseUrl = String(creds.base_url || oauthBaseUrl || model?.baseUrl || providerEntry?.baseUrl || "").trim();
  const api = (creds.api || (model?.api as LLMApi | undefined) || providerEntry?.api || "openai-completions") as LLMApi;
  let apiKey = String(creds.api_key || "");
  if (!apiKey) {
    try {
      apiKey = String(await engine.authStorage?.getApiKey?.(provider) || "");
    } catch {
      // Some providers intentionally allow missing keys; validate below.
    }
  }

  const allowMissingApiKey = providerEntry?.authType === "none";
  if (!baseUrl) return null;
  if (!apiKey && !allowMissingApiKey) return null;

  return {
    model: modelId as ModelId,
    provider: provider as ProviderId,
    api,
    apiKey,
    baseUrl,
    label: reviewModelDisplayLabel(reviewer, modelId, provider, AUTO_REVIEW_MODEL_LABEL),
  };
}

async function runDirectReviewerModel(
  engine: ReviewRouteEngine,
  reviewer: ReviewCandidate,
  config: DirectReviewModelConfig,
  prompt: string,
  options: { autoReview?: boolean; reviewMode?: string | null; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs || (options.autoReview ? AUTO_REVIEW_EXEC_TIMEOUT_MS : REVIEW_EXEC_TIMEOUT_MS);
  const releaseSlot = await reserveAutoReviewModelSlot(config, options.autoReview, options.signal);
  try {
    return await callText({
      api: config.api,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      provider: config.provider,
      systemPrompt: buildReviewSystemAppend({
        autoReview: options.autoReview,
        reviewMode: options.reviewMode,
      }),
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      maxTokens: options.autoReview ? AUTO_REVIEW_MAX_OUTPUT_TOKENS : 1800,
      timeoutMs,
      signal: options.signal,
      reasoning: false,
      quirks: ["enable_thinking"],
    });
  } finally {
    releaseSlot();
  }
}

async function runDirectReviewerSessionWithFallback(
  engine: ReviewRouteEngine,
  reviewer: ReviewCandidate,
  prompt: string,
  timing: { fallbackTimeoutMs?: number; autoReview?: boolean; reviewMode?: string | null; signal?: AbortSignal } = {},
): Promise<ReviewRunResult> {
  const runtimeAgent = engine.getAgent?.(reviewer.id);
  const reviewerModel = runtimeAgent ? getAgentModel(runtimeAgent) : null;
  const originalModel = reviewerModel?.modelId
    ? getAvailableModel(engine, reviewerModel.modelId, reviewerModel.modelProvider)
    : null;
  const originalConfig = await resolveDirectReviewModelConfig(
    engine,
    reviewer,
    originalModel,
    reviewerModel?.modelId,
    reviewerModel?.modelProvider,
  );
  const attemptedModels: string[] = [];
  let lastError: unknown = createReviewNoOutputError();

  if (timing.autoReview) {
    const candidates = buildAutoReviewFallbackCandidates(engine, originalModel, reviewerModel);
    for (const candidate of candidates) {
      const config = await resolveDirectReviewModelConfig(engine, reviewer, candidate, candidate?.id, candidate?.provider);
      if (!config) continue;
      if (config.label) attemptedModels.push(config.label);
      try {
        const content = await runDirectReviewerModel(engine, reviewer, config, prompt, {
          autoReview: true,
          reviewMode: timing.reviewMode,
          timeoutMs: AUTO_REVIEW_EXEC_TIMEOUT_MS,
          // Automatic Hanako reviews may queue behind the GLM single-flight
          // guard. The model execution timeout still applies inside callText;
          // do not spend that budget while merely waiting for the queue.
          signal: undefined,
        });
        if (!hasMeaningfulReviewOutput(content)) {
          throw createReviewNoOutputError();
        }
        const originalLabel = originalConfig?.label || AUTO_REVIEW_MODEL_LABEL;
        const nextLabel = config.label || AUTO_REVIEW_MODEL_LABEL;
        const switched = originalConfig && (config.model !== originalConfig.model || config.provider !== originalConfig.provider);
        const fallbackNote = switched
          ? (isZh()
              ? `Hanako 自动复查已按 DS V4 优先策略切换到 ${nextLabel} 完成。`
              : `Hanako automatic review switched to ${nextLabel} according to the DS V4-first policy.`)
          : null;
        return {
          content,
          fallbackNote,
          errorCode: switched ? "review_fallback_recovered" : null,
          usedModelId: config.model,
          usedModelProvider: config.provider,
          usedModelLabel: nextLabel || originalLabel,
        };
      } catch (err) {
        lastError = err;
        if (!isRetryableReviewError(err)) break;
      }
    }

    return {
      content: buildDeterministicReviewFallbackContent({
        autoReview: timing.autoReview,
        attemptedModels,
        lastError,
      }),
      fallbackNote: formatReviewFailureMessage(lastError, attemptedModels),
      errorCode: "review_deterministic_fallback",
      usedModelId: null,
      usedModelProvider: null,
      usedModelLabel: AUTO_REVIEW_MODEL_LABEL,
    };
  }

  if (originalConfig) {
    try {
      const content = await runDirectReviewerModel(engine, reviewer, originalConfig, prompt, {
        autoReview: timing.autoReview,
        reviewMode: timing.reviewMode,
        timeoutMs: timing.autoReview ? AUTO_REVIEW_EXEC_TIMEOUT_MS : REVIEW_EXEC_TIMEOUT_MS,
        signal: timing.signal,
      });
      if (!hasMeaningfulReviewOutput(content)) {
        throw createReviewNoOutputError();
      }
      return {
        content,
        fallbackNote: null,
        errorCode: null,
        usedModelId: originalConfig.model,
        usedModelProvider: originalConfig.provider,
        usedModelLabel: originalConfig.label,
      };
    } catch (err) {
      lastError = err;
      if (!isRetryableReviewError(err)) throw err;
    }
  }

  const candidates = buildReviewFallbackCandidates(engine, reviewer, { autoReview: timing.autoReview });
  for (const candidate of candidates) {
    const config = await resolveDirectReviewModelConfig(engine, reviewer, candidate, candidate?.id, candidate?.provider);
    if (!config) continue;
    if (originalConfig && config.model === originalConfig.model && config.provider === originalConfig.provider) continue;
    if (config.label) attemptedModels.push(config.label);
    try {
      const content = await runDirectReviewerModel(engine, reviewer, config, prompt, {
        autoReview: timing.autoReview,
        reviewMode: timing.reviewMode,
        timeoutMs: timing.fallbackTimeoutMs || REVIEW_FALLBACK_TIMEOUT_MS,
        signal: timing.signal,
      });
      if (!hasMeaningfulReviewOutput(content)) {
        throw createReviewNoOutputError();
      }
      const timeoutLike = isTimeoutLikeError(lastError);
      const originalLabel = originalConfig?.label || AUTO_REVIEW_MODEL_LABEL;
      const nextLabel = config.label || AUTO_REVIEW_MODEL_LABEL;
      const samePublicLabel = originalLabel === nextLabel;
      const fallbackNote = isZh()
        ? (samePublicLabel
            ? `${AUTO_REVIEW_MODEL_LABEL} 主候选${timeoutLike ? "超时" : "暂时不可用"}，已自动切换到备用候选完成这次复查。`
            : `原复查模型 ${originalLabel}${timeoutLike ? " 超时" : " 暂时不可用"}，已自动切换到 ${nextLabel} 完成这次复查。`)
        : (samePublicLabel
            ? `The primary ${AUTO_REVIEW_MODEL_LABEL} candidate ${timeoutLike ? "timed out" : "became temporarily unavailable"}, so this review finished on a backup candidate.`
            : `The original review model ${originalLabel} ${timeoutLike ? "timed out" : "became temporarily unavailable"}, so this review finished on ${nextLabel}.`);
      return {
        content,
        fallbackNote,
        errorCode: isTimeoutLikeError(lastError) ? "review_timeout_recovered" : "review_fallback_recovered",
        usedModelId: config.model,
        usedModelProvider: config.provider,
        usedModelLabel: config.label,
      };
    } catch (retryErr) {
      lastError = retryErr;
      if (!isRetryableReviewError(retryErr)) break;
    }
  }

  return {
    content: buildDeterministicReviewFallbackContent({
      autoReview: timing.autoReview,
      attemptedModels,
      lastError,
    }),
    fallbackNote: formatReviewFailureMessage(lastError, attemptedModels),
    errorCode: "review_deterministic_fallback",
    usedModelId: null,
    usedModelProvider: null,
    usedModelLabel: AUTO_REVIEW_MODEL_LABEL,
  };
}

function formatReviewFailureMessage(err: unknown, attemptedModels: string[] = []): string {
  const modelHint = attemptedModels.length
    ? (isZh()
        ? ` 已自动尝试 ${attemptedModels.length} 个 ${AUTO_REVIEW_FALLBACK_LABEL} 备用模型`
        : ` It already retried with ${attemptedModels.length} fallback review models.`)
    : "";

  if (isTimeoutLikeError(err)) {
    return isZh()
      ? `这次复查超时了。${modelHint} 但仍然没能在时限内完成。你可以稍后重试，或先继续讨论原回答。`
      : `This review timed out.${modelHint} You can retry later or continue discussing the original answer for now.`;
  }

  if (isRetryableReviewError(err)) {
    return isZh()
      ? `这次复查暂时没跑完。${modelHint} 但服务仍不稳定。你可以稍后重试，或先继续讨论原回答。`
      : `This review could not finish right now.${modelHint} The service still looks unstable. Retry later or continue discussing the original answer.`;
  }

  if (errorCode(err) === "review_no_output" || /no review output|没有产出可显示的复查结果/i.test(errorMessage(err))) {
    return isZh()
      ? `这次复查没有生成可显示的结论。${modelHint} 但仍然没有拿到有效输出。你可以稍后重试，或先继续讨论原回答。`
      : `This review did not produce a usable result.${modelHint} You can retry later or continue discussing the original answer.`;
  }

  return errorMessage(err, isZh() ? "复查失败" : "Review failed");
}

async function runReviewerSessionWithFallback(
  engine: ReviewRouteEngine,
  reviewer: ReviewCandidate,
  rounds: AgentSessionRound[],
  opts: RunAgentSessionOptions,
  timing: { fallbackTimeoutMs?: number; autoReview?: boolean } = {},
): Promise<ReviewRunResult> {
  const runtimeAgent = engine.getAgent?.(reviewer.id);
  const reviewerModel = runtimeAgent ? getAgentModel(runtimeAgent) : null;
  const originalModel = reviewerModel?.modelId
    ? getAvailableModel(engine, reviewerModel.modelId, reviewerModel.modelProvider)
    : null;
  const originalModelLabel = reviewModelDisplayLabel(
    reviewer,
    originalModel?.id || reviewerModel?.modelId || null,
    originalModel?.provider || reviewerModel?.modelProvider || null,
    AUTO_REVIEW_MODEL_LABEL,
  ) || "";

  try {
    const content = await runAgentSession(reviewer.id, rounds, opts);
    if (!hasMeaningfulReviewOutput(content)) {
      throw createReviewNoOutputError();
    }
    return {
      content,
      fallbackNote: null,
      errorCode: null,
      usedModelId: originalModel?.id || reviewerModel?.modelId || null,
      usedModelProvider: originalModel?.provider || reviewerModel?.modelProvider || null,
      usedModelLabel: originalModelLabel || null,
    };
  } catch (err) {
    if (!isRetryableReviewError(err)) throw err;

    const candidates = buildReviewFallbackCandidates(engine, reviewer, { autoReview: timing.autoReview });
    const attemptedModels: string[] = [];
    let lastError = err;

    for (const candidate of candidates) {
      const candidateLabel = reviewModelDisplayLabel(
        reviewer,
        candidate?.id || null,
        candidate?.provider || null,
        AUTO_REVIEW_MODEL_LABEL,
      );
      if (candidateLabel) attemptedModels.push(candidateLabel);
      try {
        const content = await runAgentSession(reviewer.id, rounds, {
          ...opts,
          signal: AbortSignal.timeout(timing.fallbackTimeoutMs || REVIEW_FALLBACK_TIMEOUT_MS),
          modelOverride: candidate as RunAgentSessionOptions["modelOverride"],
        });
        if (!hasMeaningfulReviewOutput(content)) {
          throw createReviewNoOutputError();
        }
        const timeoutLike = isTimeoutLikeError(err);
        const nextLabel = candidateLabel || AUTO_REVIEW_MODEL_LABEL;
        const originalLabel = originalModelLabel || AUTO_REVIEW_MODEL_LABEL;
        const samePublicLabel = originalLabel === nextLabel;
        const fallbackNote = isZh()
          ? (samePublicLabel
              ? `${AUTO_REVIEW_MODEL_LABEL} 主候选${timeoutLike ? "超时" : "暂时不可用"}，已自动切换到备用候选完成这次复查。`
              : `原复查模型 ${originalLabel}${timeoutLike ? " 超时" : " 暂时不可用"}，已自动切换到 ${nextLabel} 完成这次复查。`)
          : (samePublicLabel
              ? `The primary ${AUTO_REVIEW_MODEL_LABEL} candidate ${timeoutLike ? "timed out" : "became temporarily unavailable"}, so this review finished on a backup candidate.`
              : `The original review model ${originalLabel} ${timeoutLike ? "timed out" : "became temporarily unavailable"}, so this review finished on ${nextLabel}.`);
        return {
          content,
          fallbackNote,
          errorCode: isTimeoutLikeError(err) ? "review_timeout_recovered" : "review_fallback_recovered",
          usedModelId: candidate?.id || null,
          usedModelProvider: candidate?.provider || null,
          usedModelLabel: candidateLabel || null,
        };
      } catch (retryErr) {
        lastError = retryErr;
        if (!isRetryableReviewError(retryErr)) break;
      }
    }

    return {
      content: buildDeterministicReviewFallbackContent({
        autoReview: timing.autoReview,
        attemptedModels,
        lastError,
      }),
      fallbackNote: formatReviewFailureMessage(lastError, attemptedModels),
      errorCode: "review_deterministic_fallback",
      usedModelId: null,
      usedModelProvider: null,
      usedModelLabel: AUTO_REVIEW_MODEL_LABEL,
    };
  }
}

function listReviewCandidates(engine: ReviewRouteEngine): ReviewCandidate[] {
  const agents = engine.listAgents?.() || [];
  return agents
    .filter((agent) => agent?.tier !== "expert")
    .filter((agent): agent is AgentListItem & { id: string; yuan: ReviewerKind } => REVIEWER_YUANS.has(agent?.yuan as ReviewerKind))
    .map((agent) => {
      const runtimeAgent = engine.getAgent?.(agent.id);
      const { modelId, modelProvider } = getAgentModel(runtimeAgent);
      return {
        id: agent.id,
        name: agent.name || runtimeAgent?.agentName || agent.id,
        displayName: reviewerDisplayName(agent.yuan),
        yuan: agent.yuan,
        hasAvatar: !!agent.hasAvatar,
        isCurrent: agent.id === engine.currentAgentId,
        modelId,
        modelProvider,
      };
    });
}

function groupCandidatesByYuan(candidates: ReviewCandidate[]): GroupedReviewCandidates {
  return {
    hanako: candidates.filter((candidate) => candidate.yuan === "hanako"),
    butter: candidates.filter((candidate) => candidate.yuan === "butter"),
  };
}

function resolveReviewer(
  groupedCandidates: GroupedReviewCandidates,
  kind: ReviewerKind,
  config: ReviewConfig,
  currentAgentId: string | null | undefined,
): ReviewCandidate | null {
  const candidates = (groupedCandidates[kind] || []).filter((candidate) => candidate.id !== currentAgentId);
  const preferredId = kind === "hanako" ? config.hanakoReviewerId : config.butterReviewerId;

  if (preferredId) {
    const preferred = candidates.find((candidate) => candidate.id === preferredId);
    if (preferred) return preferred;
  }

  return candidates[0] || null;
}

export function buildReviewConfig(engine: ReviewRouteEngine): BuiltReviewConfig {
  const prefs = engine.getPreferences?.() || {};
  const config = normalizeReviewConfig(prefs);
  const candidates = groupCandidatesByYuan(listReviewCandidates(engine));
  const resolved = resolveReviewer(candidates, config.defaultReviewer, config, engine.currentAgentId);

  return {
    ...config,
    candidates,
    resolvedReviewer: resolved ? { ...resolved, reviewerName: reviewerDisplayName(resolved.yuan) } : null,
  };
}

async function ensureDefaultReviewerAgents(engine: ReviewRouteEngine): Promise<BuiltReviewConfig> {
  if (typeof engine.createAgent !== "function") return buildReviewConfig(engine);

  const prefs = engine.getPreferences?.() || {};
  const normalizedConfig = normalizeReviewConfig(prefs);
  let repaired = false;
  repaired = ensureReviewerAgentShape(engine, "hanako", normalizedConfig.hanakoReviewerId || "hanako") || repaired;
  repaired = ensureReviewerAgentShape(engine, "butter", normalizedConfig.butterReviewerId || "butter") || repaired;

  let config = repaired ? buildReviewConfig(engine) : buildReviewConfig(engine);
  const reviewerKinds: ReviewerKind[] = ["hanako", "butter"];
  const missingKinds = reviewerKinds.filter((kind) => {
    return !resolveReviewer(config.candidates, kind, config, engine.currentAgentId);
  });

  if (missingKinds.length === 0) return config;

  const nextBindings: Partial<Pick<ReviewConfig, "hanakoReviewerId" | "butterReviewerId">> = {};
  for (const kind of missingKinds) {
    try {
      const created = await engine.createAgent({
        name: kind === "butter" ? "Butter Reviewer" : "Hanako Reviewer",
        yuan: kind,
      });
      if (created?.id) {
        ensureReviewerAgentShape(engine, kind, created.id);
        nextBindings[kind === "butter" ? "butterReviewerId" : "hanakoReviewerId"] = created.id;
      }
    } catch (err) {
      console.warn("[review] failed to create reviewer agent:", errorMessage(err));
    }
  }

  config = Object.keys(nextBindings).length > 0
    ? saveReviewConfig(engine, nextBindings)
    : buildReviewConfig(engine);

  return config;
}

function saveReviewConfig(engine: ReviewRouteEngine, partial: Partial<ReviewConfig> = {}): BuiltReviewConfig {
  const prefs = engine.getPreferences?.() || {};
  const current = normalizeReviewConfig(prefs);
  const next = {
    defaultReviewer: partial.defaultReviewer === undefined ? current.defaultReviewer : normalizeReviewerKind(partial.defaultReviewer),
    hanakoReviewerId: partial.hanakoReviewerId === undefined ? current.hanakoReviewerId : normalizeReviewerId(partial.hanakoReviewerId),
    butterReviewerId: partial.butterReviewerId === undefined ? current.butterReviewerId : normalizeReviewerId(partial.butterReviewerId),
  };

  prefs.review = next;
  engine.savePreferences?.(prefs);
  return buildReviewConfig(engine);
}

function reviewerMissingMessage(kind: ReviewerKind): string {
  if (isZh()) {
    return kind === "butter"
      ? "还没有可用的 Butter 审查人。请先在设置 > 工作 中创建或绑定 Butter reviewer。"
      : "还没有可用的 Hanako 审查人。请先在设置 > 工作 中创建或绑定 Hanako reviewer。";
  }

  return kind === "butter"
    ? "No Butter reviewer is available yet. Create or assign one in Settings > Work first."
    : "No Hanako reviewer is available yet. Create or assign one in Settings > Work first.";
}

function validateReviewerSelection(candidates: ReviewCandidate[], reviewerId: string | null | undefined, yuan: ReviewerKind): boolean {
  if (!reviewerId) return true;
  return candidates.some((candidate) => candidate.id === reviewerId && candidate.yuan === yuan && !candidate.isCurrent);
}

function createReviewProgressEmitter({ broadcast, reviewId, sessionPath, reviewer }: ReviewProgressEmitterArgs) {
  return (stage: unknown, extra: JsonRecord = {}) => {
    const safeStage: ReviewProgressStage = typeof stage === "string" && (REVIEW_PROGRESS_STAGES as string[]).includes(stage)
      ? stage as ReviewProgressStage
      : "reviewing";
    broadcast({
      type: "review_progress",
      reviewId,
      sessionPath,
      stage: safeStage,
      reviewerName: reviewerDisplayName(reviewer.yuan),
      reviewerAgent: reviewer.id,
      reviewerAgentName: reviewer.name,
      reviewerYuan: reviewer.yuan,
      reviewerHasAvatar: reviewer.hasAvatar,
      ...extra,
    });
  };
}

function cleanPreviewText(value: unknown, maxChars = MAX_CONTEXT_PREVIEW_CHARS): string {
  if (typeof value !== "string") return "";
  const compact = value.replace(/\r\n?/g, "\n").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars).trim()}\n…`;
}

function summarizeToolUseBlocks(content: unknown): Array<{ name: string; argsPreview: string }> {
  if (!Array.isArray(content)) return [];
  const toolUses: Array<{ name: string; argsPreview: string }> = [];
  for (const block of content) {
    const record = asRecord(block) as ToolUseBlock | null;
    if (!record || (record.type !== "tool_use" && record.type !== "toolCall")) continue;
    const rawArgs = record.input || record.arguments;
    let argsPreview = "";
    if (rawArgs && typeof rawArgs === "object") {
      const entries = Object.entries(rawArgs)
        .filter(([, value]) => value !== undefined && value !== null && value !== "")
        .slice(0, 3)
        .map(([key, value]) => {
          const rendered = typeof value === "string" ? value : JSON.stringify(value);
          return `${key}=${String(rendered).slice(0, 80)}`;
        });
      argsPreview = entries.join(", ");
    }
    toolUses.push({
      name: typeof record.name === "string" ? record.name : "unknown_tool",
      argsPreview,
    });
    if (toolUses.length >= MAX_TOOL_ITEMS) break;
  }
  return toolUses;
}

function buildSessionContextPack(sessionPath: string | null | undefined): SessionContextPack | null {
  if (!sessionPath || !fs.existsSync(sessionPath)) return null;
  try {
    const raw = fs.readFileSync(sessionPath, "utf-8");
    const lines = raw.split("\n").filter(Boolean).slice(-MAX_SESSION_LINES);
    const entries: Array<{ role: string; text: string }> = [];
    let assistantText = "";
    let userText = "";
    let toolUses: Array<{ name: string; argsPreview: string }> = [];

    for (const line of lines) {
      if (entries.length >= MAX_SESSION_LINES) break;
      let parsed: SessionMessageRecord;
      try {
        parsed = JSON.parse(line) as SessionMessageRecord;
      } catch {
        continue;
      }
      if (parsed.type !== "message" || !parsed.message) continue;
      const msg = parsed.message;
      const role = typeof msg.role === "string" ? msg.role : "unknown";
      const content = Array.isArray(msg.content) ? msg.content : [];
      const text = content
        .filter((block): block is SessionMessageBlock & { text: string } => {
          const record = asRecord(block) as SessionMessageBlock | null;
          return record?.type === "text" && typeof record.text === "string";
        })
        .map((block) => block.text)
        .join("\n")
        .trim();
      if (role === "user" && text) userText = cleanPreviewText(text, 1200);
      if (role === "assistant" && text) assistantText = cleanPreviewText(text, 1800);
      if (role === "assistant") {
        const summarizedTools = summarizeToolUseBlocks(content);
        if (summarizedTools.length) toolUses = summarizedTools;
      }
      entries.push({ role, text: cleanPreviewText(text, 600) });
    }

    return {
      userText,
      assistantText,
      toolUses,
      recentMessages: entries.slice(-8),
    };
  } catch {
    return null;
  }
}

function buildReviewContextPack(context: string, engine: ReviewRouteEngine, sessionPathOverride: string | null = null): ReviewContextPack {
  const sessionPath = sessionPathOverride || engine.currentSessionPath || null;
  const gitContext = sessionPath
    ? {
        sessionPath,
        sessionFile: path.basename(sessionPath),
      }
    : null;

  const sessionContext = buildSessionContextPack(sessionPath);
  const workspacePath = engine.deskCwd || engine.homeCwd || null;

  return {
    request: cleanPreviewText(context, MAX_CONTEXT_PREVIEW_CHARS),
    gitContext,
    sessionContext,
    ...(workspacePath ? { workspacePath } : {}),
  };
}

export async function startReviewRun(
  engine: ReviewRouteEngine,
  { broadcast = () => undefined }: Pick<CreateReviewRouteOptions, "broadcast"> = {},
  request: StartReviewRunRequest,
): Promise<StartReviewRunResult> {
  const context = typeof request.context === "string" ? request.context : "";
  if (!context.trim()) {
    const err: CodedError = new Error("missing context");
    err.code = "missing_context";
    throw err;
  }

  const reviewConfig = await ensureDefaultReviewerAgents(engine);
  const reviewerKind = request.reviewerKind === "butter"
    ? "butter"
    : (request.autoReview ? "hanako" : reviewConfig.defaultReviewer);
  const reviewer = resolveReviewer(reviewConfig.candidates, reviewerKind, reviewConfig, engine.currentAgentId);

  if (!reviewer) {
    const err: CodedError = new Error(reviewerMissingMessage(reviewerKind));
    err.code = "reviewer_not_configured";
    throw err;
  }

  try {
    const loadedReviewer = typeof engine.ensureAgentLoaded === "function"
      ? await engine.ensureAgentLoaded(reviewer.id)
      : engine.getAgent?.(reviewer.id);
    if (!loadedReviewer) {
      const err: CodedError = new Error(isZh()
        ? `复查人 agent "${reviewer.id}" 不存在或未初始化`
        : `Reviewer agent "${reviewer.id}" does not exist or is not initialized`);
      err.code = "reviewer_agent_missing";
      throw err;
    }
  } catch (err) {
    const wrapped: CodedError = new Error(errorMessage(err, isZh() ? "复查人初始化失败" : "Reviewer initialization failed"));
    wrapped.code = errorCode(err) || "reviewer_agent_init_failed";
    throw wrapped;
  }

  const reviewerRuntime = engine.getAgent?.(reviewer.id);
  const reviewerConfiguredModel = reviewerRuntime ? getAgentModel(reviewerRuntime) : null;
  const reviewerConfiguredAvailable = reviewerConfiguredModel?.modelId
    ? getAvailableModel(engine, reviewerConfiguredModel.modelId, reviewerConfiguredModel.modelProvider)
    : null;
  const reviewerName = reviewerDisplayName(reviewer.yuan);
  const reviewerModelLabel = reviewModelDisplayLabel(
    reviewer,
    reviewerConfiguredAvailable?.id || reviewerConfiguredModel?.modelId || null,
    reviewerConfiguredAvailable?.provider || reviewerConfiguredModel?.modelProvider || null,
    AUTO_REVIEW_MODEL_LABEL,
  );
  const reviewerModelId = reviewerConfiguredAvailable?.id || reviewerConfiguredModel?.modelId || null;
  const reviewerModelProvider = reviewerConfiguredAvailable?.provider || reviewerConfiguredModel?.modelProvider || null;
  const sessionPath = typeof request.sessionPath === "string" && request.sessionPath.trim()
    ? request.sessionPath
    : (engine.currentSessionPath || null);
  const reviewId = request.reviewId || `review-${Date.now()}`;
  const autoReview = !!request.autoReview;
  const reviewMode = request.reviewMode || (autoReview ? "background" : null);
  const triggerReasons = Array.isArray(request.triggerReasons)
    ? request.triggerReasons.filter((reason): reason is string => typeof reason === "string" && !!reason.trim()).slice(0, 6)
    : [];
  const emitProgress = createReviewProgressEmitter({ broadcast, reviewId, sessionPath, reviewer });

  broadcast({
    type: "review_start",
    reviewId,
    sessionPath,
    reviewerName,
    reviewerAgent: reviewer.id,
    reviewerAgentName: reviewer.name,
    reviewerYuan: reviewer.yuan,
    reviewerHasAvatar: reviewer.hasAvatar,
    reviewerModelLabel,
    reviewerModelId,
    reviewerModelProvider,
    autoReview,
    reviewMode,
    triggerReasons,
  });

  enqueueReviewerExecution(reviewer.id, async () => {
    try {
      emitProgress("packing_context", { autoReview, reviewMode, triggerReasons, reviewerModelLabel, reviewerModelId, reviewerModelProvider });
      const contextPack = buildReviewContextPack(context, engine, sessionPath);
      const prompt = formatContextPack(contextPack);

      emitProgress("reviewing", { autoReview, reviewMode, triggerReasons, reviewerModelLabel, reviewerModelId, reviewerModelProvider });
      const reviewRun = autoReview
        ? await runDirectReviewerSessionWithFallback(
            engine,
            reviewer,
            prompt,
            {
              fallbackTimeoutMs: AUTO_REVIEW_FALLBACK_TIMEOUT_MS,
              autoReview,
              reviewMode,
              signal: AbortSignal.timeout(AUTO_REVIEW_CHAIN_TIMEOUT_MS),
            },
          )
        : await runReviewerSessionWithFallback(
            engine,
            reviewer,
            [{ text: prompt, capture: true }],
            {
              engine,
              signal: AbortSignal.timeout(REVIEW_EXEC_TIMEOUT_MS),
              sessionSuffix: "review",
              systemAppend: buildReviewSystemAppend({ autoReview, reviewMode }),
              maxTokens: undefined,
              thinkingLevel: "off",
              captureSettleTimeoutMs: 9_000,
              readOnly: true,
              keepSession: false,
            },
            {
              fallbackTimeoutMs: REVIEW_FALLBACK_TIMEOUT_MS,
              autoReview,
            },
          );

      emitProgress("structuring", { autoReview, reviewMode, triggerReasons, reviewerModelLabel, reviewerModelId, reviewerModelProvider });
      const cleanedContent = stripThinkTags(reviewRun.content || "");
      const structured = parseStructuredReview(cleanedContent);
      const followUpPrompt = structured ? buildReviewFollowUp(structured) : null;

      emitProgress("done", {
        verdict: structured?.verdict || null,
        findingsCount: structured?.findings?.length || 0,
        workflowGate: structured?.workflowGate || "clear",
        autoReview,
        reviewMode,
        triggerReasons,
        reviewerModelLabel,
        reviewerModelId,
        reviewerModelProvider,
      });

      broadcast({
        type: "review_result",
        reviewId,
        sessionPath,
        reviewerName,
        reviewerAgent: reviewer.id,
        reviewerAgentName: reviewer.name,
        reviewerYuan: reviewer.yuan,
        reviewerHasAvatar: reviewer.hasAvatar,
        reviewerModelLabel: reviewRun.usedModelLabel || AUTO_REVIEW_MODEL_LABEL,
        reviewerModelId: reviewRun.usedModelId || null,
        reviewerModelProvider: reviewRun.usedModelProvider || null,
        content: cleanedContent,
        structured,
        contextPack,
        followUpPrompt,
        fallbackNote: reviewRun.fallbackNote || null,
        errorCode: reviewRun.errorCode || null,
        autoReview,
        reviewMode,
        triggerReasons,
        sourceResponse: request.sourceResponse || null,
      });
    } catch (err) {
      emitProgress("done", {
        error: errorMessage(err, "Review failed"),
        workflowGate: "follow_up",
        errorCode: errorCode(err),
        autoReview,
        reviewMode,
        triggerReasons,
        reviewerModelLabel,
        reviewerModelId,
        reviewerModelProvider,
      });
      broadcast({
        type: "review_result",
        reviewId,
        sessionPath,
        reviewerName,
        reviewerAgent: reviewer.id,
        reviewerAgentName: reviewer.name,
        reviewerYuan: reviewer.yuan,
        reviewerHasAvatar: reviewer.hasAvatar,
        reviewerModelLabel: null,
        reviewerModelId: null,
        reviewerModelProvider: null,
        content: "",
        error: formatReviewFailureMessage(err),
        errorCode: errorCode(err),
        autoReview,
        reviewMode,
        triggerReasons,
        sourceResponse: request.sourceResponse || null,
      });
    }
  });

  return {
    reviewId,
    sessionPath,
    reviewerName,
    reviewerAgent: reviewer.id,
    reviewerAgentName: reviewer.name,
    reviewerYuan: reviewer.yuan,
    reviewerHasAvatar: reviewer.hasAvatar,
  };
}

function formatContextPack(contextPack: ReviewContextPack): string {
  const lines = [];
  if (isZh()) {
    lines.push("[用户要求复查的内容]");
    lines.push(contextPack.request || "（空）");
    if (contextPack.gitContext?.sessionFile) {
      lines.push("");
      lines.push("[当前会话]");
      lines.push(`session=${contextPack.gitContext.sessionFile}`);
    }
    if (contextPack.workspacePath) {
      lines.push("");
      lines.push("[当前工作目录]");
      lines.push(contextPack.workspacePath);
    }
    if (contextPack.sessionContext?.userText) {
      lines.push("");
      lines.push("[最近一次用户请求]");
      lines.push(contextPack.sessionContext.userText);
    }
    if (contextPack.sessionContext?.assistantText) {
      lines.push("");
      lines.push("[最近一次助手结论]");
      lines.push(contextPack.sessionContext.assistantText);
    }
    if (contextPack.sessionContext?.toolUses?.length) {
      lines.push("");
      lines.push("[最近一次工具轨迹]");
      for (const tool of contextPack.sessionContext.toolUses) {
        lines.push(`- ${tool.name}${tool.argsPreview ? ` (${tool.argsPreview})` : ""}`);
      }
    }
  } else {
    lines.push("[Requested review target]");
    lines.push(contextPack.request || "(empty)");
    if (contextPack.gitContext?.sessionFile) {
      lines.push("");
      lines.push("[Current session]");
      lines.push(`session=${contextPack.gitContext.sessionFile}`);
    }
    if (contextPack.workspacePath) {
      lines.push("");
      lines.push("[Current workspace]");
      lines.push(contextPack.workspacePath);
    }
    if (contextPack.sessionContext?.userText) {
      lines.push("");
      lines.push("[Latest user request]");
      lines.push(contextPack.sessionContext.userText);
    }
    if (contextPack.sessionContext?.assistantText) {
      lines.push("");
      lines.push("[Latest assistant conclusion]");
      lines.push(contextPack.sessionContext.assistantText);
    }
    if (contextPack.sessionContext?.toolUses?.length) {
      lines.push("");
      lines.push("[Latest tool trail]");
      for (const tool of contextPack.sessionContext.toolUses) {
        lines.push(`- ${tool.name}${tool.argsPreview ? ` (${tool.argsPreview})` : ""}`);
      }
    }
  }
  return lines.join("\n").trim();
}

function normalizeFollowUpContextPack(value: unknown): FollowUpContextPackShape | null {
  const record = asRecord(value);
  if (!record) return null;
  const sessionContextRecord = asRecord(record.sessionContext);
  return {
    ...(typeof record.request === "string" ? { request: record.request } : {}),
    ...(typeof record.workspacePath === "string" ? { workspacePath: record.workspacePath } : {}),
    ...(sessionContextRecord ? {
      sessionContext: {
        ...(typeof sessionContextRecord.userText === "string" ? { userText: sessionContextRecord.userText } : {}),
        ...(typeof sessionContextRecord.assistantText === "string" ? { assistantText: sessionContextRecord.assistantText } : {}),
      },
    } : {}),
  };
}

export function createReviewRoute(
  engine: ReviewRouteEngine,
  { broadcast = () => undefined, taskRuntime = null }: CreateReviewRouteOptions = {},
) {
  const route = new Hono();

  route.post("/review/follow-up-task", async (c) => {
    if (!taskRuntime) {
      return c.json({ error: isZh() ? "任务运行器不可用" : "Task runtime unavailable" }, 503);
    }

    const body = (asRecord(await c.req.json().catch(() => ({}))) || {}) as ReviewFollowUpBody;
    const structuredReview = asStructuredReview(body.structuredReview);
    const findings = Array.isArray(structuredReview?.findings) ? structuredReview.findings : [];
    if (!structuredReview || findings.length === 0) {
      return c.json({ error: isZh() ? "缺少可执行的 review 发现项" : "Missing executable review findings" }, 400);
    }

    const sessionPath = typeof body.sessionPath === "string" && body.sessionPath.trim()
      ? body.sessionPath.trim()
      : (engine.currentSessionPath || null);
    const followUpPrompt = typeof body.followUpPrompt === "string" ? body.followUpPrompt : null;
    const contextPack = normalizeFollowUpContextPack(body.contextPack);
    const reviewerName = typeof body.reviewerName === "string" ? body.reviewerName : null;
    const sourceResponse = typeof body.sourceResponse === "string" ? body.sourceResponse : null;
    const executionResolution = typeof body.executionResolution === "string" ? body.executionResolution : null;
    const title = buildReviewFollowUpTaskTitle(structuredReview, { zh: isZh() });
    const prompt = buildReviewFollowUpTaskPrompt({
      structuredReview,
      contextPack,
      followUpPrompt: followUpPrompt ?? undefined,
      reviewerName: reviewerName ?? undefined,
      sourceResponse: sourceResponse ?? undefined,
      executionResolution: executionResolution ?? undefined,
    }, { zh: isZh() });

    const task = taskRuntime.createReviewFollowUpTask({
      reviewId: typeof body.reviewId === "string" ? body.reviewId : null,
      title,
      prompt,
      structuredReview,
      contextPack,
      followUpPrompt,
      reviewerName,
      sourceResponse,
      executionResolution,
      sessionPath,
    });

    return c.json({ ok: true, task });
  });

  route.get("/review/config", async (c) => {
    const config = await ensureDefaultReviewerAgents(engine);
    return c.json(config);
  });

  route.put("/review/config", async (c) => {
    await ensureDefaultReviewerAgents(engine);
    const body = (asRecord(await c.req.json().catch(() => ({}))) || {}) as ReviewConfigBody;
    const candidates = listReviewCandidates(engine);
    const defaultReviewer = body.defaultReviewer === undefined
      ? undefined
      : normalizeReviewerKind(body.defaultReviewer);
    const hanakoReviewerId = body.hanakoReviewerId === undefined
      ? undefined
      : normalizeReviewerId(body.hanakoReviewerId);
    const butterReviewerId = body.butterReviewerId === undefined
      ? undefined
      : normalizeReviewerId(body.butterReviewerId);

    if (!validateReviewerSelection(candidates, hanakoReviewerId, "hanako")) {
      return c.json({ error: isZh() ? "所选 Hanako 审查人无效" : "Selected Hanako reviewer is invalid" }, 400);
    }

    if (!validateReviewerSelection(candidates, butterReviewerId, "butter")) {
      return c.json({ error: isZh() ? "所选 Butter 审查人无效" : "Selected Butter reviewer is invalid" }, 400);
    }

    const config = saveReviewConfig(engine, {
      ...(defaultReviewer !== undefined ? { defaultReviewer } : {}),
      ...(hanakoReviewerId !== undefined ? { hanakoReviewerId } : {}),
      ...(butterReviewerId !== undefined ? { butterReviewerId } : {}),
    });

    return c.json(config);
  });

  route.post("/review", async (c) => {
    const body = (asRecord(await c.req.json().catch(() => ({}))) || {}) as ReviewRequestBody;
    const { context } = body;

    if (!context || typeof context !== "string") {
      return c.json({ error: "missing context" }, 400);
    }

    try {
      const result = await startReviewRun(engine, { broadcast }, {
        context,
        reviewerKind: body.reviewerKind,
        reviewId: typeof body.reviewId === "string" ? body.reviewId : null,
        autoReview: body.autoReview === true,
        reviewMode: typeof body.reviewMode === "string" ? body.reviewMode : null,
        triggerReasons: Array.isArray(body.triggerReasons)
          ? body.triggerReasons.filter((reason): reason is string => typeof reason === "string")
          : [],
        sourceResponse: typeof body.sourceResponse === "string" ? body.sourceResponse : null,
      });

      return c.json(result);
    } catch (err) {
      const code = errorCode(err);
      const status = code === "reviewer_not_configured" || code === "missing_context" ? 400 : 500;
      return c.json({
        error: errorMessage(err, isZh() ? "复查启动失败" : "Failed to start review"),
        code,
      }, status);
    }
  });

  route.get("/review/agents", async (c) => {
    const config = await ensureDefaultReviewerAgents(engine);
    const reviewers = [...config.candidates.hanako, ...config.candidates.butter];
    return c.json({ reviewers, config });
  });

  return route;
}
