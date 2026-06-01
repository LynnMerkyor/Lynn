import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";
import { runSessions } from "../src/commands/sessions.js";
import { appendSessionLine, appendSessionMetadata, appendSessionTurn } from "../src/session/store.js";

let tmp = "";
const originalDataDir = process.env.LYNN_DATA_DIR;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-cli-sessions-command-"));
  process.env.LYNN_DATA_DIR = tmp;
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.LYNN_DATA_DIR;
  else process.env.LYNN_DATA_DIR = originalDataDir;
});

async function captureStdout(run: () => Promise<number>): Promise<string> {
  const original = process.stdout.write;
  let output = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    await run();
  } finally {
    process.stdout.write = original;
  }
  return output;
}

describe("sessions command", () => {
  it("prints a real code resume command instead of replaying the transcript", async () => {
    const sessionPath = await appendSessionTurn({
      dataDir: tmp,
      cwd: "/repo",
      title: "continue me",
      prompt: "start",
      assistant: "done",
    });

    const output = await captureStdout(() => runSessions(parseArgs(["sessions", "resume", sessionPath]), false));

    expect(output).toContain("Lynn code --resume");
    expect(output).toContain(sessionPath);
    expect(output).not.toContain("[user] start");
  });

  it("prints replay stats from session JSONL usage metadata", async () => {
    let sessionPath = await appendSessionLine({
      dataDir: tmp,
      cwd: "/repo",
      title: "stats",
      line: { type: "user", content: "inspect" },
    });
    sessionPath = await appendSessionLine({
      dataDir: tmp,
      sessionPath,
      cwd: "/repo",
      title: "stats",
      line: { type: "tool", content: "Tool result", data: { name: "read_file" } },
    });
    sessionPath = await appendSessionLine({
      dataDir: tmp,
      sessionPath,
      cwd: "/repo",
      title: "stats",
      line: { type: "assistant", content: "done" },
    });
    await appendSessionMetadata({
      dataDir: tmp,
      sessionPath,
      data: {
        kind: "code_task",
        usageRecords: [
          {
            usage: {
              prompt_tokens: 100,
              completion_tokens: 20,
              total_tokens: 120,
              prompt_cache_hit_tokens: 80,
              prompt_cache_miss_tokens: 20,
            },
            durationMs: 1000,
          },
        ],
        cacheDiagnostics: {
          stablePrefixHash: "prefixaaa",
          stablePrefixChars: 1200,
          stableFrameCount: 2,
          volatileFrameCount: 2,
          resumeMessageCount: 4,
        },
      },
    });

    const output = await captureStdout(() => runSessions(parseArgs(["sessions", "stats", sessionPath]), false));

    expect(output).toContain("Lynn session stats");
    expect(output).toContain("turns: user 1");
    expect(output).toContain("usage: 120 tokens");
    expect(output).toContain("prefix-cache 80 hit (80%)");
    expect(output).toContain("prefixaaa");
    expect(output).toContain("1200 chars");
    expect(output).toContain("2 volatile");
    expect(output).toContain("4 resumed");
    expect(output).toContain("20.0 TPS");
    expect(output).toContain("read_file x1");
  });

  it("renders a replay timeline from session JSONL events", async () => {
    let sessionPath = await appendSessionLine({
      dataDir: tmp,
      cwd: "/repo",
      title: "replay",
      line: { type: "user", content: "inspect this repo", ts: "2026-05-30T01:00:00.000Z" },
    });
    sessionPath = await appendSessionLine({
      dataDir: tmp,
      sessionPath,
      cwd: "/repo",
      title: "replay",
      line: {
        type: "tool",
        content: "Tool result for read_file:\npackage.json contents",
        ts: "2026-05-30T01:00:01.000Z",
        data: { name: "read_file", tool_call_id: "call_1" },
      },
    });
    sessionPath = await appendSessionLine({
      dataDir: tmp,
      sessionPath,
      cwd: "/repo",
      title: "replay",
      line: { type: "assistant", content: "done", ts: "2026-05-30T01:00:02.000Z" },
    });
    await appendSessionMetadata({
      dataDir: tmp,
      sessionPath,
      data: {
        kind: "code_task",
        cwd: "/repo",
        usageRecords: [
          {
            usage: {
              prompt_tokens: 100,
              completion_tokens: 20,
              total_tokens: 120,
              prompt_cache_hit_tokens: 80,
              prompt_cache_miss_tokens: 20,
            },
            durationMs: 1000,
          },
        ],
        cacheDiagnostics: {
          stablePrefixHash: "prefixaaa",
          stablePrefixChars: 1200,
          stableFrameCount: 2,
          volatileFrameCount: 2,
          resumeMessageCount: 4,
        },
      },
    });

    const output = await captureStdout(() => runSessions(parseArgs(["sessions", "replay", sessionPath]), false));

    expect(output).toContain("Lynn session replay");
    expect(output).toContain("01. 01:00:00 user");
    expect(output).toContain("02. 01:00:01 tool read_file");
    expect(output).toContain("tool_call_id call_1");
    expect(output).toContain("03. 01:00:02 assistant");
    expect(output).toContain("metadata code_task");
    expect(output).toContain("usage 120 tokens");
    expect(output).toContain("prefix-cache 80 hit · miss 20 (80%)");
    expect(output).toContain("cache prefix prefixaaa");
    expect(output).toContain("1200 chars");
    expect(output).toContain("2 volatile");
    expect(output).toContain("4 resumed");
    expect(output).toContain("20.0 TPS");
  });

  it("emits structured replay events as JSON", async () => {
    const sessionPath = await appendSessionTurn({
      dataDir: tmp,
      cwd: "/repo",
      title: "json replay",
      prompt: "hello",
      assistant: "hi",
    });

    const output = await captureStdout(() => runSessions(parseArgs(["sessions", "replay", sessionPath]), true));
    const parsed = JSON.parse(output) as { type: string; sessionPath: string; events: Array<{ type: string; label: string; content: string }> };

    expect(parsed.type).toBe("sessions.replay");
    expect(parsed.sessionPath).toBe(sessionPath);
    expect(parsed.events).toHaveLength(2);
    expect(parsed.events[0]).toMatchObject({ type: "user", label: "user", content: "hello" });
    expect(parsed.events[1]).toMatchObject({ type: "assistant", label: "assistant", content: "hi" });
  });
});
