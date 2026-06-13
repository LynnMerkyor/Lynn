import { describe, expect, it, vi } from "vitest";
import { runPromptWithIntegrity, sanitizeMessagesBeforePrompt } from "../core/session-prompt-sanitizer.js";

describe("session prompt sanitizer helpers", () => {
  it("runs a prompt while collecting assistant text deltas", async () => {
    let handler = null;
    const unsub = vi.fn();
    const session = {
      subscribe: vi.fn((fn) => {
        handler = fn;
        return unsub;
      }),
      prompt: vi.fn(async () => {
        handler?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello" } });
        handler?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: " world" } });
      }),
    };

    await expect(runPromptWithIntegrity(session, "hi", { images: [] })).resolves.toBe("hello world");
    expect(session.prompt).toHaveBeenCalledWith("hi", { images: [] });
    expect(unsub).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes when prompt throws", async () => {
    const unsub = vi.fn();
    const session = {
      subscribe: vi.fn(() => unsub),
      prompt: vi.fn(async () => {
        throw new Error("boom");
      }),
    };

    await expect(runPromptWithIntegrity(session, "hi")).rejects.toThrow("boom");
    expect(session.prompt).toHaveBeenCalledWith("hi");
    expect(unsub).toHaveBeenCalledTimes(1);
  });

  it("rewrites persisted market prefetch user context back to the original question", () => {
    const result = sanitizeMessagesBeforePrompt([
      {
        role: "user",
        content: [{
          type: "text",
          text: [
            "财经/行情快照（via bing-html）",
            "查询：英伟达昨晚收盘价如何？",
            "类型：stock",
            "",
            "1. NVIDIA",
            "https://www.nvidia.cn/",
            "- snippet",
            "",
            "英伟达昨晚收盘价如何？",
          ].join("\n"),
        }],
      },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
    ]);

    expect(result.removed).toBe(0);
    expect(result.rewritten).toBe(1);
    expect(result.messages[0].content).toEqual([{ type: "text", text: "英伟达昨晚收盘价如何？" }]);
  });

  it("rewrites legacy completed-tool-prefetch prompts using the explicit original question marker", () => {
    const result = sanitizeMessagesBeforePrompt([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "【系统已完成行情工具预取】\n资料很多\n\n【用户原始问题】\n今天金价如何",
          },
        ],
      },
    ]);

    expect(result.rewritten).toBe(1);
    expect(result.messages[0].content).toEqual([{ type: "text", text: "今天金价如何" }]);
  });

  it("removes Brain-managed local tool-not-found echoes while preserving assistant text", () => {
    const result = sanitizeMessagesBeforePrompt([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "need market data" },
          { type: "toolCall", id: "tc-1", name: "stock_market", arguments: { query: "黄金价格" } },
          { type: "text", text: "今天金价约 916 元/克。" },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "tc-1",
        toolName: "stock_market",
        isError: true,
        content: [{ type: "text", text: "Tool stock_market not found" }],
      },
      {
        role: "assistant",
        stopReason: "aborted",
        errorMessage: "Request was aborted",
        content: [
          { type: "thinking", thinking: "try fallback" },
          { type: "toolCall", id: "tc-2", name: "web_search", arguments: { query: "黄金" } },
        ],
      },
    ]);

    expect(result.removed).toBe(2);
    expect(result.rewritten).toBe(1);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content).toEqual([
      { type: "thinking", thinking: "need market data" },
      { type: "text", text: "今天金价约 916 元/克。" },
    ]);
  });

  it("removes empty assistant messages that can poison DeepSeek follow-up turns", () => {
    const result = sanitizeMessagesBeforePrompt([
      { role: "user", content: [{ type: "text", text: "抓一下" }] },
      { role: "assistant", content: "" },
      { role: "assistant", content: [{ type: "thinking", thinking: "只有思考链,没有可见答案" }] },
      { role: "assistant", content: [{ type: "toolCall", id: "tc-drop", name: "web_search", arguments: { query: "世界杯" } }] },
      { role: "assistant", content: [{ type: "toolCall", id: "tc-keep", name: "custom_tool", arguments: { query: "世界杯" } }] },
      { role: "assistant", content: [{ type: "text", text: "正常答案" }] },
    ]);

    expect(result.removed).toBe(3);
    expect(result.messages).toHaveLength(3);
    expect(result.messages[1].content).toEqual([
      { type: "toolCall", id: "tc-keep", name: "custom_tool", arguments: { query: "世界杯" } },
    ]);
    expect(result.messages[2].content).toEqual([{ type: "text", text: "正常答案" }]);
  });
});
