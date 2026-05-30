import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendMemoryEntry,
  buildMemoryContextFrameSync,
  forgetMemoryEntry,
  formatMemoryList,
  handleMemorySlashCommand,
  memoryFilePath,
  readMemoryEntries,
  selectMemoryEntries,
} from "../src/session/memory.js";

let tmp = "";

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-cli-memory-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("CLI durable memory ledger", () => {
  it("stores memory under the CLI agent scope", async () => {
    const entry = await appendMemoryEntry({ dataDir: tmp, text: "Always answer release notes in Chinese." });
    const entries = await readMemoryEntries(tmp);

    expect(memoryFilePath(tmp)).toContain(path.join("agents", "cli", "memory.jsonl"));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: entry.id, kind: "constraint", text: "Always answer release notes in Chinese." });
  });

  it("selects relevant memories without exposing every old turn", async () => {
    await appendMemoryEntry({ dataDir: tmp, text: "Use StepFun 3.7 Flash as the fast text head route.", kind: "decision" });
    await appendMemoryEntry({ dataDir: tmp, text: "Archive old screenshots after release.", kind: "todo" });

    const selected = selectMemoryEntries(await readMemoryEntries(tmp), "which model route should the CLI use", 1);

    expect(selected[0]?.text).toContain("StepFun 3.7 Flash");
  });

  it("formats a protected memory frame for runtime context", async () => {
    await appendMemoryEntry({ dataDir: tmp, text: "Do not show anxious context-window warnings.", kind: "constraint" });

    const frame = buildMemoryContextFrameSync(tmp, "context window");

    expect(frame).toContain("<lynn_memory");
    expect(frame).toContain("只作为背景参考");
    expect(frame).toContain("Do not show anxious context-window warnings.");
  });

  it("handles slash add/list/forget commands", async () => {
    const added = await handleMemorySlashCommand("/memory add 默认不要显示上下文焦虑提示", tmp);
    const listed = await handleMemorySlashCommand("/memory", tmp);
    const id = (await readMemoryEntries(tmp))[0]!.id.slice(0, 8);
    const forgotten = await handleMemorySlashCommand(`/memory forget ${id}`, tmp);

    expect(added).toMatchObject({ handled: true, changed: true });
    expect(listed?.message).toContain("默认不要显示上下文焦虑提示");
    expect(forgotten).toMatchObject({ handled: true, changed: true });
    expect(formatMemoryList(await readMemoryEntries(tmp))).toContain("暂无已保存记忆");
  });

  it("forgets by id prefix", async () => {
    const entry = await appendMemoryEntry({ dataDir: tmp, text: "Prefer quiet compaction." });

    const removed = await forgetMemoryEntry(tmp, entry.id.slice(0, 10));

    expect(removed?.id).toBe(entry.id);
    expect(await readMemoryEntries(tmp)).toHaveLength(0);
  });
});
