/**
 * skill-distiller.js — 从 session 摘要自动提炼 learned skill
 *
 * 目标：
 * - 只在复杂、可复用、已收尾的任务上提炼
 * - 复用 install-skill 的安全审查
 * - 产物直接写入 learned-skills/ 并由调用方决定如何启用 / reload
 */

import fs from "fs";
import path from "path";
import { callText } from "../../shared/llm-client.js";
import { getLocale } from "../../shared/i18n-runtime.js";
import { parseSkillMetadata } from "../skills/skill-metadata.js";
import { sanitizeSkillName, safetyReview } from "../tools/install-skill.js";

const DISTILL_TIMEOUT = 75_000;
const MIN_SUMMARY_LENGTH = 120;
const MIN_TURN_COUNT = 8;
const MIN_TOOL_USAGE = 3;
const MAX_PROMPT_SKILLS = 40;
const MAX_SKILL_MD_SIZE = 16_000;
const REVISION_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const MIN_FAILURES_FOR_REVISION = 2;

type JsonObject = Record<string, unknown>;

type ExistingSkill = {
  name: string;
  description?: string;
};

type SessionStats = {
  turnCount?: number;
  toolUsage?: Record<string, unknown> | null;
};

type ResolvedSkillModel = {
  model?: string | null;
  api?: string | null;
  api_key?: string | null;
  base_url?: string | null;
  allow_missing_api_key?: boolean;
  [key: string]: unknown;
};

type SkillMeta = JsonObject & {
  version?: unknown;
  usageCount?: unknown;
  successCount?: unknown;
  failureCount?: unknown;
  lastRevisedAt?: unknown;
};

type SkillUsageMap = Map<string, number>;

type FactStoreLike = {
  searchCombined: (keywords: string[], limit: number) => unknown[];
};

type ParsedSkillMetadata = {
  name: string;
  description: string;
  disableModelInvocation?: boolean;
};

type DistillDecision = {
  ok: boolean;
  matchedSignals: string[];
  reason: string;
};

type Outcome = "success" | "failure" | "neutral";

type UpdatedSkill = {
  skillName: string;
  outcome: Outcome;
  meta: SkillMeta;
};

type DistillResult =
  | { status: "skipped"; reason: unknown; matchedSignals: string[] }
  | { status: "created"; skillName: string; matchedSignals: string[]; reason: string };

type FinalizeResult =
  | { status: "skipped"; reason: "no_tracked_usage" }
  | { status: "finalized"; outcome: Outcome; updated: UpdatedSkill[]; revised: string[] };

type RevisionResult =
  | { revised: false; reason: unknown; skillName: string }
  | { revised: true; skillName: string; meta: SkillMeta };

type SkillActivationResult =
  | { tracked: false; reason: "not_learned_skill" | "meta_missing" }
  | { tracked: true; skillName: string; meta: SkillMeta };

type InstallDetails = {
  matchedSignals: string[];
  reason: string;
};

type UpdateDetails = {
  reason: string;
  version: number;
};

type SkillDistillerOptions = {
  agentDir: string;
  listExistingSkills?: () => unknown;
  resolveDistillModel?: () => ResolvedSkillModel | null | undefined;
  resolveSafetyModel?: () => ResolvedSkillModel | null | undefined;
  factStore?: FactStoreLike | null;
  onInstalled?: (skillName: string, details: InstallDetails) => Promise<void> | void;
  onUpdated?: (skillName: string, details: UpdateDetails) => Promise<void> | void;
};

type BuildPromptOptions = {
  existingSkills: ExistingSkill[];
  summaryText: string;
  sessionStats?: SessionStats | null;
};

type BuildRevisionPromptOptions = {
  skillName: string;
  skillMd: string;
  summaryText: string;
  meta: SkillMeta;
};

const COMPLETION_PATTERNS = [
  /写好了|已经写好|已完成|完成了|修好了|修复了|整理进去了|整理完成|成功|收口|落地/u,
  /\b(?:completed|finished|implemented|created|updated|fixed|wrote|shipped|wrapped up)\b/i,
];

const FAILURE_PATTERNS = [
  /失败|没成功|未完成|没做完|卡住了|中断了|报错|出错|无法完成|没有生效|没生效/u,
  /\b(?:failed|failure|broken|did not work|didn't work|not working|stuck|errored|error|regression|rollback)\b/i,
];

const STOPWORDS = new Set([
  "lynn", "hanako", "butter", "agent", "skill", "session",
  "用户", "助手", "复查", "总结", "摘要", "问题", "项目", "功能", "任务",
  "完成", "成功", "修复", "新增", "更新", "实现", "支持", "默认模型",
  "the", "and", "with", "from", "that", "this", "have", "into", "using",
  "used", "about", "for", "your", "user", "assistant", "chat",
]);

function normalizeAlias(value: unknown): string {
  return String(value || "").trim().toLowerCase().replace(/[_\s]+/g, "-");
}

function readField(value: unknown, field: string): unknown {
  return (Object(value) as JsonObject)[field];
}

function extractJsonPayload(raw: unknown): unknown | null {
  const text = String(raw || "").trim();
  if (!text) return null;
  const fenceMatch = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/);
  const candidate = (fenceMatch ? fenceMatch[1] : text).trim();
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1)) as unknown;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function extractKeywordCandidates(text: unknown): string[] {
  const matches = String(text || "").match(/[\p{Script=Han}]{2,}|[a-zA-Z][a-zA-Z0-9_.-]{2,}/gu) || [];
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const raw of matches) {
    const token = raw.trim();
    const lowered = token.toLowerCase();
    if (!token || STOPWORDS.has(lowered) || seen.has(lowered)) continue;
    seen.add(lowered);
    keywords.push(token);
    if (keywords.length >= 8) break;
  }
  return keywords;
}

function hasCompletionSignal(summaryText: string): boolean {
  return COMPLETION_PATTERNS.some((pattern) => pattern.test(summaryText));
}

function hasFailureSignal(summaryText: string): boolean {
  return FAILURE_PATTERNS.some((pattern) => pattern.test(summaryText));
}

function isObjectLike(value: unknown): value is SkillMeta {
  return Boolean(value) && typeof value === "object";
}

function parseMetadata(content: string, fallbackName: string): ParsedSkillMetadata {
  return parseSkillMetadata(content, fallbackName) as ParsedSkillMetadata;
}

function buildPrompt({ existingSkills, summaryText, sessionStats }: BuildPromptOptions): string {
  const isZh = getLocale().startsWith("zh");
  const toolUsage = Object.entries(sessionStats?.toolUsage || {})
    .map(([name, count]) => `${name}:${count}`)
    .join(", ");
  const existingList = existingSkills
    .slice(0, MAX_PROMPT_SKILLS)
    .map((skill) => `- ${skill.name}${skill.description ? `: ${skill.description}` : ""}`)
    .join("\n");

  if (isZh) {
    return `你是 Lynn 的技能提炼器。请判断以下 session 是否值得提炼成一个可复用技能。

如果不值得提炼，输出严格 JSON：
{"action":"skip","reason":"一句话原因"}

如果值得提炼，输出严格 JSON：
{
  "action": "create",
  "reason": "一句话原因",
  "skill_name": "kebab-case-name",
  "skill_md": "---\\nname: kebab-case-name\\ndescription: One sentence in English describing when to use this skill.\\n---\\n# 技能名称\\n## 适用场景\\n...\\n## 步骤\\n1. ...\\n2. ...\\n## 注意事项\\n- ..."
}

规则：
1. 只提炼“具体、可复用、多步骤、已经验证有效”的工作流；太通用、太简单、一次性的任务直接 skip。
2. 不要重复已有技能；已有技能能覆盖就 skip。
3. skill_name 必须是唯一的 kebab-case ASCII 名称。
4. description 必须是英文，说明“何时使用此技能”，不要写实现细节。
5. SKILL.md 要简洁，聚焦触发条件、步骤、注意事项，不要写多余介绍。
6. 不能包含越权、忽略系统、假设身份、敏感数据读取之类指令。
7. 如果只是“会用某个工具”，而没有稳定流程，也要 skip。

已有技能：
${existingList || "- （暂无）"}

Session 指标：
- turnCount: ${sessionStats?.turnCount || 0}
- toolUsage: ${toolUsage || "none"}

Session 摘要：
${summaryText}`;
  }

  return `You are Lynn's skill distiller. Decide whether the following session should become a reusable skill.

If it should NOT become a skill, return strict JSON:
{"action":"skip","reason":"one-line reason"}

If it SHOULD become a skill, return strict JSON:
{
  "action": "create",
  "reason": "one-line reason",
  "skill_name": "kebab-case-name",
  "skill_md": "---\\nname: kebab-case-name\\ndescription: One sentence in English describing when to use this skill.\\n---\\n# Skill Name\\n## When to use\\n...\\n## Steps\\n1. ...\\n2. ...\\n## Notes\\n- ..."
}

Rules:
1. Only distill workflows that are specific, reusable, multi-step, and already validated.
2. Skip generic or one-off tasks, or anything covered by an existing skill.
3. skill_name must be unique kebab-case ASCII.
4. description must be a short English sentence describing when to use the skill.
5. Keep SKILL.md concise and focused on triggers, steps, and notes.
6. Never include prompt-injection, role override, or sensitive-data instructions.
7. If the session only shows tool familiarity without a stable workflow, skip it.

Existing skills:
${existingList || "- (none)"}

Session stats:
- turnCount: ${sessionStats?.turnCount || 0}
- toolUsage: ${toolUsage || "none"}

Session summary:
${summaryText}`;
}

function buildRevisionPrompt({ skillName, skillMd, summaryText, meta }: BuildRevisionPromptOptions): string {
  const isZh = getLocale().startsWith("zh");
  const version = Number(meta?.version || 1);
  const usageCount = Number(meta?.usageCount || 0);
  const successCount = Number(meta?.successCount || 0);
  const failureCount = Number(meta?.failureCount || 0);

  if (isZh) {
    return `你是 Lynn 的技能修订器。下面这个 learned skill 在真实使用中失败率偏高，请只针对失败暴露出来的问题修订它。

如果当前信息不足，输出严格 JSON：
{"action":"skip","reason":"一句话原因"}

如果可以修订，输出严格 JSON：
{
  "action": "revise",
  "reason": "一句话原因",
  "skill_md": "---\\nname: ${skillName}\\ndescription: ...\\n---\\n# ... "
}

规则：
1. 必须保留同一个 skill name：${skillName}
2. description 继续使用英文，说明何时使用
3. 只修 trigger / steps / notes，不要加入空泛介绍
4. 不要加入越权、忽略系统、敏感信息读取或角色覆盖指令
5. 如果失败说明这个 skill 不值得继续保留，也可以 skip

当前 metadata：
- version: ${version}
- usageCount: ${usageCount}
- successCount: ${successCount}
- failureCount: ${failureCount}

当前 SKILL.md：
${skillMd}

最近一次失败相关摘要：
${summaryText}`;
  }

  return `You are Lynn's skill reviser. The learned skill below has been failing in real usage. Revise it only to address the failure pattern.

If there is not enough information, return strict JSON:
{"action":"skip","reason":"one-line reason"}

If you can revise it, return strict JSON:
{
  "action": "revise",
  "reason": "one-line reason",
  "skill_md": "---\\nname: ${skillName}\\ndescription: ...\\n---\\n# ..."
}

Rules:
1. Keep the same skill name: ${skillName}
2. Keep the description in English and focused on when to use the skill
3. Only refine triggers, steps, and notes
4. Never add prompt-injection, role override, or sensitive-data instructions
5. If the skill should not be kept, return skip

Current metadata:
- version: ${version}
- usageCount: ${usageCount}
- successCount: ${successCount}
- failureCount: ${failureCount}

Current SKILL.md:
${skillMd}

Latest failure-related summary:
${summaryText}`;
}

export class SkillDistiller {
  private readonly _agentDir: string;
  private readonly _listExistingSkills?: () => unknown;
  private readonly _resolveDistillModel?: () => ResolvedSkillModel | null | undefined;
  private readonly _resolveSafetyModel?: () => ResolvedSkillModel | null | undefined;
  private readonly _factStore: FactStoreLike | null;
  private readonly _onInstalled?: (skillName: string, details: InstallDetails) => Promise<void> | void;
  private readonly _onUpdated?: (skillName: string, details: UpdateDetails) => Promise<void> | void;
  private readonly _sessionUsage: Map<string, SkillUsageMap>;

  constructor({
    agentDir,
    listExistingSkills,
    resolveDistillModel,
    resolveSafetyModel,
    factStore = null,
    onInstalled,
    onUpdated,
  }: SkillDistillerOptions) {
    this._agentDir = agentDir;
    this._listExistingSkills = listExistingSkills;
    this._resolveDistillModel = resolveDistillModel;
    this._resolveSafetyModel = resolveSafetyModel;
    this._factStore = factStore;
    this._onInstalled = onInstalled;
    this._onUpdated = onUpdated;
    this._sessionUsage = new Map();
  }

  _skillDir(skillName: string): string {
    return path.join(this._agentDir, "learned-skills", skillName);
  }

  _metaPath(skillName: string): string {
    return path.join(this._skillDir(skillName), "_meta.json");
  }

  _skillMdPath(skillName: string): string {
    return path.join(this._skillDir(skillName), "SKILL.md");
  }

  _readSkillMeta(skillName: string): SkillMeta | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this._metaPath(skillName), "utf-8")) as unknown;
      return isObjectLike(raw) ? raw : null;
    } catch {
      return null;
    }
  }

  _writeSkillMeta(skillName: string, meta: SkillMeta): void {
    fs.writeFileSync(this._metaPath(skillName), JSON.stringify(meta, null, 2), "utf-8");
  }

  _resolveTrackedSkillName(skillName: unknown, skillFilePath = ""): string | null {
    const normalized = sanitizeSkillName(skillName);
    if (normalized && fs.existsSync(this._metaPath(normalized))) return normalized;
    if (skillFilePath) {
      const inferred = sanitizeSkillName(path.basename(path.dirname(skillFilePath)));
      if (inferred && fs.existsSync(this._metaPath(inferred))) return inferred;
    }
    return null;
  }

  recordSkillActivation({ skillName, skillFilePath = "", sessionPath = null }: {
    skillName: unknown;
    skillFilePath?: string;
    sessionPath?: string | null;
  }): SkillActivationResult {
    const trackedName = this._resolveTrackedSkillName(skillName, skillFilePath);
    if (!trackedName) return { tracked: false, reason: "not_learned_skill" };

    const meta = this._readSkillMeta(trackedName);
    if (!meta) return { tracked: false, reason: "meta_missing" };

    const nextMeta: SkillMeta = {
      ...meta,
      usageCount: Number(meta.usageCount || 0) + 1,
      lastUsedAt: new Date().toISOString(),
    };
    this._writeSkillMeta(trackedName, nextMeta);

    if (sessionPath) {
      const usageMap = this._sessionUsage.get(sessionPath) || new Map<string, number>();
      usageMap.set(trackedName, Number(usageMap.get(trackedName) || 0) + 1);
      this._sessionUsage.set(sessionPath, usageMap);
    }

    return { tracked: true, skillName: trackedName, meta: nextMeta };
  }

  async finalizeSession({ sessionPath, summaryText = "" }: {
    sessionPath?: string | null;
    summaryText?: unknown;
  }): Promise<FinalizeResult> {
    const usageMap = sessionPath ? this._sessionUsage.get(sessionPath) : null;
    if (!usageMap || usageMap.size === 0) {
      return { status: "skipped", reason: "no_tracked_usage" };
    }

    const summary = String(summaryText || "").trim();
    const outcome: Outcome = hasFailureSignal(summary)
      ? "failure"
      : hasCompletionSignal(summary)
        ? "success"
        : "neutral";

    const updated: UpdatedSkill[] = [];
    const revised: string[] = [];

    for (const [trackedName, count] of usageMap.entries()) {
      const meta = this._readSkillMeta(trackedName);
      if (!meta) continue;

      const nextMeta: SkillMeta = {
        ...meta,
        lastOutcome: outcome,
        lastOutcomeAt: new Date().toISOString(),
      };

      if (outcome === "success") {
        nextMeta.successCount = Number(meta.successCount || 0) + count;
      } else if (outcome === "failure") {
        nextMeta.failureCount = Number(meta.failureCount || 0) + count;
      }

      this._writeSkillMeta(trackedName, nextMeta);
      updated.push({ skillName: trackedName, outcome, meta: nextMeta });

      if (outcome === "failure") {
        const revisedResult = await this._maybeReviseSkill(trackedName, nextMeta, summary);
        if (revisedResult?.revised) revised.push(revisedResult.skillName);
      }
    }

    this._sessionUsage.delete(sessionPath as string);
    return {
      status: "finalized",
      outcome,
      updated,
      revised,
    };
  }

  _shouldReviseSkill(meta: SkillMeta): boolean {
    const successCount = Number(meta?.successCount || 0);
    const failureCount = Number(meta?.failureCount || 0);
    const usageCount = Number(meta?.usageCount || 0);
    const evaluated = successCount + failureCount;
    const failureRate = evaluated > 0 ? failureCount / evaluated : 0;
    const lastRevisedAt = meta?.lastRevisedAt ? new Date(meta.lastRevisedAt as string | number | Date).getTime() : 0;
    const cooledDown = !lastRevisedAt || (Date.now() - lastRevisedAt) >= REVISION_COOLDOWN_MS;

    return (
      failureCount >= MIN_FAILURES_FOR_REVISION
      && usageCount >= MIN_FAILURES_FOR_REVISION
      && failureRate >= 0.5
      && cooledDown
    );
  }

  async _maybeReviseSkill(skillName: string, meta: SkillMeta, summaryText: string): Promise<RevisionResult> {
    if (!this._shouldReviseSkill(meta)) {
      return { revised: false, reason: "threshold_not_met", skillName };
    }

    const skillMdPath = this._skillMdPath(skillName);
    const currentSkillMd = fs.existsSync(skillMdPath)
      ? fs.readFileSync(skillMdPath, "utf-8")
      : "";
    if (!currentSkillMd.trim()) {
      return { revised: false, reason: "skill_missing", skillName };
    }

    let resolvedModel: ResolvedSkillModel | null | undefined;
    try {
      resolvedModel = this._resolveDistillModel?.() || this._resolveSafetyModel?.();
    } catch {
      resolvedModel = null;
    }
    if (!resolvedModel?.model || !resolvedModel?.api || !resolvedModel?.base_url) {
      return { revised: false, reason: "revision_model_unavailable", skillName };
    }

    const prompt = buildRevisionPrompt({
      skillName,
      skillMd: currentSkillMd,
      summaryText,
      meta,
    });
    const raw = await callText({
      api: resolvedModel.api,
      model: resolvedModel.model,
      apiKey: resolvedModel.api_key as string | undefined,
      baseUrl: resolvedModel.base_url,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      maxTokens: 2600,
      timeoutMs: DISTILL_TIMEOUT,
    });

    const payload = extractJsonPayload(raw);
    if (!payload || readField(payload, "action") === "skip") {
      return { revised: false, reason: payload ? readField(payload, "reason") || "model_skip" : "model_skip", skillName };
    }

    const nextSkillMd = String(readField(payload, "skill_md") || "").trim();
    const parsed = parseMetadata(nextSkillMd, skillName);
    const nextSkillName = sanitizeSkillName(parsed.name || skillName);
    if (!nextSkillMd.startsWith("---") || !parsed.description || nextSkillName !== skillName) {
      return { revised: false, reason: "invalid_revision_draft", skillName };
    }
    if (nextSkillMd.length > MAX_SKILL_MD_SIZE) {
      return { revised: false, reason: "revision_too_large", skillName };
    }

    const safetyModel = this._resolveSafetyModel?.();
    const review = await safetyReview(nextSkillMd, () => ({
      utility: safetyModel?.model || "",
      api_key: safetyModel?.api_key || "",
      base_url: safetyModel?.base_url || "",
      api: safetyModel?.api || "",
      utility_allow_missing_api_key: safetyModel?.allow_missing_api_key === true,
    }));
    if (!review.safe) {
      return { revised: false, reason: `revision_safety_rejected:${review.reason || "unknown"}`, skillName };
    }

    fs.writeFileSync(skillMdPath, nextSkillMd, "utf-8");
    const nextMeta: SkillMeta = {
      ...meta,
      version: Number(meta.version || 1) + 1,
      lastRevisedAt: new Date().toISOString(),
      lastRevisionReason: String(readField(payload, "reason") || "").trim(),
      revisionCount: Number(meta.revisionCount || 0) + 1,
    };
    this._writeSkillMeta(skillName, nextMeta);
    await this._onUpdated?.(skillName, {
      reason: String(readField(payload, "reason") || "").trim(),
      version: Number(nextMeta.version),
    });
    return { revised: true, skillName, meta: nextMeta };
  }

  _hasRepeatedPattern(summaryText: string): boolean {
    if (!this._factStore) return false;
    const keywords = extractKeywordCandidates(summaryText);
    if (keywords.length < 2) return false;
    try {
      return this._factStore.searchCombined(keywords.slice(0, 6), 3).length >= 2;
    } catch {
      return false;
    }
  }

  shouldDistill({ summaryText, sessionStats }: {
    summaryText?: unknown;
    sessionStats?: SessionStats | null;
  }): DistillDecision {
    const normalizedSummary = String(summaryText || "").trim();
    if (normalizedSummary.length < MIN_SUMMARY_LENGTH) {
      return { ok: false, matchedSignals: [], reason: "summary_too_short" };
    }

    const stats = sessionStats || {};
    const toolUsageCount = Object.values(stats.toolUsage || {}).reduce<number>((sum, count) => sum + Number(count || 0), 0);
    const matchedSignals: string[] = [];

    if ((stats.turnCount || 0) >= MIN_TURN_COUNT) matchedSignals.push("turn_count");
    if (toolUsageCount >= MIN_TOOL_USAGE) matchedSignals.push("tool_usage");
    if (hasCompletionSignal(normalizedSummary)) matchedSignals.push("completion_signal");
    if (this._hasRepeatedPattern(normalizedSummary)) matchedSignals.push("repeated_pattern");

    return {
      ok: matchedSignals.length >= 2,
      matchedSignals,
      reason: matchedSignals.length >= 2 ? "qualified" : "not_enough_signals",
    };
  }

  async distillFromSession({ summaryText, sessionStats }: {
    summaryText?: unknown;
    sessionStats?: SessionStats | null;
  }): Promise<DistillResult> {
    const summary = String(summaryText || "").trim();
    const decision = this.shouldDistill({ summaryText: summary, sessionStats });
    if (!decision.ok) {
      return { status: "skipped", reason: decision.reason, matchedSignals: decision.matchedSignals };
    }

    let resolvedModel: ResolvedSkillModel | null | undefined;
    try {
      resolvedModel = this._resolveDistillModel?.();
    } catch {
      resolvedModel = null;
    }
    if (!resolvedModel?.model || !resolvedModel?.api || !resolvedModel?.base_url) {
      return { status: "skipped", reason: "distill_model_unavailable", matchedSignals: decision.matchedSignals };
    }

    const existingSkills = (Array.isArray(this._listExistingSkills?.()) ? this._listExistingSkills?.() : []) as ExistingSkill[];
    const prompt = buildPrompt({ existingSkills, summaryText: summary, sessionStats });
    const raw = await callText({
      api: resolvedModel.api,
      model: resolvedModel.model,
      apiKey: resolvedModel.api_key as string | undefined,
      baseUrl: resolvedModel.base_url,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      maxTokens: 2400,
      timeoutMs: DISTILL_TIMEOUT,
    });

    const payload = extractJsonPayload(raw);
    if (!payload || readField(payload, "action") === "skip") {
      return {
        status: "skipped",
        reason: payload ? readField(payload, "reason") || "model_skip" : "model_skip",
        matchedSignals: decision.matchedSignals,
      };
    }

    const skillMd = String(readField(payload, "skill_md") || "").trim();
    const parsed = parseMetadata(skillMd, String(readField(payload, "skill_name") || "").trim());
    const skillName = sanitizeSkillName(parsed.name || readField(payload, "skill_name"));
    if (!skillName || !parsed.description || !skillMd.startsWith("---")) {
      return { status: "skipped", reason: "invalid_skill_draft", matchedSignals: decision.matchedSignals };
    }
    if (skillMd.length > MAX_SKILL_MD_SIZE) {
      return { status: "skipped", reason: "skill_too_large", matchedSignals: decision.matchedSignals };
    }

    const existingAliases = new Set(existingSkills.map((skill) => normalizeAlias(skill.name)));
    if (existingAliases.has(normalizeAlias(skillName))) {
      return { status: "skipped", reason: "duplicate_skill", matchedSignals: decision.matchedSignals };
    }

    const skillDir = path.join(this._agentDir, "learned-skills", skillName);
    if (fs.existsSync(skillDir)) {
      return { status: "skipped", reason: "skill_dir_exists", matchedSignals: decision.matchedSignals };
    }

    const safetyModel = this._resolveSafetyModel?.();
    const review = await safetyReview(skillMd, () => ({
      utility: safetyModel?.model || "",
      api_key: safetyModel?.api_key || "",
      base_url: safetyModel?.base_url || "",
      api: safetyModel?.api || "",
      utility_allow_missing_api_key: safetyModel?.allow_missing_api_key === true,
    }));
    if (!review.safe) {
      return { status: "skipped", reason: `safety_rejected:${review.reason || "unknown"}`, matchedSignals: decision.matchedSignals };
    }

    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), skillMd, "utf-8");
    fs.writeFileSync(path.join(skillDir, "_meta.json"), JSON.stringify({
      version: 1,
      source: "auto-distilled",
      createdAt: new Date().toISOString(),
      reason: String(readField(payload, "reason") || "").trim(),
      matchedSignals: decision.matchedSignals,
      usageCount: 0,
      successCount: 0,
      failureCount: 0,
      lastUsedAt: null,
    }, null, 2), "utf-8");

    await this._onInstalled?.(skillName, {
      matchedSignals: decision.matchedSignals,
      reason: String(readField(payload, "reason") || "").trim(),
    });

    return {
      status: "created",
      skillName,
      matchedSignals: decision.matchedSignals,
      reason: String(readField(payload, "reason") || "").trim(),
    };
  }
}
