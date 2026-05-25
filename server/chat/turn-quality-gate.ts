/**
 * Legacy turn completion compatibility shim.
 *
 * V0.79 removes Brain-side output intervention. Do not synthesize fallback
 * answers, retry prompts, or tool summaries from this layer.
 */

interface SuccessfulToolRecord {
  name?: string;
  command?: string;
  [key: string]: unknown;
}

interface TurnQualityState {
  hasToolCall?: boolean;
  hasPrefetchToolCall?: boolean;
  hasFailedTool?: boolean;
  hasThinking?: boolean;
  hasOutput?: boolean;
  hasError?: boolean;
  lastSuccessfulTools?: SuccessfulToolRecord[];
  [key: string]: unknown;
}

interface TurnQualitySnapshot {
  visibleTrimmed: string;
  visibleLen: number;
  successfulTools: SuccessfulToolRecord[];
  hasAnyToolCall: boolean;
  shouldRetryPendingToolText: false;
  isIncompletePending: false;
  isShortLeadInOnly: false;
  isTruncatedStructuredAnswer: false;
  isLocalMutationLeadInOnly: false;
  shouldRetryLocalMutationWithoutTool: false;
  isToolDidNotProduceText: false;
  isToolSuccessMissingAnswer: false;
  isToolSuccessLeadInOnly: false;
  isPseudoToolNoOutput: false;
  isToolFailedShortAnswer: false;
  isThinkingOnlyNoOutput: boolean;
  localToolSuccessFallback: string;
  successfulToolNoTextFallback: string;
  toolSuccessFallback: string;
  isCodingDiagnosticMissingVerification: false;
  shouldRetryToolFinalize: false;
  shouldRetryLocalMutationContinuation: false;
  shouldRetryToolContinuation: false;
  fallbackKind: string;
}

export const __turnQualityRulesForTest: readonly unknown[] = Object.freeze([]);

export function createTurnQualitySnapshot(ss: TurnQualityState | null | undefined, visibleTextBeforeReset: unknown): TurnQualitySnapshot {
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

export function evaluatePreTurnEndQuality(): null {
  return null;
}

export function evaluatePostTurnEndQuality(): null {
  return null;
}

export function evaluateForcedTurnFallback(): null {
  return null;
}
