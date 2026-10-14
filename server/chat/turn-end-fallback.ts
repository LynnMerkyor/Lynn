type AnyRecord = Record<string, unknown>;

export type TurnEndFallback = {
  reason: string;
  text: string;
  appendEvenIfHasOutput?: boolean;
};

function recordOf(value: unknown): AnyRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as AnyRecord : {};
}

export function resolveTurnEndFallback(
  ss: unknown,
  { hasToolEvidence, toolFallbackText = "" }: { hasToolEvidence: boolean; toolFallbackText?: string },
): TurnEndFallback | null {
  const state = recordOf(ss);
  if (state.hasError) return null;
  if (!state.hasOutput && state.hasThinking && !hasToolEvidence) {
    return {
      reason: "reasoning_only_without_visible_answer",
      text: "模型这次只返回了思考过程，没有给出最终可见答案。请点「编辑重发」重试，或切到 /fast 后再发。",
    };
  }
  if (!state.hasOutput && !hasToolEvidence) {
    return {
      reason: "empty_turn_without_visible_answer",
      text: "模型这次没有返回可见内容。本轮已安全结束，避免空回复污染后续上下文。请点「编辑重发」重试，或切换模型后再发。",
    };
  }
  if (!state.hasOutput && hasToolEvidence && toolFallbackText.trim()) {
    return {
      reason: "tool_turn_end_without_visible_answer",
      text: toolFallbackText.trim(),
    };
  }
  return null;
}
