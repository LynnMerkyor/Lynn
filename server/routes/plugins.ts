import { Hono } from "hono";
import type { Context } from "hono";

function createSubRequest(c: Context, pluginId: string): Request {
  const url = new URL(c.req.url);
  const prefix = `/plugins/${pluginId}`;
  const prefixIndex = url.pathname.indexOf(prefix);
  const subPath = prefixIndex !== -1
    ? url.pathname.slice(prefixIndex + prefix.length) || "/"
    : "/";
  url.pathname = subPath;

  return new Request(url.toString(), {
    method: c.req.method,
    headers: c.req.raw.headers,
    body: c.req.method !== "GET" && c.req.method !== "HEAD"
      ? c.req.raw.body
      : undefined,
  });
}

/**
 * Create a catch-all Hono route that proxies /plugins/:pluginId/* to the
 * corresponding plugin sub-app in routeRegistry.
 *
 * Mount example (server entry):
 *   app.route("/api", createPluginProxyRoute(pluginManager.routeRegistry));
 */
export function createPluginProxyRoute(routeRegistry: Map<string, Hono>): Hono {
  const route = new Hono();

  route.all("/plugins/:pluginId", async (c) => {
    const pluginId = c.req.param("pluginId");
    const pluginApp = routeRegistry.get(pluginId);
    if (!pluginApp) {
      return c.json({ error: `Plugin "${pluginId}" not found` }, 404);
    }
    return pluginApp.fetch(createSubRequest(c, pluginId));
  });

  route.all("/plugins/:pluginId/*", async (c) => {
    const pluginId = c.req.param("pluginId");
    const pluginApp = routeRegistry.get(pluginId);
    if (!pluginApp) {
      return c.json({ error: `Plugin "${pluginId}" not found` }, 404);
    }
    return pluginApp.fetch(createSubRequest(c, pluginId));
  });

  return route;
}

type PluginInfo = {
  id: string;
  name?: string;
  version?: string;
  description?: string;
  status?: string;
  contributions?: unknown;
  error?: unknown;
};

type PluginManager = {
  routeRegistry: Map<string, Hono>;
  listPlugins(): PluginInfo[];
  getAllConfigSchemas(): unknown[];
  getConfigSchema(id: string): unknown;
};

interface PluginsRouteEngine {
  pluginManager?: PluginManager | null;
}

/**
 * Plugin management REST API + route proxy (combined).
 * Provides:
 *   GET  /plugins              — list all plugins
 *   GET  /plugins/config-schemas — all config schemas
 *   GET  /plugins/:id/config-schema — single plugin config schema
 *   ALL  /plugins/:pluginId/*  — proxy to plugin sub-app
 */
export function createPluginsRoute(engine: PluginsRouteEngine): Hono {
  const route = new Hono();

  route.get("/plugins", (c) => {
    const pm = engine.pluginManager;
    if (!pm) return c.json([]);
    const plugins = pm.listPlugins().map((p) => ({
      id: p.id,
      name: p.name,
      version: p.version,
      description: p.description,
      status: p.status,
      contributions: p.contributions,
      error: p.error || null,
    }));
    return c.json(plugins);
  });

  route.get("/plugins/config-schemas", (c) => {
    const pm = engine.pluginManager;
    return c.json(pm?.getAllConfigSchemas() || []);
  });

  route.get("/plugins/:id/config-schema", (c) => {
    const pm = engine.pluginManager;
    const schema = pm?.getConfigSchema(c.req.param("id"));
    if (!schema) return c.json({ error: "not found" }, 404);
    return c.json(schema);
  });

  route.all("/plugins/:pluginId", async (c) => {
    const pluginId = c.req.param("pluginId");
    const pluginApp = engine.pluginManager?.routeRegistry.get(pluginId);
    if (!pluginApp) return c.json({ error: `Plugin "${pluginId}" not found` }, 404);
    return pluginApp.fetch(createSubRequest(c, pluginId));
  });

  route.all("/plugins/:pluginId/*", async (c) => {
    const pluginId = c.req.param("pluginId");
    const pluginApp = engine.pluginManager?.routeRegistry.get(pluginId);
    if (!pluginApp) return c.json({ error: `Plugin "${pluginId}" not found` }, 404);
    return pluginApp.fetch(createSubRequest(c, pluginId));
  });

  return route;
}
