import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  evictSessionCacheEntries,
  listCoordinatorSessions,
  listSessionFileSkeletons,
} from "../core/session-list-cache.js";

describe("session list/cache helpers", () => {
  const dirs = [];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-session-list-cache-"));
    dirs.push(dir);
    return dir;
  }

  it("lists only jsonl session skeletons and ignores sidecars", async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "a.jsonl"), "{}\n");
    fs.writeFileSync(path.join(dir, "session-index.json"), "[]");
    fs.writeFileSync(path.join(dir, "session-meta.json"), "{}");
    fs.writeFileSync(path.join(dir, "notes.txt"), "ignore");

    const sessions = await listSessionFileSkeletons(dir, { id: "agent-a", name: "Agent A" });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      path: path.join(dir, "a.jsonl"),
      title: null,
      agentId: "agent-a",
      agentName: "Agent A",
      messageCount: 0,
      labels: [],
    });
    expect(sessions[0].modified).toBeInstanceOf(Date);
  });

  it("evicts least-recent idle entries without touching focus, current, or streaming sessions", () => {
    const notifySessionEnd = vi.fn();
    const unsubOld = vi.fn();
    const sessions = new Map([
      ["old", { agentId: "a1", lastTouchedAt: 1, session: { isStreaming: false }, unsub: unsubOld }],
      ["focus", { agentId: "a1", lastTouchedAt: 2, session: { isStreaming: false }, unsub: vi.fn() }],
      ["streaming", { agentId: "a1", lastTouchedAt: 3, session: { isStreaming: true }, unsub: vi.fn() }],
      ["current", { agentId: "a1", lastTouchedAt: 4, session: { isStreaming: false }, unsub: vi.fn() }],
    ]);

    const evicted = evictSessionCacheEntries({
      sessions,
      currentKey: "current",
      focusPath: "focus",
      maxSessions: 3,
      getAgentById: (agentId) => ({ id: agentId }),
      getFallbackAgent: () => ({ id: "fallback" }),
      notifySessionEnd,
    });

    expect(evicted).toBe(1);
    expect(sessions.has("old")).toBe(false);
    expect(sessions.has("focus")).toBe(true);
    expect(sessions.has("streaming")).toBe(true);
    expect(sessions.has("current")).toBe(true);
    expect(unsubOld).toHaveBeenCalledTimes(1);
    expect(notifySessionEnd).toHaveBeenCalledWith({ id: "a1" }, "old", "cache eviction");
  });

  it("lists coordinator sessions with an in-flight current session", async () => {
    const root = tempDir();
    const sessionDir = path.join(root, "agent-a", "sessions");
    fs.mkdirSync(sessionDir, { recursive: true });
    const oldPath = path.join(sessionDir, "old.jsonl");
    fs.writeFileSync(oldPath, "{}\n");

    const currentPath = path.join(sessionDir, "current.jsonl");
    const sessions = await listCoordinatorSessions({
      agentsDir: root,
      agents: [{ id: "agent-a", name: "Agent A" }],
      currentPath,
      sessionStarted: true,
      currentSession: { sessionManager: { getCwd: () => "/tmp/workspace" } },
      currentEntry: { modelId: "model-a", modelProvider: "provider-a" },
      activeAgentId: "agent-a",
      activeAgent: { id: "agent-a", agentName: "Agent A" },
    });

    expect(sessions[0]).toMatchObject({
      path: currentPath,
      cwd: "/tmp/workspace",
      modelId: "model-a",
      modelProvider: "provider-a",
    });
    expect(sessions.some((session) => session.path === oldPath)).toBe(true);
  });

  it("merges jsonl files that are missing from an existing session index", async () => {
    const root = tempDir();
    const sessionDir = path.join(root, "agent-a", "sessions");
    fs.mkdirSync(sessionDir, { recursive: true });
    const indexedPath = path.join(sessionDir, "indexed.jsonl");
    const missingPath = path.join(sessionDir, "new-after-index.jsonl");
    fs.writeFileSync(indexedPath, "{}\n");
    fs.writeFileSync(missingPath, "{}\n");
    fs.writeFileSync(path.join(sessionDir, "session-index.json"), JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      sessions: [{
        path: indexedPath,
        title: "Indexed",
        modified: new Date().toISOString(),
        messageCount: 2,
      }],
    }));

    const sessions = await listCoordinatorSessions({
      agentsDir: root,
      agents: [{ id: "agent-a", name: "Agent A" }],
      currentPath: null,
      sessionStarted: false,
      activeAgentId: "agent-a",
      activeAgent: { id: "agent-a", agentName: "Agent A" },
    });

    expect(sessions.map((session) => session.path)).toEqual(expect.arrayContaining([indexedPath, missingPath]));
    const refreshed = JSON.parse(fs.readFileSync(path.join(sessionDir, "session-index.json"), "utf-8"));
    expect(refreshed.sessions.map((session) => session.path)).toEqual(expect.arrayContaining([indexedPath, missingPath]));
  });

  it("keeps the existing session index when directory listing times out", async () => {
    const root = tempDir();
    const sessionDir = path.join(root, "agent-a", "sessions");
    fs.mkdirSync(sessionDir, { recursive: true });
    const indexedPath = path.join(sessionDir, "indexed.jsonl");
    const payload = {
      version: 1,
      updatedAt: new Date().toISOString(),
      sessions: [{
        path: indexedPath,
        title: "Keep me",
        firstMessage: "hello",
        modified: new Date("2026-06-13T00:00:00.000Z").toISOString(),
        messageCount: 2,
        labels: ["important"],
      }],
    };
    fs.writeFileSync(path.join(sessionDir, "session-index.json"), `${JSON.stringify(payload, null, 2)}\n`);
    vi.spyOn(fsp, "readdir").mockImplementationOnce(() => new Promise(() => {}));

    const sessions = await listCoordinatorSessions({
      agentsDir: root,
      agents: [{ id: "agent-a", name: "Agent A" }],
      currentPath: null,
      sessionStarted: false,
      activeAgentId: "agent-a",
      activeAgent: { id: "agent-a", agentName: "Agent A" },
    });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      path: indexedPath,
      title: "Keep me",
      firstMessage: "hello",
      messageCount: 2,
      labels: ["important"],
    });
    const after = JSON.parse(fs.readFileSync(path.join(sessionDir, "session-index.json"), "utf-8"));
    expect(after.sessions).toHaveLength(1);
    expect(after.sessions[0].title).toBe("Keep me");
  }, 2_000);
});
