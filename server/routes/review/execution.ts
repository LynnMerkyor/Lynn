/** Review execution layer. Extracted without changing policy or routing. */
import crypto from "node:crypto";
import path from "path";
import { runAgentSession, type AgentSessionRound, type RunAgentSessionOptions } from "../../../hub/agent-executor.js";
import { callText } from "../../../shared/llm-client.js";
import type { LLMApi, ModelId, ProviderId } from "../../../core/types.js";
import { parseStructuredReview } from "../../review-result.js";
import { getRoleDefaultModelRefs, getUserFacingModelAlias, getUserFacingRoleModelLabel } from "../../../shared/assistant-role-models.js";
import { type ModelLike, type ReviewCandidate, type ReviewRouteEngine, type ReviewRunResult, type DirectReviewModelConfig, type StructuredReviewLike, type ReviewSecondOpinion } from './types.js';
import { REVIEW_EXEC_TIMEOUT_MS, REVIEW_FALLBACK_TIMEOUT_MS, AUTO_REVIEW_EXEC_TIMEOUT_MS, AUTO_REVIEW_BRAIN_TIMEOUT_MS, AUTO_REVIEW_MAX_OUTPUT_TOKENS, AUTO_REVIEW_MODEL_LABEL, MIMO_SECOND_OPINION_LABEL, MIMO_SECOND_OPINION_MODEL, MIMO_SECOND_OPINION_TIMEOUT_MS, MIMO_SECOND_OPINION_MAX_TOKENS, MIMO_SECOND_OPINION_PROVIDERS, MIMO_SECOND_OPINION_CACHE_TTL_MS, MIMO_SECOND_OPINION_BREAKER_MS, MIMO_SECOND_OPINION_FAILURE_LIMIT, AUTO_REVIEW_FALLBACK_PROVIDERS, AUTO_REVIEW_DEEPSEEK_PROVIDERS, AUTO_REVIEW_GLM_PROVIDERS, AUTO_REVIEW_BRAIN_PROVIDERS, AUTO_REVIEW_GLM_MAX_CONCURRENCY, errorCode, stripThinkTags, isZh, buildReviewSystemAppend, getAgentModel, isTimeoutLikeError, isRetryableReviewError, hasMeaningfulReviewOutput, buildDeterministicReviewFallbackContent, createReviewNoOutputError, normalizeProviderId, normalizeModelId, formatReviewFailureMessage } from './policy.js';


export const reviewExecutionQueues = new Map<string, Promise<void>>();


export let activeAutoReviewGlmCalls = 0;


export const autoReviewGlmWaiters: Array<() => void> = [];

export const mimoSecondOpinionCache = new Map<string, { expiresAt: number; value: ReviewSecondOpinion; structured: StructuredReviewLike | null }>();


export let mimoSecondOpinionFailures = 0;


export let mimoSecondOpinionDisabledUntil = 0;

export function enqueueReviewerExecution(reviewerId: string, run: () => Promise<void>): void {
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

export function getAvailableModel(engine: ReviewRouteEngine, modelId: string | null | undefined, providerId: string | null = null): ModelLike | null {
  if (!modelId) return null;
  const models = Array.isArray(engine.availableModels) ? engine.availableModels : [];
  return models.find((model) => model.id === modelId && (!providerId || model.provider === providerId))
    || models.find((model) => model.id === modelId)
    || null;
}

export function reviewModelDisplayLabel(
  reviewer: Pick<ReviewCandidate, "yuan"> | { yuan?: string | null } | null | undefined,
  modelId: string | null | undefined,
  providerId: string | null | undefined,
  fallbackLabel: string | null = null,
): string | null {
  const id = normalizeModelId(modelId);
  const provider = normalizeProviderId(providerId);
  if (id === "glm-5.3-flash") return AUTO_REVIEW_MODEL_LABEL;
  if (id === "deepseek-v4-flash-vision-exp") return "Hanako · DS V4 Vision Exp";
  if (id === "deepseek-v4-flash" || id.startsWith("deepseek-v4-flash-")) return "Hanako · DS V4";
  if (id === "mimo-v2.5-pro") return "Hanako · MiMo 2.5 Pro";
  if (provider === "brain") return AUTO_REVIEW_MODEL_LABEL;
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

export function isAutoReviewFallbackAllowed(model: ModelLike | null | undefined): boolean {
  const provider = String(model?.provider || "").trim().toLowerCase();
  if (!provider || !AUTO_REVIEW_FALLBACK_PROVIDERS.has(provider)) return false;
  if (AUTO_REVIEW_DEEPSEEK_PROVIDERS.has(provider)) {
    const id = normalizeModelId(model?.id);
    return id === "deepseek-v4-flash" || id.startsWith("deepseek-v4-flash-");
  }
  return true;
}

export function isAutoReviewGlmProvider(provider: unknown): boolean {
  return AUTO_REVIEW_GLM_PROVIDERS.has(normalizeProviderId(provider));
}

export function isAutoReviewGlmConfig(config: DirectReviewModelConfig): boolean {
  if (isAutoReviewGlmProvider(config.provider)) return true;
  return normalizeProviderId(config.provider) === "brain"
    && config.requestHeaders?.["X-Lynn-Review-Arbitration"] === "glm-coding";
}

export function autoReviewCandidateTimeoutMs(config: DirectReviewModelConfig): number {
  const isBrainArbitration = normalizeProviderId(config.provider) === "brain"
    && config.requestHeaders?.["X-Lynn-Review-Arbitration"] === "glm-coding";
  return isBrainArbitration ? AUTO_REVIEW_BRAIN_TIMEOUT_MS : AUTO_REVIEW_EXEC_TIMEOUT_MS;
}

export function autoReviewProviderTier(provider: unknown): number {
  const normalized = normalizeProviderId(provider);
  if (AUTO_REVIEW_GLM_PROVIDERS.has(normalized)) return 0;
  if (AUTO_REVIEW_BRAIN_PROVIDERS.has(normalized)) return 0;
  if (AUTO_REVIEW_DEEPSEEK_PROVIDERS.has(normalized)) return 1;
  return 9;
}

export function autoReviewModelPreference(model: ModelLike | null | undefined): number {
  const provider = normalizeProviderId(model?.provider);
  const id = normalizeModelId(model?.id);
  if (AUTO_REVIEW_DEEPSEEK_PROVIDERS.has(provider)) {
    if (id === "deepseek-v4-flash-vision-exp") return 0;
    if (id === "deepseek-v4-flash") return 1;
    if (id.startsWith("deepseek-v4-flash-")) return 2;
    return 9;
  }
  if (AUTO_REVIEW_GLM_PROVIDERS.has(provider)) {
    if (id === "glm-5.3-flash") return 1;
    if (id.includes("glm-5.3") && id.includes("flash")) return 2;
    if (id === "glm-5-turbo" || id === "glm-5.0-turbo") return 4;
    if (id.includes("glm-5")) return 5;
    return 4;
  }
  if (AUTO_REVIEW_BRAIN_PROVIDERS.has(provider)) {
    return 0;
  }
  return 9;
}

export function sortAutoReviewModels(models: ModelLike[]): ModelLike[] {
  return [...models].sort((a, b) => {
    const providerTierDiff = autoReviewProviderTier(a?.provider) - autoReviewProviderTier(b?.provider);
    if (providerTierDiff !== 0) return providerTierDiff;
    const preferenceDiff = autoReviewModelPreference(a) - autoReviewModelPreference(b);
    if (preferenceDiff !== 0) return preferenceDiff;
    return `${a?.provider || ""}/${a?.id || ""}`.localeCompare(`${b?.provider || ""}/${b?.id || ""}`);
  });
}

export function buildAutoReviewFallbackCandidates(
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

  const sorted = sortAutoReviewModels(candidates);
  let keptBrainRoute = false;
  return sorted.filter((model) => {
    const provider = normalizeProviderId(model?.provider);
    if (AUTO_REVIEW_BRAIN_PROVIDERS.has(provider)) {
      if (keptBrainRoute) return false;
      keptBrainRoute = true;
      return true;
    }
    // A Brain candidate is already locked to glm-coding by request header. Do
    // not retry the same GLM family through a second credential path before DS.
    if (keptBrainRoute && AUTO_REVIEW_GLM_PROVIDERS.has(provider)) return false;
    return true;
  });
}

export function makeAbortError(): Error {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

export async function reserveAutoReviewModelSlot(
  config: DirectReviewModelConfig,
  autoReview?: boolean,
  signal?: AbortSignal,
): Promise<() => void> {
  if (!autoReview || !isAutoReviewGlmConfig(config)) return () => {};

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

export function buildReviewFallbackCandidates(
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

export async function resolveDirectReviewModelConfig(
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
    ...(normalizeProviderId(provider) === "brain"
      ? { requestHeaders: { "X-Lynn-Review-Arbitration": "glm-coding" } }
      : {}),
  };
}

export async function runDirectReviewerModel(
  engine: ReviewRouteEngine,
  reviewer: ReviewCandidate,
  config: DirectReviewModelConfig,
  prompt: string,
  options: { autoReview?: boolean; reviewMode?: string | null; timeoutMs?: number; signal?: AbortSignal; maxTokens?: number } = {},
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
      maxTokens: options.maxTokens || (options.autoReview ? AUTO_REVIEW_MAX_OUTPUT_TOKENS : 1800),
      timeoutMs,
      signal: options.signal,
      requestHeaders: config.requestHeaders || null,
      reasoning: false,
      quirks: ["enable_thinking"],
    });
  } finally {
    releaseSlot();
  }
}

export async function resolveMimoSecondOpinionConfig(
  engine: ReviewRouteEngine,
  reviewer: ReviewCandidate,
): Promise<DirectReviewModelConfig | null> {
  const directModel = (engine.availableModels || []).find((model) => (
    normalizeModelId(model?.id) === MIMO_SECOND_OPINION_MODEL
    && MIMO_SECOND_OPINION_PROVIDERS.has(normalizeProviderId(model?.provider))
  ));
  if (directModel) {
    const direct = await resolveDirectReviewModelConfig(engine, reviewer, directModel, directModel.id, directModel.provider);
    if (direct) return { ...direct, label: MIMO_SECOND_OPINION_LABEL };
  }

  const brainModel = (engine.availableModels || []).find((model) => (
    normalizeProviderId(model?.provider) === "brain"
    && normalizeModelId(model?.id) === "lynn-brain-router"
  ));
  if (!brainModel) return null;
  const brain = await resolveDirectReviewModelConfig(engine, reviewer, brainModel, brainModel.id, brainModel.provider);
  return brain ? {
    ...brain,
    label: MIMO_SECOND_OPINION_LABEL,
    requestHeaders: { "X-Lynn-Review-Arbitration": "mimo-token-plan-pro" },
  } : null;
}

export function secondOpinionCacheKey(sourceResponse: string, triggerReasons: string[]): string {
  return crypto.createHash("sha256")
    .update(sourceResponse)
    .update("\n")
    .update([...triggerReasons].sort().join(","))
    .digest("hex");
}

export function readSecondOpinionCache(key: string): { metadata: ReviewSecondOpinion; structured: StructuredReviewLike | null } | null {
  const cached = mimoSecondOpinionCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    mimoSecondOpinionCache.delete(key);
    return null;
  }
  return { metadata: cached.value, structured: cached.structured };
}

export async function raceWithAbortSignal<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) throw signal.reason || makeAbortError();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason || makeAbortError());
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export async function runMimoSecondOpinion(
  engine: ReviewRouteEngine,
  reviewer: ReviewCandidate,
  prompt: string,
  primaryContent: string,
  primary: StructuredReviewLike,
  sourceResponse: string,
  triggerReasons: string[],
): Promise<{ metadata: ReviewSecondOpinion; structured: StructuredReviewLike | null }> {
  const now = Date.now();
  if (mimoSecondOpinionDisabledUntil > now) {
    return {
      metadata: {
        status: "circuit_open",
        modelLabel: MIMO_SECOND_OPINION_LABEL,
        reason: "MiMo 仲裁熔断中，保留 GLM-5.3-Flash 结论。",
      },
      structured: null,
    };
  }

  const cacheKey = secondOpinionCacheKey(sourceResponse || prompt, triggerReasons);
  const cached = readSecondOpinionCache(cacheKey);
  if (cached) return cached;

  let config: DirectReviewModelConfig | null = null;
  try {
    config = await resolveMimoSecondOpinionConfig(engine, reviewer);
  } catch {
    return {
      metadata: {
        status: "unavailable",
        modelLabel: MIMO_SECOND_OPINION_LABEL,
        reason: "MiMo Token Plan Pro 配置读取失败，保留 GLM-5.3-Flash 结论。",
      },
      structured: null,
    };
  }
  if (!config) {
    return {
      metadata: {
        status: "unavailable",
        modelLabel: MIMO_SECOND_OPINION_LABEL,
        reason: "MiMo Token Plan Pro 当前不可用，保留 GLM-5.3-Flash 结论。",
      },
      structured: null,
    };
  }

  const arbitrationPrompt = [
    prompt.slice(0, 16_000),
    "",
    "[GLM-5.3-Flash 一审结果]",
    primaryContent.slice(0, 5_000),
    "",
    "[MiMo 异构仲裁要求]",
    "只判断一审指出的问题是否成立、是否遗漏重大风险。不要重写原回答。输出一个 JSON：summary, verdict(pass|concerns|blocker), findings[], nextStep。",
  ].join("\n");
  const startedAt = Date.now();
  try {
    const content = await runDirectReviewerModel(engine, reviewer, config, arbitrationPrompt, {
      autoReview: true,
      reviewMode: "background",
      timeoutMs: MIMO_SECOND_OPINION_TIMEOUT_MS,
      maxTokens: MIMO_SECOND_OPINION_MAX_TOKENS,
      signal: AbortSignal.timeout(MIMO_SECOND_OPINION_TIMEOUT_MS),
    });
    const structured = parseStructuredReview(stripThinkTags(content || "")) as StructuredReviewLike | null;
    if (!structured) throw createReviewNoOutputError();
    mimoSecondOpinionFailures = 0;
    const metadata: ReviewSecondOpinion = {
      status: "completed",
      modelLabel: MIMO_SECOND_OPINION_LABEL,
      verdict: structured.verdict,
      summary: structured.summary,
      agreement: structured.verdict === primary.verdict,
      latencyMs: Date.now() - startedAt,
    };
    const value = { metadata, structured };
    mimoSecondOpinionCache.set(cacheKey, {
      expiresAt: Date.now() + MIMO_SECOND_OPINION_CACHE_TTL_MS,
      value: metadata,
      structured,
    });
    return value;
  } catch (error) {
    mimoSecondOpinionFailures += 1;
    if (mimoSecondOpinionFailures >= MIMO_SECOND_OPINION_FAILURE_LIMIT) {
      mimoSecondOpinionDisabledUntil = Date.now() + MIMO_SECOND_OPINION_BREAKER_MS;
      mimoSecondOpinionFailures = 0;
    }
    return {
      metadata: {
        status: isTimeoutLikeError(error) ? "timeout" : "unavailable",
        modelLabel: MIMO_SECOND_OPINION_LABEL,
        latencyMs: Date.now() - startedAt,
        reason: isTimeoutLikeError(error)
          ? "MiMo 仲裁未在时限内完成，保留 GLM-5.3-Flash 结论。"
          : "MiMo 仲裁暂时不可用，保留 GLM-5.3-Flash 结论。",
      },
      structured: null,
    };
  }
}

export async function runDirectReviewerSessionWithFallback(
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
      if (timing.signal?.aborted) throw timing.signal.reason || makeAbortError();
      const config = await resolveDirectReviewModelConfig(engine, reviewer, candidate, candidate?.id, candidate?.provider);
      if (!config) continue;
      if (config.label) attemptedModels.push(config.label);
      try {
        const content = await raceWithAbortSignal(
          runDirectReviewerModel(engine, reviewer, config, prompt, {
            autoReview: true,
            reviewMode: timing.reviewMode,
            timeoutMs: autoReviewCandidateTimeoutMs(config),
            // The chain signal races the whole candidate loop. The per-model
            // timeout starts only when the candidate actually runs.
            signal: undefined,
          }),
          timing.signal,
        );
        if (!hasMeaningfulReviewOutput(content)) {
          throw createReviewNoOutputError();
        }
        const originalLabel = originalConfig?.label || AUTO_REVIEW_MODEL_LABEL;
        const nextLabel = config.label || AUTO_REVIEW_MODEL_LABEL;
        const switched = originalConfig && (config.model !== originalConfig.model || config.provider !== originalConfig.provider);
        const fallbackNote = switched
          ? (isZh()
              ? `Hanako 自动复查已按 GLM-5.3-Flash 优先策略切换到 ${nextLabel} 完成。`
              : `Hanako automatic review switched to ${nextLabel} according to the GLM-5.3-Flash-first policy.`)
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

export async function runReviewerSessionWithFallback(
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
