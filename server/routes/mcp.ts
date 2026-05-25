import { Hono } from "hono";
import { safeJson } from "../hono-helpers.js";
import { createDefaultMcpServerTemplate } from "../../lib/mcp-client.js";

type McpRouteBody = {
  name?: string;
  config?: unknown;
  transport?: string;
  sessionPath?: string;
  serverName?: string;
};

type McpManagerLike = {
  listServerStates(): unknown;
  listBuiltinStates(): unknown;
  saveServer(name: string, config: unknown): unknown | Promise<unknown>;
  deleteServer(name: string): unknown | Promise<unknown>;
  testServerConfig(name: string, config: unknown): unknown | Promise<unknown>;
  saveBuiltinCredentials(name: string, credentials: Record<string, unknown>): unknown | Promise<unknown>;
  testBuiltinServer(name: string, credentials: Record<string, unknown>): unknown | Promise<unknown>;
  reload(): unknown | Promise<unknown>;
};

type McpRouteEngine = {
  mcpManager?: McpManagerLike | null;
  currentSessionPath?: string | null;
  getSessionActiveMcp?: (sessionPath: string) => unknown;
  activateMcpServer?: (sessionPath: string, serverName: string) => unknown;
  deactivateMcpServer?: (sessionPath: string, serverName: string) => unknown;
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function getManager(engine: McpRouteEngine): McpManagerLike | null {
  return engine.mcpManager || null;
}

export function createMcpRoute(engine: McpRouteEngine): Hono {
  const route = new Hono();

  route.get("/mcp/servers", async (c) => {
    const manager = getManager(engine);
    if (!manager) {
      return c.json({ servers: [], ok: false, error: "MCP manager unavailable" }, 503);
    }
    return c.json({ ok: true, servers: manager.listServerStates() });
  });

  route.get("/mcp/builtin", async (c) => {
    const manager = getManager(engine);
    if (!manager) {
      return c.json({ builtin: [], ok: false, error: "MCP manager unavailable" }, 503);
    }
    return c.json({ ok: true, builtin: manager.listBuiltinStates() });
  });

  route.post("/mcp/servers", async (c) => {
    const manager = getManager(engine);
    if (!manager) {
      return c.json({ error: "MCP manager unavailable" }, 503);
    }
    const body = await safeJson<McpRouteBody>(c);
    const name = String(body?.name || "").trim();
    const config = body?.config || createDefaultMcpServerTemplate(body?.transport === "sse" ? "sse" : "stdio");
    if (!name) return c.json({ error: "name is required" }, 400);

    try {
      const server = await manager.saveServer(name, config);
      return c.json({ ok: true, server });
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 400);
    }
  });

  route.delete("/mcp/servers/:name", async (c) => {
    const manager = getManager(engine);
    if (!manager) {
      return c.json({ error: "MCP manager unavailable" }, 503);
    }
    const name = c.req.param("name");
    try {
      await manager.deleteServer(name);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 400);
    }
  });

  route.post("/mcp/test", async (c) => {
    const manager = getManager(engine);
    if (!manager) {
      return c.json({ error: "MCP manager unavailable" }, 503);
    }
    const body = await safeJson<McpRouteBody>(c);
    const name = String(body?.name || "test").trim() || "test";
    const config = body?.config || createDefaultMcpServerTemplate(body?.transport === "sse" ? "sse" : "stdio");

    try {
      const result = await manager.testServerConfig(name, config);
      return c.json(result);
    } catch (err) {
      return c.json({ ok: false, error: errorMessage(err) }, 400);
    }
  });

  route.post("/mcp/builtin/:name", async (c) => {
    const manager = getManager(engine);
    if (!manager) {
      return c.json({ error: "MCP manager unavailable" }, 503);
    }
    const name = c.req.param("name");
    const body = await safeJson<Record<string, unknown>>(c);
    try {
      const builtin = await manager.saveBuiltinCredentials(name, body || {});
      return c.json({ ok: true, builtin });
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 400);
    }
  });

  route.post("/mcp/builtin/:name/test", async (c) => {
    const manager = getManager(engine);
    if (!manager) {
      return c.json({ error: "MCP manager unavailable" }, 503);
    }
    const name = c.req.param("name");
    const body = await safeJson<Record<string, unknown>>(c);
    try {
      const result = await manager.testBuiltinServer(name, body || {});
      return c.json(result);
    } catch (err) {
      return c.json({ ok: false, error: errorMessage(err) }, 400);
    }
  });

  // [2026-04-17] Session-level MCP activation
  route.get("/mcp/session-active", async (c) => {
    const sessionPath = c.req.query("sessionPath") || engine.currentSessionPath || "";
    const active = engine.getSessionActiveMcp?.(sessionPath) || [];
    return c.json({ ok: true, sessionPath, active });
  });

  route.post("/mcp/session-activate", async (c) => {
    const body = await safeJson<McpRouteBody>(c);
    const sessionPath = (body?.sessionPath || engine.currentSessionPath || "").trim();
    const serverName = String(body?.serverName || "").trim();
    if (!sessionPath || !serverName) return c.json({ error: "missing sessionPath or serverName" }, 400);
    const ok = engine.activateMcpServer?.(sessionPath, serverName);
    if (!ok) return c.json({ error: "session or engine not ready" }, 400);
    return c.json({ ok: true, active: engine.getSessionActiveMcp!(sessionPath) });
  });

  route.post("/mcp/session-deactivate", async (c) => {
    const body = await safeJson<McpRouteBody>(c);
    const sessionPath = (body?.sessionPath || engine.currentSessionPath || "").trim();
    const serverName = String(body?.serverName || "").trim();
    if (!sessionPath || !serverName) return c.json({ error: "missing sessionPath or serverName" }, 400);
    const ok = engine.deactivateMcpServer?.(sessionPath, serverName);
    return c.json({ ok: !!ok, active: engine.getSessionActiveMcp?.(sessionPath) || [] });
  });

  route.post("/mcp/reload", async (c) => {
    const manager = getManager(engine);
    if (!manager) {
      return c.json({ error: "MCP manager unavailable" }, 503);
    }
    try {
      await manager.reload();
      return c.json({ ok: true, servers: manager.listServerStates() });
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 500);
    }
  });

  return route;
}
