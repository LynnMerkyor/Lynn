import { Hono } from "hono";
import QRCode from "qrcode";
import { safeJson } from "../hono-helpers.js";
import path from 'node:path';
import { bundledKimiDatasource, scanKimiDatasource } from "../../lib/mcp/kimi-datasource.js";
import { KimiDeviceLogin } from '../../lib/mcp/kimi-device-auth.js';
import type { RawMcpServerConfig } from "../../lib/mcp-client-config.js";

export function createKimiDatasourceRoute(getManager: () => { saveServer(name: string, config: RawMcpServerConfig): unknown | Promise<unknown>; reload(): unknown | Promise<unknown> } | null, managedHome?: string) {
  const route = new Hono();
  const localHome = managedHome || path.join(process.env.LYNN_HOME || process.cwd(), 'user', 'kimi-datasource');
  const login = new KimiDeviceLogin(async () => {
    const manager = getManager();
    if (!manager) throw new Error('Signed in, but the MCP manager is unavailable. Enable Kimi Datasource when the server is ready.');
    const candidate = await bundledKimiDatasource(localHome);
    await manager.saveServer(candidate.name, candidate.config);
  });
  route.get('/mcp/kimi/catalog', async c => c.json({ candidates: [await bundledKimiDatasource(localHome)] }));
  route.post("/mcp/kimi/scan", async (c) => {
    const body = await safeJson<{ home?: string }>(c);
    if (body?.home !== undefined && typeof body.home !== "string") return c.json({ error: "Invalid Kimi home" }, 400);
    const scan = await scanKimiDatasource(body?.home);
    return c.json({ ...scan, candidates: [await bundledKimiDatasource(localHome), ...scan.candidates] });
  });
  route.post("/mcp/kimi/import", async (c) => {
    const manager = getManager();
    if (!manager) return c.json({ error: "MCP manager unavailable" }, 503);
    const body = await safeJson<{ home?: string; id?: string }>(c);
    if (!body?.id || (body.home !== undefined && typeof body.home !== "string")) return c.json({ error: "Scan Kimi Datasource first" }, 400);
    const scan = await scanKimiDatasource(body.home);
    const candidate = [await bundledKimiDatasource(localHome), ...scan.candidates].find(item => item.id === body.id);
    if (!candidate) return c.json({ error: "Kimi plugin changed or is unavailable. Scan again before enabling." }, 409);
    try { return c.json({ ok: true, server: await manager.saveServer(candidate.name, candidate.config) }); }
    catch (error) { return c.json({ error: (error as Error).message }, 400); }
  });
  route.post("/mcp/kimi/login", async (c) => {
    const body = await safeJson<{ home?: string }>(c);
    if (body?.home !== undefined && typeof body.home !== "string") return c.json({ error: "Invalid Kimi home" }, 400);
    try { return c.json(await login.start(localHome)); }
    catch (error) { return c.json({ error: (error as Error).message }, 400); }
  });
  route.get("/mcp/kimi/login", async (c) => {
    c.header("Cache-Control", "no-store");
    const state = login.getState();
    const qr = state.url ? await QRCode.toDataURL(state.url, { width: 220, margin: 2 }) : undefined;
    return c.json({ ...state, qr });
  });
  route.delete("/mcp/kimi/login", (c) => c.json(login.cancel()));
  return route;
}
