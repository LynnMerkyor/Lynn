import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendSessionLine, appendSessionMetadata, appendSessionTurn, latestSessionPath, listSessions, readSessionLines, sessionIndexPath } from "../src/session/store.js";

let tmp = "";

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-cli-sessions-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("CLI session store", () => {
  it("writes GUI-compatible CLI agent sessions and index entries", async () => {
    const sessionPath = await appendSessionTurn({
      dataDir: tmp,
      cwd: "/repo",
      title: "hello",
      prompt: "hello",
      assistant: "hi",
      modelProvider: "mock",
      modelId: "mock-brain",
    });

    const lines = await readSessionLines(sessionPath);
    const sessions = await listSessions(tmp);
    const indexRaw = JSON.parse(await fs.readFile(sessionIndexPath(tmp), "utf8")) as { version: number };

    expect(indexRaw.version).toBe(1);
    expect(lines.map((line) => line.type)).toEqual(["user", "assistant"]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.agentId).toBe("cli");
    expect(sessions[0]?.path).toBe(sessionPath);
  });

  it("appends metadata lines for resumable code tasks", async () => {
    const sessionPath = await appendSessionTurn({
      dataDir: tmp,
      cwd: "/repo",
      prompt: "change file",
      assistant: "done",
    });
    await appendSessionMetadata({
      dataDir: tmp,
      sessionPath,
      data: { kind: "code_task", toolCount: 2 },
    });

    const lines = await readSessionLines(sessionPath);
    expect(lines.at(-1)).toMatchObject({ type: "metadata", data: { kind: "code_task", toolCount: 2 } });
  });

  it("updates the session index while appending incremental checkpoint lines", async () => {
    let sessionPath = await appendSessionLine({
      dataDir: tmp,
      cwd: "/repo",
      title: "checkpointed task",
      line: { type: "user", content: "start task" },
      modelProvider: "brain",
      modelId: "lynn-brain-router",
    });
    sessionPath = await appendSessionLine({
      dataDir: tmp,
      sessionPath,
      cwd: "/repo",
      title: "checkpointed task",
      line: { type: "assistant", content: "{\"tool\":\"read_file\"}" },
      modelProvider: "brain",
      modelId: "lynn-brain-router",
    });

    const lines = await readSessionLines(sessionPath);
    const sessions = await listSessions(tmp);

    expect(lines.map((line) => line.type)).toEqual(["user", "assistant"]);
    expect(sessions[0]).toMatchObject({
      path: sessionPath,
      title: "checkpointed task",
      firstMessage: "start task",
      messageCount: 2,
      modelProvider: "brain",
      modelId: "lynn-brain-router",
    });
  });

  it("returns the latest session path from the index", async () => {
    const first = await appendSessionTurn({
      dataDir: tmp,
      cwd: "/repo",
      prompt: "first",
      assistant: "done",
    });
    const second = await appendSessionTurn({
      dataDir: tmp,
      cwd: "/repo",
      prompt: "second",
      assistant: "done",
    });

    expect(first).not.toBe(second);
    await expect(latestSessionPath(tmp)).resolves.toBe(second);
  });

  it("serializes concurrent session index updates", async () => {
    await Promise.all(Array.from({ length: 12 }, (_, index) => appendSessionTurn({
      dataDir: tmp,
      cwd: "/repo",
      prompt: `task ${index}`,
      assistant: "done",
      modelProvider: "mock",
      modelId: "mock-brain",
    })));

    const sessions = await listSessions(tmp);
    const prompts = new Set(sessions.map((session) => session.firstMessage));
    expect(sessions).toHaveLength(12);
    expect(prompts.size).toBe(12);
  });
});
