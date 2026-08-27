import { describe, expect, it } from "vitest";
import { commitInkChatAssistant, formatToolTraceText, friendlyToolName } from "../src/ink-chat.js";

describe("Ink chat trace formatting", () => {
  it("formats server tool progress in a Kimi-style trace line", () => {
    expect(friendlyToolName("web_search")).toBe("SearchWeb");
    expect(formatToolTraceText({
      type: "tool_progress",
      event: "end",
      name: "web_search",
      ok: true,
      argsSummary: "2026世界杯赛程 最新 6月13日",
    })).toBe("Used SearchWeb (2026世界杯赛程 最新 6月13日)");
  });

  it("keeps failed and running tool traces explicit", () => {
    expect(formatToolTraceText({
      type: "tool_progress",
      event: "start",
      name: "web_fetch",
      argsSummary: "https://example.test",
    })).toBe("Using FetchWeb (https://example.test)");

    expect(formatToolTraceText({
      type: "tool_progress",
      event: "end",
      name: "flux-studio.generate_image",
      ok: false,
    })).toBe("Failed FluxStudio.GenerateImage");
  });
});

describe("Ink chat history commits", () => {
  it("keeps a visible assistant answer paired with the user turn", () => {
    const messages = [{ role: "user" as const, content: "hello" }];

    expect(commitInkChatAssistant(messages, "answer")).toBe(true);
    expect(messages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "answer" },
    ]);
  });

  it("removes the unmatched user history entry when the stream ends empty", () => {
    const messages = [
      { role: "system" as const, content: "system" },
      { role: "user" as const, content: "hello" },
    ];

    expect(commitInkChatAssistant(messages, "  \n")).toBe(false);
    expect(messages).toEqual([{ role: "system", content: "system" }]);
  });
});
