import { debugLog } from "../../lib/debug-log.js";
import { startReviewRun, type StartReviewRunRequest } from "../routes/review.js";
import type { SessionLike } from "./stream-state.js";
import type { ToolSuccessRecord } from "./tool-summary.js";

type BroadcastFn = (payload: Record<string, unknown>) => unknown;

export type AutoReviewMode = "background" | "fallback";

export interface AutoReviewTurnSnapshot {
  mode?: AutoReviewMode;
  reason?: string;
  sourceText?: string;
  sessionPath?: string | null;
  ss?: SessionLike | null;
}

export interface AutoReviewScheduleOptions extends AutoReviewTurnSnapshot {
  engine: unknown;
  broadcast: BroadcastFn;
}

export interface AutoReviewDecision {
  shouldReview: boolean;
  mode: AutoReviewMode;
  reasons: string[];
  context: string;
  sourceResponse: string;
}

const AUTO_REVIEW_DISABLED = /^(?:0|false|off|no)$/i;
const AUTO_REVIEW_HIGH_RISK_TOOL_RE = /\b(?:web[_-]?search|web[_-]?fetch|stock[_-]?market|sports[_-]?score|search|fetch|stock|quote|market|sports|score|weather|news|live|research|bash|write|edit|create_report|create_poster|browser)\b/i;
const AUTO_REVIEW_HIGH_RISK_TEXT_RE = /(?:行情|股价|金价|黄金|比分|赛程|世界杯|NBA|天气|新闻|最新|今天|今晚|昨日|昨晚|收盘|价格|搜索|访问|来源|文件|执行|写入|删除|修改)/i;

function autoReviewEnabled(): boolean {
  return !AUTO_REVIEW_DISABLED.test(String(process.env.LYNN_AUTO_REVIEW ?? ""));
}

function autoReviewAlways(): boolean {
  return /^(?:1|true|on|yes)$/i.test(String(process.env.LYNN_AUTO_REVIEW_ALWAYS ?? ""));
}

function cleanLine(value: unknown, max = 280): string {
  const compact = String(value || "").replace(/\s+/g, " ").trim();
  if (!compact) return "";
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function toolRecordLine(record: ToolSuccessRecord): string {
  const bits = [record.name];
  const command = cleanLine(record.command, 160);
  const filePath = cleanLine(record.filePath, 180);
  const preview = cleanLine(record.outputPreview, 220);
  if (command) bits.push(`query=${command}`);
  if (filePath) bits.push(`file=${filePath}`);
  if (preview) bits.push(`result=${preview}`);
  return `- ${bits.join(" · ")}`;
}

function uniqueReasons(reasons: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of reasons) {
    const reason = cleanLine(raw, 80);
    if (!reason || seen.has(reason)) continue;
    seen.add(reason);
    out.push(reason);
    if (out.length >= 8) break;
  }
  return out;
}

export function decideAutoReviewTurn({
  mode,
  reason,
  sourceText,
  ss,
}: AutoReviewTurnSnapshot): AutoReviewDecision {
  const requestedMode: AutoReviewMode = mode === "fallback" ? "fallback" : "background";
  const answer = String(sourceText || ss?.visibleTextAcc || ss?.realtimeToolFallbackText || "").trim();
  const successfulTools = Array.isArray(ss?.lastSuccessfulTools) ? ss!.lastSuccessfulTools as ToolSuccessRecord[] : [];
  const failedTools = Array.isArray(ss?.lastFailedTools) ? ss!.lastFailedTools as string[] : [];
  const successfulNames = successfulTools.map((tool) => cleanLine(tool.name, 80)).filter(Boolean);
  const failedNames = failedTools.map((tool) => cleanLine(tool, 80)).filter(Boolean);
  const toolText = [
    ...successfulTools.map((tool) => `${tool.name} ${tool.command} ${tool.filePath} ${tool.outputPreview}`),
    ...failedNames,
  ].join("\n");
  const reasons: string[] = [];

  if (reason) reasons.push(reason);
  if (requestedMode === "fallback") reasons.push("fallback_visible_answer");
  if (failedNames.length || ss?.hasFailedTool) reasons.push("tool_failed");
  if (successfulTools.length || ss?.hasToolCall || ss?.hasPrefetchToolCall || Number(ss?.successfulToolCount || 0) > 0) reasons.push("tool_evidence");
  if (AUTO_REVIEW_HIGH_RISK_TOOL_RE.test(toolText)) reasons.push("high_risk_tool");
  if (AUTO_REVIEW_HIGH_RISK_TEXT_RE.test(`${answer}\n${toolText}`)) reasons.push("time_sensitive_or_market");
  if (!answer && requestedMode === "fallback") reasons.push("empty_answer_guard");
  if (autoReviewAlways()) reasons.push("forced");

  const dedupedReasons = uniqueReasons(reasons);
  const shouldReview = autoReviewAlways() || requestedMode === "fallback" || dedupedReasons.some((r) => (
    r === "tool_failed" ||
    r === "high_risk_tool" ||
    r === "time_sensitive_or_market" ||
    r === "empty_answer_guard" ||
    r === "fallback_visible_answer"
  ));

  const toolLines = [
    ...successfulTools.map(toolRecordLine),
    ...failedNames.map((name) => `- ${name} · failed`),
  ].filter(Boolean).slice(0, 12);

  const contextLines = [
    "[自动复查触发]",
    `mode=${requestedMode}`,
    `reasons=${dedupedReasons.join(", ") || "none"}`,
    "",
    "[主回答]",
    answer || "(无可见主回答)",
    "",
    "[工具轨迹]",
    toolLines.length ? toolLines.join("\n") : "(无工具轨迹)",
    "",
    "[复查要求]",
    "请用 Hanako · MiMo/GLM 做短复查。重点检查事实、数字、时效性、工具证据是否支持结论，以及是否需要补充或修订。不要重写整篇答案。",
  ];

  return {
    shouldReview,
    mode: requestedMode,
    reasons: dedupedReasons,
    context: contextLines.join("\n"),
    sourceResponse: answer,
  };
}

export function scheduleAutoReviewForTurn(options: AutoReviewScheduleOptions): boolean {
  if (!autoReviewEnabled()) return false;
  const ss = options.ss;
  if (!ss) return false;
  if (ss.autoReviewStarted) return false;

  const decision = decideAutoReviewTurn(options);
  if (!decision.shouldReview) return false;

  ss.autoReviewStarted = true;
  const request: StartReviewRunRequest = {
    context: decision.context,
    reviewerKind: "hanako",
    sessionPath: typeof options.sessionPath === "string" ? options.sessionPath : null,
    reviewId: `auto-review-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    autoReview: true,
    reviewMode: decision.mode,
    triggerReasons: decision.reasons,
    sourceResponse: decision.sourceResponse,
  };

  const timer = setTimeout(() => {
    startReviewRun(options.engine as Parameters<typeof startReviewRun>[0], { broadcast: options.broadcast }, request)
      .catch((err) => {
        debugLog()?.warn("review", `auto review failed · ${err instanceof Error ? err.message : String(err)}`);
      });
  }, 25) as ReturnType<typeof setTimeout> & { unref?: () => void };
  timer.unref?.();

  return true;
}
