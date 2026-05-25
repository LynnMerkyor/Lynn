import { describe, expect, it } from "vitest";
import {
  appendNoThinkHintToLastUserMessage,
  shouldRetryLocalQwen35WithoutThinking,
} from "../server/chat/local-qwen35-direct-policy.js";

describe("local Qwen3.5 direct policy", () => {
  it("retries with thinking off only for thinking-only local output", () => {
    expect(shouldRetryLocalQwen35WithoutThinking({
      enableThinking: true,
      assistantText: "",
      reasoningText: "Thinking Process...",
    })).toBe(true);

    expect(shouldRetryLocalQwen35WithoutThinking({
      enableThinking: true,
      assistantText: "正文",
      reasoningText: "思考",
    })).toBe(false);

    expect(shouldRetryLocalQwen35WithoutThinking({
      enableThinking: false,
      assistantText: "",
      reasoningText: "思考",
    })).toBe(false);
  });

  it("adds one no-think hint to the latest user message", () => {
    const messages = [
      { role: "user", content: "上一轮" },
      { role: "assistant", content: "好的" },
      { role: "user", content: "杭州滨江有什么好吃的吗" },
    ];

    appendNoThinkHintToLastUserMessage(messages);
    appendNoThinkHintToLastUserMessage(messages);

    expect(messages[0].content).toBe("上一轮");
    expect(messages[2].content).toBe("杭州滨江有什么好吃的吗\n/no_think");
  });
});
