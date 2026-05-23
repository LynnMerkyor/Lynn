/**
 * Legacy turn completion compatibility shim.
 *
 * V0.79 removes Brain-side output intervention. Do not synthesize fallback
 * answers, retry prompts, or tool summaries from this layer.
 */

export const __turnQualityRulesForTest = Object.freeze([]);

export function createTurnQualitySnapshot(ss, visibleTextBeforeReset) {
  const visibleTrimmed = String(visibleTextBeforeReset || "").trim();
  const successfulTools = Array.isArray(ss?.lastSuccessfulTools) ? ss.lastSuccessfulTools : [];
  return {
    visibleTrimmed,
    visibleLen: visibleTrimmed.length,
    successfulTools,
    hasAnyToolCall: !!(ss?.hasToolCall || ss?.hasPrefetchToolCall || successfulTools.length > 0 || ss?.hasFailedTool),
    shouldRetryPendingToolText: false,
    isIncompletePending: false,
    isShortLeadInOnly: false,
    isTruncatedStructuredAnswer: false,
    isLocalMutationLeadInOnly: false,
    shouldRetryLocalMutationWithoutTool: false,
    isToolDidNotProduceText: false,
    isToolSuccessMissingAnswer: false,
    isToolSuccessLeadInOnly: false,
    isPseudoToolNoOutput: false,
    isToolFailedShortAnswer: false,
    isThinkingOnlyNoOutput: !!(ss?.hasThinking && !ss?.hasOutput && !ss?.hasError),
    localToolSuccessFallback: "",
    successfulToolNoTextFallback: "",
    toolSuccessFallback: "",
    isCodingDiagnosticMissingVerification: false,
    shouldRetryToolFinalize: false,
    shouldRetryLocalMutationContinuation: false,
    shouldRetryToolContinuation: false,
    fallbackKind: "",
  };
}

export function evaluatePreTurnEndQuality() {
  return null;
}

export function evaluatePostTurnEndQuality() {
  return null;
}

export function evaluateForcedTurnFallback() {
  return null;
}
