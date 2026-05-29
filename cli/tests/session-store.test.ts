import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendSessionTurn, listSessions, readSessionLines, sessionIndexPath } from "../src/session/store.js";

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
});
