/** Review route layer. Extracted without changing policy or routing. */
import { Hono } from "hono";
import { buildReviewFollowUp, parseStructuredReview } from "../review-result.js";
import { buildReviewFollowUpTaskPrompt, buildReviewFollowUpTaskTitle } from "../review-follow-up.js";
import { type ReviewerKind, type ReviewProgressStage, type JsonRecord, type AgentListItem, type ReviewConfig, type ReviewCandidate, type GroupedReviewCandidates, type BuiltReviewConfig, type ReviewRouteEngine, type CreateReviewRouteOptions, type StartReviewRunRequest, type StartReviewRunResult, type CodedError, type StructuredReviewLike, type ReviewSecondOpinion, type ReviewerShapePatch, type ReviewFollowUpBody, type ReviewConfigBody, type ReviewRequestBody, type ReviewProgressEmitterArgs } from './review/types.js';
import { REVIEWER_YUANS, BUILT_IN_REVIEWER_IDS, REVIEW_PROGRESS_STAGES, REVIEW_EXEC_TIMEOUT_MS, REVIEW_FALLBACK_TIMEOUT_MS, AUTO_REVIEW_FALLBACK_TIMEOUT_MS, AUTO_REVIEW_CHAIN_TIMEOUT_MS, AUTO_REVIEW_MODEL_LABEL, MIMO_SECOND_OPINION_LABEL, asRecord, asStructuredReview, errorMessage, errorCode, stripThinkTags, isZh, buildReviewSystemAppend, normalizeReviewerKind, normalizeReviewerId, reviewerDisplayName, normalizeReviewConfig, getAgentModel, shouldEscalateToMimo, mergeReviewWithSecondOpinion, formatReviewFailureMessage, formatContextPack, normalizeFollowUpContextPack } from './review/policy.js';
import { buildReviewContextPack } from './review/context.js';
import { enqueueReviewerExecution, getAvailableModel, reviewModelDisplayLabel, runMimoSecondOpinion, runDirectReviewerSessionWithFallback, runReviewerSessionWithFallback } from './review/execution.js';
export type { ReviewerKind, StartReviewRunRequest, StartReviewRunResult } from './review/types.js';

export function ensureReviewerAgentShape(engine: ReviewRouteEngine, kind: ReviewerKind, reviewerId: unknown): boolean {
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

export function listReviewCandidates(engine: ReviewRouteEngine): ReviewCandidate[] {
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

export function groupCandidatesByYuan(candidates: ReviewCandidate[]): GroupedReviewCandidates {
  return {
    hanako: candidates.filter((candidate) => candidate.yuan === "hanako"),
    butter: candidates.filter((candidate) => candidate.yuan === "butter"),
  };
}

export function resolveReviewer(
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

export async function ensureDefaultReviewerAgents(engine: ReviewRouteEngine): Promise<BuiltReviewConfig> {
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

export function saveReviewConfig(engine: ReviewRouteEngine, partial: Partial<ReviewConfig> = {}): BuiltReviewConfig {
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

export function reviewerMissingMessage(kind: ReviewerKind): string {
  if (isZh()) {
    return kind === "butter"
      ? "还没有可用的 Butter 审查人。请先在设置 > 工作 中创建或绑定 Butter reviewer。"
      : "还没有可用的 Hanako 审查人。请先在设置 > 工作 中创建或绑定 Hanako reviewer。";
  }

  return kind === "butter"
    ? "No Butter reviewer is available yet. Create or assign one in Settings > Work first."
    : "No Hanako reviewer is available yet. Create or assign one in Settings > Work first.";
}

export function validateReviewerSelection(candidates: ReviewCandidate[], reviewerId: string | null | undefined, yuan: ReviewerKind): boolean {
  if (!reviewerId) return true;
  return candidates.some((candidate) => candidate.id === reviewerId && candidate.yuan === yuan && !candidate.isCurrent);
}

export function createReviewProgressEmitter({ broadcast, reviewId, sessionPath, reviewer }: ReviewProgressEmitterArgs) {
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
      let structured = parseStructuredReview(cleanedContent) as StructuredReviewLike | null;
      let secondOpinion: ReviewSecondOpinion | null = null;
      let finalReviewerModelLabel = reviewRun.usedModelLabel || AUTO_REVIEW_MODEL_LABEL;
      if (shouldEscalateToMimo(structured, {
        autoReview,
        reviewMode,
        triggerReasons,
        errorCode: reviewRun.errorCode,
      })) {
        const pendingSecondOpinion: ReviewSecondOpinion = {
          status: "pending",
          modelLabel: MIMO_SECOND_OPINION_LABEL,
          reason: "MiMo 正在核对 GLM-5.3-Flash 的复查结论。",
        };
        const preliminaryStructured: StructuredReviewLike = {
          ...structured!,
          secondOpinion: pendingSecondOpinion,
        };
        const preliminaryFollowUpPrompt = buildReviewFollowUp(
          preliminaryStructured as Parameters<typeof buildReviewFollowUp>[0],
        );
        emitProgress("arbitrating", {
          verdict: preliminaryStructured.verdict || null,
          findingsCount: preliminaryStructured.findings?.length || 0,
          workflowGate: preliminaryStructured.workflowGate || "clear",
          autoReview,
          reviewMode,
          triggerReasons,
          reviewerModelLabel: finalReviewerModelLabel,
          reviewerModelId: reviewRun.usedModelId || reviewerModelId,
          reviewerModelProvider: reviewRun.usedModelProvider || reviewerModelProvider,
          secondOpinion: pendingSecondOpinion,
        });
        // The GLM-5.3-Flash result is already useful. Show it immediately and update this
        // same card when the bounded MiMo arbitration comes back.
        broadcast({
          type: "review_result",
          reviewId,
          sessionPath,
          reviewerName,
          reviewerAgent: reviewer.id,
          reviewerAgentName: reviewer.name,
          reviewerYuan: reviewer.yuan,
          reviewerHasAvatar: reviewer.hasAvatar,
          reviewerModelLabel: finalReviewerModelLabel,
          reviewerModelId: reviewRun.usedModelId || null,
          reviewerModelProvider: reviewRun.usedModelProvider || null,
          content: cleanedContent,
          structured: preliminaryStructured,
          secondOpinion: pendingSecondOpinion,
          contextPack,
          followUpPrompt: preliminaryFollowUpPrompt,
          fallbackNote: reviewRun.fallbackNote || null,
          errorCode: reviewRun.errorCode || null,
          autoReview,
          reviewMode,
          triggerReasons,
          sourceResponse: request.sourceResponse || null,
        });
        const arbitration = await runMimoSecondOpinion(
          engine,
          reviewer,
          prompt,
          cleanedContent,
          structured!,
          String(request.sourceResponse || ""),
          triggerReasons,
        );
        secondOpinion = arbitration.metadata;
        structured = arbitration.structured
          ? mergeReviewWithSecondOpinion(structured!, arbitration.structured, arbitration.metadata)
          : { ...structured!, secondOpinion: arbitration.metadata };
        if (arbitration.metadata.status === "completed") {
          finalReviewerModelLabel = `${finalReviewerModelLabel} + ${MIMO_SECOND_OPINION_LABEL}`;
        }
      }
      const followUpPrompt = structured
        ? buildReviewFollowUp(structured as Parameters<typeof buildReviewFollowUp>[0])
        : null;

      emitProgress("done", {
        verdict: structured?.verdict || null,
        findingsCount: structured?.findings?.length || 0,
        workflowGate: structured?.workflowGate || "clear",
        autoReview,
        reviewMode,
        triggerReasons,
        reviewerModelLabel: finalReviewerModelLabel,
        reviewerModelId: reviewRun.usedModelId || reviewerModelId,
        reviewerModelProvider: reviewRun.usedModelProvider || reviewerModelProvider,
        secondOpinion,
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
        reviewerModelLabel: finalReviewerModelLabel,
        reviewerModelId: reviewRun.usedModelId || null,
        reviewerModelProvider: reviewRun.usedModelProvider || null,
        content: cleanedContent,
        structured,
        secondOpinion,
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
