import { inferReportResearchKind } from "./report-research-context.js";
import {
  buildBudgetCalculationContext,
  prefetchToolNameForKind,
  shouldPrefetchReportContext,
  shouldSuppressLocalToolPrefetch,
} from "./prefetch-context.js";
import {
  attachLocalQwen35BenchContext,
  shouldAttachLocalQwen35BenchContext,
} from "./local-qwen35-bench-context.js";

export type ToolUseBehaviorName = "run_llm_again" | "prefetch_then_run_or_stop";

export interface ToolDisableDecision {
  behavior: ToolUseBehaviorName;
  reason: string;
  reportKind: string;
  budgetContext: string;
  effectivePromptText: string;
  disableTools?: boolean;
  toolName?: string;
}

interface ModelInfoLike {
  isBrain?: boolean;
  [key: string]: unknown;
}

interface ToolUseBehaviorOptions {
  modelInfo?: ModelInfoLike | null;
}

export const TOOL_USE_BEHAVIOR: Readonly<{ RUN_LLM_AGAIN: "run_llm_again"; PREFETCH_THEN_RUN_OR_STOP: "prefetch_then_run_or_stop" }> = Object.freeze({
  RUN_LLM_AGAIN: "run_llm_again",
  PREFETCH_THEN_RUN_OR_STOP: "prefetch_then_run_or_stop",
});

/**
 * Some prompts are explicitly chat-only: "do not call tools", same-conversation
 * recall with "only reply X", or a simple "remember this normal label"
 * acknowledgement. For those turns we suppress tool schemas at runtime instead
 * of relying on model obedience.
 */
export function shouldDisableToolsForTurn(promptText: unknown): boolean {
  const text = String(promptText || "").trim();
  if (!text) return false;
  const compact = text.replace(/\s+/g, "");
  const explicitNoTools = /(?:不要|不用|不必|无需|禁止).{0,12}(?:调用|使用|启用|走|打开)?(?:任何)?(?:工具|tool|tools|联网|搜索|网页|浏览器)|(?:do\s+not|don't|without|no)\s+(?:call\s+|use\s+)?(?:any\s+)?(?:tools?|web|browser|search)/iu.test(text);
  if (explicitNoTools) return true;

  const shortAnswerOnly = /(?:只|仅)(?:需要)?(?:回复|输出|回答)|请(?:只|仅|直接)(?:回复|输出|回答)|最后一行不能有其他字|only\s+(?:reply|respond|output|answer)|reply\s+only|respond\s+only/iu.test(text);
  const explicitToolAsk = /(?:用|调用|使用).{0,12}(?:工具|搜索|联网|浏览器|查)|(?:查|搜索|检索).{0,12}(?:天气|行情|股价|新闻|网页|资料|来源)|use\s+(?:the\s+)?(?:tool|tools|web|browser|search)|look\s+up|search\s+for/iu.test(text);
  const sameConversationRecallOnly = shortAnswerOnly
    && !explicitToolAsk
    && compact.length <= 180
    && /(?:刚才|上(?:一)?轮|前面|项目代号|本身|FENCE_OK|已准备好|介绍你|你能帮我|你能做什么|last\s+turn|previous|above)/iu.test(text);
  if (sameConversationRecallOnly) return true;

  const shortLengthChatOnly = /\d+\s*(?:字|字符|个字|words?|chars?|characters?)\s*(?:以内|以下|之内|内|or\s+less|max(?:imum)?|under)/iu.test(text)
    && !explicitToolAsk
    && compact.length <= 220
    && /(?:介绍你|你能帮我|你能做什么|你是谁|已准备好|identity|introduce|what\s+can\s+you\s+do|who\s+are\s+you)/iu.test(text);
  if (shortLengthChatOnly) return true;

  const simpleMemoryAck = /(?:请)?记住|remember/iu.test(text)
    && /(?:项目代号|普通项目标签|标签|代号|偏好|preference|label|project\s+code)/iu.test(text)
    && (shortAnswerOnly || /已记住|got\s+it|remembered/iu.test(text))
    && compact.length <= 260;
  return simpleMemoryAck;
}

export function buildNoToolTurnPrompt(promptText: unknown): string {
  const text = String(promptText || "").trim();
  const formatHint = /\d+\s*(?:字|字符|个字|words?|chars?|characters?)|只(?:回复|输出|回答)|最后一行|only\s+(?:reply|respond|output|answer)/iu.test(text)
    ? "若用户限制字数、格式或最后一行内容,必须严格遵守。"
    : "";
  return [
    "【Lynn 路由约束】本轮用户要求直接聊天短答。不要调用、模拟或提及任何工具/技能;不要读取或写入文件;不要运行命令;不要创建交付物。",
    formatHint ? `${formatHint}有数字字数上限时,答案要保守控制在上限的约 70% 以内;不要列清单,不要展开解释。` : "",
    "只根据当前对话直接回答用户。",
  ].filter(Boolean).join("");
}

export function resolveInitialToolUseBehavior(promptText: unknown, opts: ToolUseBehaviorOptions = {}): ToolDisableDecision {
  const text = String(promptText || "");
  const modelInfo = opts.modelInfo || undefined;
  if (shouldAttachLocalQwen35BenchContext(text, modelInfo)) {
    return {
      behavior: TOOL_USE_BEHAVIOR.RUN_LLM_AGAIN,
      reason: "local_qwen35_benchmark_context",
      reportKind: "",
      budgetContext: "",
      effectivePromptText: attachLocalQwen35BenchContext(text, modelInfo),
    };
  }

  // V0.79: do not short-circuit with handcrafted answers. The model should
  // produce the user-visible response; this layer may add context, but should
  // not replace model output.

  const reportKind = inferReportResearchKind(text);
  const budgetContext = buildBudgetCalculationContext(text);
  const disableTools = shouldDisableToolsForTurn(text);
  const effectivePromptText = budgetContext
    ? buildPrefetchAugmentedPrompt(text, "", budgetContext)
    : text;
  const suppressLocalPrefetch = shouldSuppressLocalToolPrefetch(text);

  // Treat Brain/default the same way as BYOK for deterministic realtime
  // evidence. This does not replace the model answer; it only supplies the
  // current facts so a slow remote tool chain cannot turn weather/market asks
  // into an invisible timeout.
  if (!suppressLocalPrefetch && shouldPrefetchReportContext(reportKind, modelInfo)) {
    return {
      behavior: TOOL_USE_BEHAVIOR.PREFETCH_THEN_RUN_OR_STOP,
      reason: "report_context_prefetch",
      reportKind,
      budgetContext,
      effectivePromptText,
      disableTools,
      toolName: prefetchToolNameForKind(reportKind),
    };
  }

  return {
    behavior: TOOL_USE_BEHAVIOR.RUN_LLM_AGAIN,
    reason: "default",
    reportKind,
    budgetContext,
    effectivePromptText,
    disableTools,
  };
}

function sanitizeContextForModel(context: unknown): string {
  return String(context || "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => !/^【[^】]*(?:工具资料|实时工具资料)[^】]*】$/.test(line.trim()))
    .filter((line) => !/^请直接/.test(line.trim()))
    .filter((line) => !/^下面是/.test(line.trim()))
    .filter((line) => !/^如果资料不足/.test(line.trim()))
    .filter((line) => !/^不要/.test(line.trim()))
    .filter((line) => !/^现实建议/.test(line.trim()))
    .map((line) => line
      .replace(/^【系统已完成(?:的)?(.+?)】$/, "【$1】")
      .replace(/^【系统已完成(.+?)】$/, "【$1】"))
    .join("\n")
    .trim();
}

/**
 * Keep this as evidence only. Do not add task instructions such as
 * "answer based on the material" or "think step by step"; thinking mode
 * belongs to the model/runtime, not this helper.
 */
export function buildPrefetchAugmentedPrompt(promptText: unknown, reportContext: unknown, budgetContext: unknown = ""): string {
  return [
    sanitizeContextForModel(reportContext),
    sanitizeContextForModel(budgetContext),
    String(promptText || "").trim(),
  ].filter(Boolean).join("\n\n");
}
