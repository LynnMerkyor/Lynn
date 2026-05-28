import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  evictSessionCacheEntries,
  listSessionFileSkeletons,
} from "../core/session-list-cache.js";

describe("session list/cache helpers", () => {
  const dirs = [];

  afterEach(() => {
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
});
