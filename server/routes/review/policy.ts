/** Review policy layer. Extracted without changing policy or routing. */
import { getLocale } from "../../i18n.js";
import { computeReviewWorkflowGate } from "../../review-result.js";
import { type ReviewerKind, type ReviewProgressStage, type ReviewVerdict, type JsonRecord, type RuntimeAgentLike, type ReviewPreferences, type ReviewConfig, type CodedError, type StructuredReviewLike, type ReviewSecondOpinion, type ReviewContextPack, type FollowUpContextPackShape } from './types.js';


export const REVIEWER_YUANS = new Set<ReviewerKind>(["hanako", "butter"]);


export const BUILT_IN_REVIEWER_IDS = new Set(["hanako", "butter"]);


export const REVIEW_PROGRESS_STAGES: ReviewProgressStage[] = ["packing_context", "reviewing", "structuring", "arbitrating", "done"];


export const MAX_CONTEXT_PREVIEW_CHARS = 2200;


export const MAX_SESSION_LINES = 120;


export const MAX_TOOL_ITEMS = 10;


export const REVIEW_EXEC_TIMEOUT_MS = 45_000;


export const REVIEW_FALLBACK_TIMEOUT_MS = 22_000;


export const AUTO_REVIEW_EXEC_TIMEOUT_MS = Number(process.env.LYNN_AUTO_REVIEW_TIMEOUT_MS || 35_000);


export const AUTO_REVIEW_FALLBACK_TIMEOUT_MS = Number(process.env.LYNN_AUTO_REVIEW_FALLBACK_TIMEOUT_MS || 18_000);


export const AUTO_REVIEW_BRAIN_TIMEOUT_MS = Math.max(
  AUTO_REVIEW_EXEC_TIMEOUT_MS + 15_000,
  Number(process.env.LYNN_AUTO_REVIEW_BRAIN_TIMEOUT_MS || 75_000),
);


export const AUTO_REVIEW_CHAIN_TIMEOUT_MS = Math.max(
  AUTO_REVIEW_BRAIN_TIMEOUT_MS + AUTO_REVIEW_FALLBACK_TIMEOUT_MS + 15_000,
  AUTO_REVIEW_EXEC_TIMEOUT_MS * 3,
);


export const AUTO_REVIEW_MAX_OUTPUT_TOKENS = Math.max(1200, Math.min(2400, Number(process.env.LYNN_AUTO_REVIEW_MAX_TOKENS || 2000)));


export const AUTO_REVIEW_MODEL_LABEL = "Hanako · GLM-5.3-Flash";


export const AUTO_REVIEW_FALLBACK_LABEL = "Hanako · GLM-5.3/DS Vision/Brain";


export const MIMO_SECOND_OPINION_LABEL = "MiMo 2.5 Pro 仲裁";


export const MIMO_SECOND_OPINION_MODEL = "mimo-v2.5-pro";


export const MIMO_SECOND_OPINION_TIMEOUT_MS = Math.max(3_000, Math.min(20_000, Number(process.env.LYNN_REVIEW_SECOND_OPINION_TIMEOUT_MS || 15_000)));


export const MIMO_SECOND_OPINION_MAX_TOKENS = Math.max(600, Math.min(1_600, Number(process.env.LYNN_REVIEW_SECOND_OPINION_MAX_TOKENS || 1_200)));


export const MIMO_SECOND_OPINION_PROVIDERS = new Set(["mimo", "xiaomi", "xiaomi-mimo", "token-plan"]);


export const MIMO_SECOND_OPINION_CACHE_TTL_MS = Math.max(30_000, Number(process.env.LYNN_REVIEW_SECOND_OPINION_CACHE_TTL_MS || 10 * 60_000));


export const MIMO_SECOND_OPINION_BREAKER_MS = Math.max(60_000, Number(process.env.LYNN_REVIEW_SECOND_OPINION_BREAKER_MS || 15 * 60_000));


export const MIMO_SECOND_OPINION_FAILURE_LIMIT = Math.max(1, Number(process.env.LYNN_REVIEW_SECOND_OPINION_FAILURE_LIMIT || 3));


export const AUTO_REVIEW_FALLBACK_PROVIDERS = new Set(["deepseek", "zhipu", "zhipu-coding", "brain"]);


export const AUTO_REVIEW_DEEPSEEK_PROVIDERS = new Set(["deepseek"]);


export const AUTO_REVIEW_GLM_PROVIDERS = new Set(["zhipu", "zhipu-coding"]);


export const AUTO_REVIEW_BRAIN_PROVIDERS = new Set(["brain"]);


export const AUTO_REVIEW_GLM_MAX_CONCURRENCY = Math.max(1, Number(process.env.LYNN_AUTO_REVIEW_GLM_MAX_CONCURRENCY || 1));

export function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

export function asStructuredReview(value: unknown): StructuredReviewLike | null {
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

export function errorMessage(err: unknown, fallback = ""): string {
  return err instanceof Error ? err.message : (fallback || String(err || ""));
}

export function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "";
}

export function errorCode(err: unknown): string | null {
  const record = asRecord(err);
  return typeof record?.code === "string" ? record.code : null;
}

export function stripThinkTags(raw: unknown): string {
  return String(raw || "")
    .replace(/<think>[\s\S]*?<\/think>\n*/gi, "")
    .trim();
}

export function isZh(): boolean {
  return getLocale().startsWith("zh");
}

export function buildReviewSystemAppend(options: { autoReview?: boolean; reviewMode?: string | null } = {}): string {
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

export function normalizeReviewerKind(kind: unknown): ReviewerKind {
  return kind === "butter" ? "butter" : "hanako";
}

export function normalizeReviewerId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export function reviewerDisplayName(yuan: ReviewerKind | string | null | undefined): string {
  return yuan === "butter" ? "Butter" : "Hanako";
}

export function normalizeReviewConfig(prefs: ReviewPreferences = {}): ReviewConfig {
  const raw = prefs.review && typeof prefs.review === "object" ? prefs.review : {};
  return {
    defaultReviewer: normalizeReviewerKind(raw.defaultReviewer),
    hanakoReviewerId: normalizeReviewerId(raw.hanakoReviewerId),
    butterReviewerId: normalizeReviewerId(raw.butterReviewerId),
  };
}

export function getAgentModel(agent: RuntimeAgentLike | null | undefined): { modelId: string | null; modelProvider: string | null } {
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

export function isTimeoutLikeError(err: unknown): boolean {
  const name = errorName(err);
  const message = errorMessage(err);
  return name === "AbortError"
    || /aborted due to timeout/i.test(message)
    || /\btimeout\b/i.test(message);
}

export function isRetryableReviewError(err: unknown): boolean {
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

export function hasMeaningfulReviewOutput(content: unknown): content is string {
  return typeof content === "string" && content.trim().length > 0;
}

export function buildDeterministicReviewFallbackContent(input: {
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

export function createReviewNoOutputError(): CodedError {
  const err: CodedError = new Error(isZh()
    ? "这次复查没有产出可显示的复查结果。"
    : "This review returned no output.");
  err.code = "review_no_output";
  return err;
}

export function normalizeProviderId(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

export function normalizeModelId(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

export function secondOpinionEnabled(): boolean {
  return !/^(?:0|false|off|no)$/i.test(String(process.env.LYNN_REVIEW_SECOND_OPINION ?? ""));
}

export function shouldEscalateToMimo(
  structured: StructuredReviewLike | null,
  input: { autoReview: boolean; reviewMode: string | null; triggerReasons: string[]; errorCode: string | null },
): boolean {
  if (!secondOpinionEnabled() || !input.autoReview || input.reviewMode !== "background") return false;
  if (input.errorCode === "review_deterministic_fallback") return false;
  if (!structured || (structured.verdict !== "concerns" && structured.verdict !== "blocker")) return false;
  if (input.triggerReasons.includes("tool_failed") || input.triggerReasons.includes("empty_answer_guard")) return false;
  return input.triggerReasons.includes("high_stakes_domain")
    || input.triggerReasons.includes("time_sensitive_or_market");
}

export function mergeReviewWithSecondOpinion(
  primary: StructuredReviewLike,
  second: StructuredReviewLike,
  metadata: ReviewSecondOpinion,
): StructuredReviewLike {
  const primaryFindings = Array.isArray(primary.findings) ? primary.findings : [];
  const secondFindings = Array.isArray(second.findings)
    ? second.findings.slice(0, 3).map((finding) => ({
        ...finding,
        title: finding.title ? `[MiMo 仲裁] ${finding.title}` : "[MiMo 仲裁] 复核发现",
      }))
    : [];
  const verdict: ReviewVerdict = primary.verdict === "blocker" || second.verdict === "blocker"
    ? "blocker"
    : primary.verdict === "concerns" || second.verdict === "concerns"
      ? "concerns"
      : "pass";
  const merged: StructuredReviewLike = {
    ...primary,
    verdict,
    findings: [...primaryFindings, ...secondFindings],
    secondOpinion: metadata,
  };
  merged.workflowGate = computeReviewWorkflowGate(merged as Parameters<typeof computeReviewWorkflowGate>[0]);
  return merged;
}

export function formatReviewFailureMessage(err: unknown, attemptedModels: string[] = []): string {
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

export function cleanPreviewText(value: unknown, maxChars = MAX_CONTEXT_PREVIEW_CHARS): string {
  if (typeof value !== "string") return "";
  const compact = value.replace(/\r\n?/g, "\n").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars).trim()}\n…`;
}

export function formatContextPack(contextPack: ReviewContextPack): string {
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

export function normalizeFollowUpContextPack(value: unknown): FollowUpContextPackShape | null {
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
