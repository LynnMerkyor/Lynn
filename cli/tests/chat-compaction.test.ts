import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../src/brain-client.js";
import { CHAT_COMPACTION_NOTE, compactChatMessages } from "../src/chat-compaction.js";

function user(content: string): ChatMessage {
  return { role: "user", content };
}

function assistant(content: string): ChatMessage {
  return { role: "assistant", content };
}

describe("chat compaction", () => {
  it("keeps the system prefix, first request, and recent turns while summarizing the middle", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "runtime prefix" },
      user("ORIGINAL: explain this repository"),
      assistant("original answer"),
    ];
    for (let i = 0; i < 12; i += 1) {
      messages.push(user(`old question ${i} https://example.com/source-${i}`));
      messages.push(assistant(`old answer ${i} ${"x".repeat(160)}`));
    }
    messages.push(user("latest question"));

    const result = compactChatMessages(messages, 1_000, 3);

    expect(result.compactedMessages).toBeGreaterThan(0);
    expect(messages[0]).toEqual({ role: "system", content: "runtime prefix" });
    expect(JSON.stringify(messages)).toContain("ORIGINAL: explain this repository");
    expect(JSON.stringify(messages)).toContain("latest question");
    expect(JSON.stringify(messages)).toContain(CHAT_COMPACTION_NOTE);
    expect(JSON.stringify(messages)).toContain("https://example.com/source-0");
  });

  it("does not compact small conversations", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "runtime prefix" },
      user("hi"),
      assistant("hello"),
    ];

    const result = compactChatMessages(messages, 10_000, 3);

    expect(result).toEqual({ compactedMessages: 0, summary: null });
    expect(messages).toHaveLength(3);
  });

  it("summarizes multimodal references without carrying raw payloads", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "runtime prefix" },
      user("ORIGINAL"),
      assistant("ok"),
      {
        role: "user",
        content: [
          { type: "text", text: "inspect media" },
          { type: "image_url", image_url: { url: "file:///tmp/a.png" } },
          { type: "input_audio", input_audio: { data: "base64-audio", format: "wav" } },
        ],
      },
      assistant("media answer"),
      user("new"),
    ];

    const result = compactChatMessages(messages, 40, 1);

    expect(result.compactedMessages).toBeGreaterThan(0);
    expect(JSON.stringify(messages)).toContain("[image:file:///tmp/a.png]");
    expect(JSON.stringify(messages)).toContain("[audio:wav]");
  });
});

