import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SESSION_INDEX_FILENAME,
  normalizeSessionIndexEntry,
  readSessionIndex,
  writeSessionIndex,
} from "../core/session-index.js";
import { saveSessionMetaFile } from "../core/session-title-meta.js";

describe("session index sidecar", () => {
  const dirs = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-session-index-"));
    dirs.push(dir);
    return dir;
  }

  it("normalizes session metadata for indexing", () => {
    const entry = normalizeSessionIndexEntry({
      path: "/tmp/s1.jsonl",
      title: "Title",
      modified: new Date("2026-04-30T00:00:00.000Z"),
      messageCount: 3,
      labels: ["pinned", ""],
      topology: {
        parentSessionPath: "/tmp/root.jsonl",
        branchLabel: "V0.85.1 memory",
        taskStatus: "paused",
      },
      digest: {
        objective: "Stabilize memory map",
        summary: "Digest should index with sessions.",
      },
      insights: [{ id: "i1", content: "Carry this to the branch.", status: "unread" }],
    }, { agent: { id: "a1", name: "Agent One" } });

    expect(entry).toMatchObject({
      path: "/tmp/s1.jsonl",
      title: "Title",
      modified: "2026-04-30T00:00:00.000Z",
      messageCount: 3,
      agentId: "a1",
      agentName: "Agent One",
      labels: ["pinned"],
      topology: {
        parentSessionPath: "/tmp/root.jsonl",
        branchLabel: "V0.85.1 memory",
        taskStatus: "paused",
      },
      digest: {
        objective: "Stabilize memory map",
      },
      insights: [expect.objectContaining({ id: "i1", status: "unread" })],
    });
  });

  it("writes and reads an atomic JSON sidecar", async () => {
    const dir = tempDir();
    await writeSessionIndex(dir, [{
      path: "/tmp/s1.jsonl",
      title: "One",
      modified: "2026-04-30T01:00:00.000Z",
      pinned: true,
      topology: { branchLabel: "release", status: "completed" },
    }], { agent: { id: "agent-a", name: "Agent A" } });

    const filePath = path.join(dir, SESSION_INDEX_FILENAME);
    expect(fs.existsSync(filePath)).toBe(true);
    const sessions = await readSessionIndex(dir);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      path: "/tmp/s1.jsonl",
      title: "One",
      agentId: "agent-a",
      pinned: true,
      topology: {
        branchLabel: "release",
        taskStatus: "completed",
      },
    });
  });

  it("syncs topology metadata into basename/full-path meta entries and the session index", async () => {
    const root = tempDir();
    const sessionDir = path.join(root, "agent-a", "sessions");
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionPath = path.join(sessionDir, "one.jsonl");
    fs.writeFileSync(sessionPath, "{}\n");

    await writeSessionIndex(sessionDir, [{
      path: sessionPath,
      title: "One",
      modified: "2026-04-30T01:00:00.000Z",
    }], { agent: { id: "agent-a", name: "Agent A" } });

    await saveSessionMetaFile(sessionPath, {
      pinned: true,
      labels: ["release", ""],
      topology: { branchLabel: "V0.85.1", status: "paused" },
      digest: { objective: "Map-first right rail", nextSteps: ["Wire GUI"] },
      insights: [{ id: "audit-1", content: "Audit result", status: "unread" }],
    }, {
      agentsDir: root,
      currentAgent: { sessionDir },
      agentIdFromSessionPath: () => "agent-a",
    });

    const meta = JSON.parse(fs.readFileSync(path.join(sessionDir, "session-meta.json"), "utf-8"));
    expect(meta[path.basename(sessionPath)]).toMatchObject({ pinned: true });
    expect(meta[sessionPath]).toMatchObject({ pinned: true });

    const sessions = await readSessionIndex(sessionDir);
    expect(sessions[0]).toMatchObject({
      path: sessionPath,
      pinned: true,
      labels: ["release"],
      topology: {
        branchLabel: "V0.85.1",
        taskStatus: "paused",
      },
      digest: {
        objective: "Map-first right rail",
        nextSteps: ["Wire GUI"],
      },
      insights: [expect.objectContaining({ id: "audit-1", status: "unread" })],
    });
  });
});
