type AnyRecord = Record<string, unknown>;

export type TurnEndFallback = {
  reason: string;
  text: string;
  appendEvenIfHasOutput?: boolean;
};

function recordOf(value: unknown): AnyRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as AnyRecord : {};
}

function eventPayloadOf(entry: unknown): AnyRecord {
  const record = recordOf(entry);
  if (record.event && typeof record.event === "object" && !Array.isArray(record.event)) return record.event as AnyRecord;
  if (record.payload && typeof record.payload === "object" && !Array.isArray(record.payload)) return record.payload as AnyRecord;
  return record;
}

function countThinkingDeltaChars(ss: unknown): number {
  const events = Array.isArray(recordOf(ss).events) ? recordOf(ss).events as unknown[] : [];
  return events.reduce<number>((total, entry) => {
    const event = eventPayloadOf(entry);
    if (event.type !== "thinking_delta") return total;
    return total + String(event.delta || event.text || "").length;
  }, 0);
}

function hasShortVisibleAfterThinking(ss: unknown): boolean {
  const state = recordOf(ss);
  const maxVisibleChars = Number(process.env.LYNN_SHORT_VISIBLE_AFTER_THINKING_MAX_CHARS || 40);
  const minThinkingChars = Number(process.env.LYNN_SHORT_VISIBLE_AFTER_THINKING_MIN_THINKING_CHARS || 800);
  if (!state.hasOutput || !state.hasThinking || state.hasError) return false;
  const visibleLen = String(state.visibleTextAcc || "").trim().length;
  return visibleLen > 0
    && visibleLen <= maxVisibleChars
    && countThinkingDeltaChars(ss) >= minThinkingChars;
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
  if (!hasToolEvidence && hasShortVisibleAfterThinking(ss)) {
    return {
      reason: "short_visible_after_hidden_reasoning",
      text: "模型这次完成了大量隐藏推理，但最终可见答案只剩下半句。这不是你的输入问题，也不是工具失败；当前模型在隐藏推理阶段已经消耗了主要输出预算，却没有把结论完整写出来。Lynn 已把这轮安全收口，保留会话状态，并阻断半句残片继续污染下一轮上下文；请点「编辑重发」重试，或切到 /fast 后重新发送，我会重新生成完整答案。",
      appendEvenIfHasOutput: true,
    };
  }
  if (!state.hasOutput && !hasToolEvidence) {
    return {
      reason: "empty_turn_without_visible_answer",
      text: "模型这次没有返回可见内容。本轮已安全结束，避免空回复污染后续上下文；Hanako 会尝试给出兜底复查。你也可以点「编辑重发」重试，或切换模型后再发。",
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
