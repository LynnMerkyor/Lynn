import {
  buildQuickTranslationPrompt,
  detectQuickTranslationIntent,
} from "./translation-intent.js";
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

export const TOOL_USE_BEHAVIOR = Object.freeze({
  RUN_LLM_AGAIN: "run_llm_again",
  PREFETCH_THEN_RUN_OR_STOP: "prefetch_then_run_or_stop",
});

export function resolveInitialToolUseBehavior(promptText, opts = {}) {
  const text = String(promptText || "");
  if (shouldAttachLocalQwen35BenchContext(text, opts.modelInfo)) {
    return {
      behavior: TOOL_USE_BEHAVIOR.RUN_LLM_AGAIN,
      reason: "local_qwen35_benchmark_context",
      reportKind: "",
      budgetContext: "",
      effectivePromptText: attachLocalQwen35BenchContext(text, opts.modelInfo),
    };
  }

  // V0.79: do not short-circuit with handcrafted answers. The model should
  // produce the user-visible response; this layer may add context, but should
  // not replace model output.

  const translationIntent = detectQuickTranslationIntent(text);
  if (translationIntent) {
    return {
      behavior: TOOL_USE_BEHAVIOR.RUN_LLM_AGAIN,
      reason: "quick_translation",
      reportKind: "",
      budgetContext: "",
      effectivePromptText: buildQuickTranslationPrompt(translationIntent),
    };
  }

  const reportKind = inferReportResearchKind(text);
  const budgetContext = buildBudgetCalculationContext(text);
  const effectivePromptText = budgetContext
    ? `${budgetContext}\n\n【用户原始问题】\n${text}`
    : text;
  const suppressLocalPrefetch = shouldSuppressLocalToolPrefetch(text);

  // Treat Brain/default the same way as BYOK for deterministic realtime
  // evidence. This does not replace the model answer; it only supplies the
  // current facts so a slow remote tool chain cannot turn weather/market asks
  // into an invisible timeout.
  if (!suppressLocalPrefetch && shouldPrefetchReportContext(reportKind, opts.modelInfo)) {
    return {
      behavior: TOOL_USE_BEHAVIOR.PREFETCH_THEN_RUN_OR_STOP,
      reason: "report_context_prefetch",
      reportKind,
      budgetContext,
      effectivePromptText,
      toolName: prefetchToolNameForKind(reportKind),
    };
  }

  return {
    behavior: TOOL_USE_BEHAVIOR.RUN_LLM_AGAIN,
    reason: "default",
    reportKind,
    budgetContext,
    effectivePromptText,
  };
}

export function buildPrefetchAugmentedPrompt(promptText, reportContext, budgetContext = "") {
  return [
    String(reportContext || "").trim(),
    budgetContext,
    `【用户原始问题】\n${String(promptText || "")}`,
  ].filter(Boolean).join("\n\n");
}
