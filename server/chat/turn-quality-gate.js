// @ts-check

/**
 * Legacy turn completion compatibility shim.
 *
 * V0.79 removes Brain-side output intervention. Do not synthesize fallback
 * answers, retry prompts, or tool summaries from this layer.
 */

/**
 * @typedef {{ name?: string, command?: string, [key: string]: any }} SuccessfulToolRecord
 * @typedef {{ hasToolCall?: boolean, hasPrefetchToolCall?: boolean, hasFailedTool?: boolean, hasThinking?: boolean, hasOutput?: boolean, hasError?: boolean, lastSuccessfulTools?: SuccessfulToolRecord[], [key: string]: any }} TurnQualityState
 * @typedef {{ visibleTrimmed: string, visibleLen: number, successfulTools: SuccessfulToolRecord[], hasAnyToolCall: boolean, shouldRetryPendingToolText: false, isIncompletePending: false, isShortLeadInOnly: false, isTruncatedStructuredAnswer: false, isLocalMutationLeadInOnly: false, shouldRetryLocalMutationWithoutTool: false, isToolDidNotProduceText: false, isToolSuccessMissingAnswer: false, isToolSuccessLeadInOnly: false, isPseudoToolNoOutput: false, isToolFailedShortAnswer: false, isThinkingOnlyNoOutput: boolean, localToolSuccessFallback: string, successfulToolNoTextFallback: string, toolSuccessFallback: string, isCodingDiagnosticMissingVerification: false, shouldRetryToolFinalize: false, shouldRetryLocalMutationContinuation: false, shouldRetryToolContinuation: false, fallbackKind: string }} TurnQualitySnapshot
 */

/** @type {readonly unknown[]} */
export const __turnQualityRulesForTest = Object.freeze([]);

/**
 * @param {TurnQualityState | null | undefined} ss
 * @param {unknown} visibleTextBeforeReset
 * @returns {TurnQualitySnapshot}
 */
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

/** @returns {null} */
export function evaluatePreTurnEndQuality() {
  return null;
}

/** @returns {null} */
export function evaluatePostTurnEndQuality() {
  return null;
}

/** @returns {null} */
export function evaluateForcedTurnFallback() {
  return null;
}
