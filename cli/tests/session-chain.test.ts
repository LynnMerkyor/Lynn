import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendSessionLine,
  appendSessionTurn,
  forkSession,
  readSessionLines,
} from "../src/session/store.js";

let tmp = "";

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-chain-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("session chain", () => {
  it("links each appended line to the previous one", async () => {
    const dataDir = path.join(tmp, "data");
    const sessionPath = path.join(dataDir, "s.jsonl");
    await appendSessionLine({ dataDir, sessionPath, cwd: tmp, line: { type: "user", content: "one" } });
    await appendSessionLine({ dataDir, sessionPath, cwd: tmp, line: { type: "assistant", content: "two" } });
    await appendSessionLine({ dataDir, sessionPath, cwd: tmp, line: { type: "tool", content: "three", data: { tool_call_id: "c1", name: "read_file" } } });

    const lines = await readSessionLines(sessionPath);
    expect(lines).toHaveLength(3);
    expect(lines[0]!.uuid).toBeTruthy();
    expect(lines[0]!.parentUuid ?? null).toBeNull();
    expect(lines[1]!.parentUuid).toBe(lines[0]!.uuid);
    expect(lines[2]!.parentUuid).toBe(lines[1]!.uuid);
  });

  it("honours an explicit parent (used after compaction/clear)", async () => {
    const dataDir = path.join(tmp, "data");
    const sessionPath = path.join(dataDir, "s.jsonl");
    await appendSessionLine({ dataDir, sessionPath, cwd: tmp, line: { type: "user", content: "root" } });
    await appendSessionLine({
      dataDir,
      sessionPath,
      cwd: tmp,
      line: { type: "user", content: "branch", parentUuid: null, uuid: "fixed-uuid" },
    });
    const lines = await readSessionLines(sessionPath);
    expect(lines[1]).toMatchObject({ uuid: "fixed-uuid", parentUuid: null });
  });

  it("chains the two lines written by appendSessionTurn", async () => {
    const dataDir = path.join(tmp, "data");
    const sessionPath = await appendSessionTurn({ dataDir, cwd: tmp, prompt: "hello", assistant: "hi" });
    const lines = await readSessionLines(sessionPath);
    expect(lines).toHaveLength(2);
    expect(lines[1]!.parentUuid).toBe(lines[0]!.uuid);
  });

  it("forks with fresh uuids and preserves the shape", async () => {
    const dataDir = path.join(tmp, "data");
    const source = path.join(dataDir, "source.jsonl");
    await appendSessionLine({ dataDir, sessionPath: source, cwd: tmp, line: { type: "user", content: "root" } });
    await appendSessionLine({ dataDir, sessionPath: source, cwd: tmp, line: { type: "assistant", content: "answer" } });
    const before = await readSessionLines(source);

    const forked = await forkSession({ dataDir, sourcePath: source });
    const after = await readSessionLines(forked.path);
    expect(forked.lines).toBe(2);
    expect(after).toHaveLength(3);
    expect(after[2]!.data).toMatchObject({ kind: "session_fork", forkedFrom: source });
    expect(after[0]!.content).toBe("root");
    expect(after[0]!.uuid).not.toBe(before[0]!.uuid);
    expect(after[1]!.parentUuid).toBe(after[0]!.uuid);

    const metadata = await readSessionLines(source).then((lines) => lines.length);
    expect(metadata).toBe(2); // source is untouched
  });
});
