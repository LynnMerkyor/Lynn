import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../src/brain-client.js";
import { applyChatRewindState, beginChatRewindTurn, createChatRewindState, maybeRecordChatRewindSnapshot, parseChatRewindCommand, renderChatRewind } from "../src/chat-rewind.js";
import type { CodeToolRequest } from "../src/code-tool-protocol.js";

describe("chat rewind", () => {
  it("restores only files touched by chat tools and trims in-memory messages", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-chat-rewind-"));
    await fs.writeFile(path.join(cwd, "a.txt"), "A0", "utf8");
    await fs.writeFile(path.join(cwd, "busy.bin"), "external-v1", "utf8");
    const messages: ChatMessage[] = [
      { role: "system", content: "runtime" },
    ];
    const state = createChatRewindState();
    const checkpoint = beginChatRewindTurn(state, "edit a", messages.length);
    messages.push({ role: "user", content: "edit a" });
    maybeRecordChatRewindSnapshot(state, cwd, writeFileRequest("a.txt", "A1"));
    await fs.writeFile(path.join(cwd, "a.txt"), "A1", "utf8");
    await fs.writeFile(path.join(cwd, "busy.bin"), "external-v2", "utf8");
    messages.push({ role: "assistant", content: "done" });
    expect(checkpoint.snapshot?.entries).toBe(1);

    const result = applyChatRewindState(state, 1, messages, cwd);

    await expect(fs.readFile(path.join(cwd, "a.txt"), "utf8")).resolves.toBe("A0");
    await expect(fs.readFile(path.join(cwd, "busy.bin"), "utf8")).resolves.toBe("external-v2");
    expect(result.messageCount).toBe(1);
    expect(messages).toHaveLength(1);
    expect(state.checkpoints).toHaveLength(0);
  });

  it("previews checkpoints and parses apply", () => {
    const state = createChatRewindState();
    beginChatRewindTurn(state, "first task", 1);
    beginChatRewindTurn(state, "second task", 3);

    expect(parseChatRewindCommand("/rewind 2 --apply")).toEqual({ ordinal: 2, apply: true });
    expect(renderChatRewind(state, { ordinal: null, apply: false }, false)).toContain("second task");
    expect(renderChatRewind(state, { ordinal: 1, apply: false }, false)).toContain("Preview chat rewind #1");
  });
});

function writeFileRequest(file: string, content: string): CodeToolRequest {
  return {
    tool: "write_file",
    args: { path: file, content },
    raw: "",
    index: 0,
    fingerprint: `write:${file}`,
  } as CodeToolRequest;
}
