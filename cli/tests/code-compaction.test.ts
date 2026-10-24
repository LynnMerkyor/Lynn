import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildBoundaryMessage,
  compactConversation,
  conversationCost,
  extractSummary,
  groupConversation,
  refreshRecentFilesMessage,
  shouldCompact,
} from "../src/code-compaction.js";
import type { ChatMessage } from "../src/brain-client.js";
import { readFileTool } from "../src/tools/read-file.js";
import { clearReadState } from "../src/tools/read-state.js";

let tmp = "";

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-compact-"));
  clearReadState();
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
  clearReadState();
});

function turn(index: number): ChatMessage[] {
  return [
    { role: "user", content: `user ${index} ${"u".repeat(400)}` },
    { role: "assistant", content: `assistant ${index} ${"a".repeat(400)}` },
  ];
}

describe("compaction", () => {
  it("groups assistant tool calls with their results", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } },
          { id: "c2", type: "function", function: { name: "glob", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "c1", name: "read_file", content: "a" },
      { role: "tool", tool_call_id: "c2", name: "glob", content: "b" },
      { role: "assistant", content: "done" },
    ];
    const groups = groupConversation(messages);
    expect(groups).toHaveLength(3);
    expect(groups[1]).toHaveLength(3);
  });

  it("extracts a summary block and falls back to raw text", () => {
    expect(extractSummary("noise <summary>kept</summary> tail")).toBe("kept");
    expect(extractSummary("plain text")).toBe("plain text");
  });

  it("reports whether the conversation is over budget", () => {
    const small = turn(1);
    expect(shouldCompact(small, 1_000_000)).toBe(false);
    expect(shouldCompact(small, 10)).toBe(true);
    expect(conversationCost(small)).toBeGreaterThan(800);
  });

  it("compacts with a model summary, keeps recent turns, and adds a boundary", async () => {
    const messages: ChatMessage[] = [{ role: "system", content: "SYSTEM" }];
    for (let index = 0; index < 12; index += 1) messages.push(...turn(index));

    const outcome = await compactConversation({
      messages,
      keepGroups: 3,
      maxChars: 1_000,
      anchorCount: 1,
      cwd: tmp,
      runId: "run-1",
      complete: async () => "<summary>1. Intent: demo\n6. All user messages: go</summary>",
    });

    expect(outcome).toBeTruthy();
    expect(outcome!.summary).toContain("Intent: demo");
    expect(outcome!.compactedCount).toBeGreaterThan(10);
    const [system, boundary, ...rest] = outcome!.messages;
    expect(system).toMatchObject({ role: "system", content: "SYSTEM" });
    expect(boundary).toMatchObject({ role: "user" });
    expect(String(boundary.content)).toContain("lynn-compaction-boundary");
    expect(String(boundary.content)).toContain("Intent: demo");
    expect(rest.length).toBeLessThan(messages.length);
    expect(rest.some((message) => String(message.content).includes("user 11"))).toBe(true);
    expect(String(boundary.content)).toContain('run="run-1"');
  });

  it("returns null when nothing needs compacting", async () => {
    const outcome = await compactConversation({
      messages: turn(1),
      maxChars: 1_000_000,
      cwd: tmp,
      runId: "run-2",
      complete: async () => "<summary>x</summary>",
    });
    expect(outcome).toBeNull();
  });

  it("refreshes the most recently read files after compaction", async () => {
    await fs.writeFile(path.join(tmp, "a.ts"), "export const a = 1;\n", "utf8");
    await readFileTool({ cwd: tmp, approval: "ask" }, "a.ts");
    const message = await refreshRecentFilesMessage(tmp);
    expect(message).toBeTruthy();
    expect(String(message!.content)).toContain('<file path="a.ts">');
    expect(String(message!.content)).toContain("export const a = 1;");
  });

  it("builds a boundary that tells the model to re-read rather than trust memory", () => {
    const boundary = buildBoundaryMessage({ before: 42, after: 9, summary: "S", runId: "r" });
    expect(String(boundary.content)).toContain("messages=\"42->9\"");
    expect(String(boundary.content)).toContain("read the file again");
  });
});
