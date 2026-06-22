import { Hono } from "hono";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionsRoute } from "../server/routes/sessions.js";

function makeEngine() {
  const engine = {
    agentsDir: "/tmp/agents",
    currentSessionPath: "/tmp/agents/main/sessions/current.jsonl",
    currentAgentId: "agent-main",
    agentName: "Lynn",
    cwd: "/workspace/main",
    planMode: false,
    securityMode: "authorized",
    memoryEnabled: true,
    memoryModelUnavailableReason: null,
    currentModel: { id: "gpt-5", provider: "openai" },
    config: {},
    messages: [],
    createSession: vi.fn(async () => {}),
    createSessionForAgent: vi.fn(async () => {}),
    persistSessionMeta: vi.fn(),
    updateConfig: vi.fn(async () => {}),
    isSessionStreaming: vi.fn(() => false),
    listSessions: vi.fn(async () => []),
    saveSessionMeta: vi.fn(async () => {}),
    saveSessionTitle: vi.fn(async () => {}),
    closeSession: vi.fn(async () => {}),
  };

  engine.switchSession = vi.fn(async (sessionPath) => {
    engine.currentSessionPath = sessionPath;
    engine.cwd = "/workspace/switched";
    engine.planMode = true;
    engine.securityMode = "safe";
  });

  return engine;
}

describe("sessions route security mode sync", () => {
  let engine;
  let app;

  beforeEach(() => {
    engine = makeEngine();
    app = new Hono();
    app.route("/api", createSessionsRoute(engine));
  });

  it("returns securityMode when creating a session", async () => {
    const res = await app.request("/api/sessions/new", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memoryEnabled: true, cwd: "/workspace/new" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.securityMode).toBe("authorized");
  });

  it("returns securityMode after switching sessions", async () => {
    const res = await app.request("/api/sessions/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/tmp/agents/main/sessions/target.jsonl" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.planMode).toBe(true);
    expect(data.securityMode).toBe("safe");
  });

  it("lists persisted sessions through the engine even when no session is active in memory", async () => {
    engine.currentSessionPath = null;
    engine.listSessions.mockResolvedValueOnce([{
      path: "/tmp/agents/main/sessions/persisted.jsonl",
      title: "Persisted",
      firstMessage: "hello from disk",
      modified: "2026-06-13T00:00:00.000Z",
      messageCount: 2,
      cwd: "/workspace/main",
      agentId: "agent-main",
      agentName: "Lynn",
      modelId: "gpt-5",
      modelProvider: "openai",
      labels: ["pinned"],
    }]);

    const res = await app.request("/api/sessions");

    expect(res.status).toBe(200);
    expect(engine.listSessions).toHaveBeenCalledOnce();
    const data = await res.json();
    expect(data).toEqual([
      expect.objectContaining({
        path: "/tmp/agents/main/sessions/persisted.jsonl",
        firstMessage: "hello from disk",
        messageCount: 2,
        health: expect.objectContaining({ level: "ok" }),
      }),
    ]);
  });

  it("marks large session files in the sessions list without reading their contents", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-session-health-"));
    try {
      const sessionDir = path.join(tmp, "main", "sessions");
      await fs.mkdir(sessionDir, { recursive: true });
      const largePath = path.join(sessionDir, "large.jsonl");
      await fs.writeFile(largePath, "", "utf8");
      await fs.truncate(largePath, 51 * 1024 * 1024);
      engine.agentsDir = tmp;
      engine.listSessions.mockResolvedValueOnce([{
        path: largePath,
        title: "Large",
        firstMessage: "hello",
        modified: "2026-06-13T00:00:00.000Z",
        messageCount: 10,
      }]);

      const res = await app.request("/api/sessions");
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data[0].health).toEqual(expect.objectContaining({
        level: "large",
        reason: "session_file_large_size",
      }));
      expect(data[0].health.sizeBytes).toBeGreaterThanOrEqual(51 * 1024 * 1024);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("branches a session file and returns native topology metadata", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-session-branch-"));
    try {
      const sessionDir = path.join(tmp, "main", "sessions");
      await fs.mkdir(sessionDir, { recursive: true });
      const sourcePath = path.join(sessionDir, "source.jsonl");
      await fs.writeFile(sourcePath, [
        JSON.stringify({ type: "session", version: 3, id: "source", timestamp: "2026-06-22T00:00:00.000Z", cwd: "/workspace/main" }),
        JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-06-22T00:00:01.000Z", message: { role: "user", content: "继续修搜索质量" } }),
        "",
      ].join("\n"), "utf8");
      engine.agentsDir = tmp;
      engine.currentSessionPath = sourcePath;
      engine.cwd = "/workspace/main";

      const res = await app.request("/api/sessions/branch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: sourcePath, branchLabel: "Search quality branch" }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.path).toBeTruthy();
      expect(data.path).not.toBe(sourcePath);
      expect(data.topology).toEqual(expect.objectContaining({
        parentSessionPath: sourcePath,
        rootSessionPath: sourcePath,
        branchLabel: "Search quality branch",
        taskStatus: "active",
      }));
      expect(engine.saveSessionMeta).toHaveBeenCalledWith(data.path, expect.objectContaining({ topology: expect.any(Object) }));
      expect(engine.saveSessionTitle).toHaveBeenCalledWith(data.path, "Search quality branch");
      expect(engine.switchSession).toHaveBeenCalledWith(data.path);
      await expect(fs.readFile(data.path, "utf8")).resolves.toContain("继续修搜索质量");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("updates session digest and insight inbox metadata", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-session-memory-"));
    try {
      const sessionDir = path.join(tmp, "main", "sessions");
      await fs.mkdir(sessionDir, { recursive: true });
      const sessionPath = path.join(sessionDir, "target.jsonl");
      await fs.writeFile(sessionPath, "{}\n", "utf8");
      await fs.writeFile(path.join(sessionDir, "session-meta.json"), JSON.stringify({
        [path.basename(sessionPath)]: {
          digest: { objective: "Old objective" },
          insights: [{ id: "old", content: "old insight", status: "unread" }],
        },
      }), "utf8");
      engine.agentsDir = tmp;

      const digestRes = await app.request("/api/sessions/digest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: sessionPath, digest: { summary: "Fresh digest", nextSteps: ["Open map"] } }),
      });
      expect(digestRes.status).toBe(200);
      expect(await digestRes.json()).toEqual(expect.objectContaining({
        ok: true,
        digest: expect.objectContaining({
          objective: "Old objective",
          summary: "Fresh digest",
          nextSteps: ["Open map"],
        }),
      }));

      const insightRes = await app.request("/api/sessions/insights", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: sessionPath, insight: { id: "new", source: "Hanako", content: "map grew" } }),
      });
      expect(insightRes.status).toBe(200);
      const insightData = await insightRes.json();
      expect(insightData.unread).toBe(2);
      expect(insightData.insights[0]).toEqual(expect.objectContaining({ id: "new", status: "unread" }));

      const consumeRes = await app.request("/api/sessions/insights/consume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: sessionPath, ids: ["old"] }),
      });
      expect(consumeRes.status).toBe(200);
      const consumeData = await consumeRes.json();
      expect(consumeData.insights.find((item) => item.id === "old")).toEqual(expect.objectContaining({ status: "consumed" }));
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("returns a lightweight session map without reading session bodies", async () => {
    engine.listSessions.mockResolvedValueOnce([
      {
        path: "/tmp/agents/main/sessions/root.jsonl",
        title: "Root",
        modified: "2026-06-22T00:00:00.000Z",
        messageCount: 10,
        digest: { objective: "Root goal" },
        insights: [{ id: "i1", content: "handoff", status: "unread" }],
      },
      {
        path: "/tmp/agents/main/sessions/branch.jsonl",
        title: "Branch",
        modified: "2026-06-22T01:00:00.000Z",
        messageCount: 2,
        topology: {
          parentSessionPath: "/tmp/agents/main/sessions/root.jsonl",
          branchLabel: "Branch A",
        },
      },
    ]);

    const res = await app.request("/api/sessions/map");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.nodes).toHaveLength(2);
    expect(data.nodes[0]).toEqual(expect.objectContaining({
      id: "/tmp/agents/main/sessions/root.jsonl",
      digest: expect.objectContaining({ objective: "Root goal" }),
      unreadInsights: 1,
    }));
    expect(data.edges).toEqual([
      expect.objectContaining({
        from: "/tmp/agents/main/sessions/root.jsonl",
        to: "/tmp/agents/main/sessions/branch.jsonl",
        label: "Branch A",
      }),
    ]);
  });
});
