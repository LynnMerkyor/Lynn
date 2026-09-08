import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import type { RawMcpServerConfig } from "../mcp-client-config.js";
import { fromRoot } from "../../shared/lynn-root.js";

export const KIMI_DATASOURCE_NAME = "plugin-kimi-datasource_data";
export const KIMI_DOCS_URL = "https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/customization/plugins.md#kimi-datasource";
const MAX_SOURCE_BYTES = 1024 * 1024;

function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function readSmall(file: string): Promise<string> {
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) throw new Error("Kimi plugin metadata is too large or is not a file");
    return await handle.readFile("utf8");
  } finally { await handle.close(); }
}

export function kimiHome(value?: string): string {
  return path.resolve((value || process.env.KIMI_CODE_HOME || path.join(os.homedir(), ".kimi-code")).replace(/^~(?=$|[/\\])/, os.homedir()));
}

export interface KimiDatasourceCandidate {
  bundled?: boolean;
  id: string;
  name: string;
  version: string;
  root: string;
  enabledInKimi: boolean;
  config: RawMcpServerConfig;
}

export async function bundledKimiDatasource(home: string): Promise<KimiDatasourceCandidate> {
  const root = fromRoot('lib', 'mcp', 'vendor', 'kimi-datasource');
  const entry = path.join(root, 'kimi-datasource.mjs');
  const script = await readSmall(entry);
  return { bundled: true, id: createHash('sha256').update(home).update(script).digest('hex'), name: KIMI_DATASOURCE_NAME, version: '3.4.0', root, enabledInKimi: true,
    config: { command: process.execPath, args: [entry], cwd: root, env: { KIMI_CODE_HOME: home, ELECTRON_RUN_AS_NODE: '1', LYNN_KIMI_MANAGED: '1' } } };
}

/** Explicit, bounded discovery. No credential reads and no process execution. */
export async function scanKimiDatasource(home?: string): Promise<{ home: string; candidates: KimiDatasourceCandidate[]; diagnostics: string[] }> {
  const rootHome = kimiHome(home);
  const result = { home: rootHome, candidates: [] as KimiDatasourceCandidate[], diagnostics: [] as string[] };
  try {
    const installed = JSON.parse(await readSmall(path.join(rootHome, "plugins", "installed.json")));
    if (!Array.isArray(installed?.plugins)) throw new Error("Invalid Kimi installed.json");
    const records = installed.plugins.filter((p: { id?: string }) => p?.id === "kimi-datasource");
    if (records.length > 1) throw new Error("Duplicate Kimi Datasource installation records");
    for (const record of records) {
      if (typeof record.root !== "string" || !path.isAbsolute(record.root)) throw new Error("Kimi plugin root must be absolute");
      const root = await fs.realpath(record.root);
      let manifestPath = path.join(root, "kimi.plugin.json");
      try { await fs.access(manifestPath); } catch { manifestPath = path.join(root, ".kimi-plugin", "plugin.json"); }
      if (!within(root, await fs.realpath(manifestPath))) throw new Error("Kimi manifest escapes its plugin directory");
      const manifestText = await readSmall(manifestPath);
      const manifest = JSON.parse(manifestText);
      const server = manifest?.mcpServers?.data;
      if (manifest.name !== "kimi-datasource" || server?.command !== "node"
        || JSON.stringify(server.args) !== JSON.stringify(["./bin/kimi-datasource.mjs"])
        || (server.cwd && server.cwd !== "./") || server.env && Object.keys(server.env).length) {
        throw new Error("Unsupported Kimi Datasource manifest; update Kimi Code or configure this MCP manually");
      }
      const entry = await fs.realpath(path.join(root, "bin", "kimi-datasource.mjs"));
      if (!within(root, entry)) throw new Error("Kimi entry point escapes its plugin directory");
      const script = await readSmall(entry);
      const id = createHash("sha256").update(rootHome).update(root).update(manifestText).update(script).digest("hex");
      result.candidates.push({
        id, name: KIMI_DATASOURCE_NAME, version: String(manifest.version || ""), root,
        enabledInKimi: record.enabled !== false && record.capabilities?.mcpServers?.data?.enabled !== false,
        config: { transport: "stdio", command: process.execPath, args: [entry], cwd: root,
          env: { KIMI_CODE_HOME: rootHome, KIMI_PLUGIN_ROOT: root, ELECTRON_RUN_AS_NODE: "1" } },
      });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") result.diagnostics.push((error as Error).message);
  }
  return result;
}

export interface KimiLoginState {
  id: string;
  status: "idle" | "waiting" | "complete" | "failed" | "cancelled";
  url?: string;
  code?: string;
  error?: string;
}

export function parseKimiLoginOutput(output: string): { url?: string; code?: string } {
  const clean = output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
  const urls = clean.match(/https:\/\/[^\s<>"']+/g) || [];
  const url = urls.find((value) => {
    try { const u = new URL(value); return !u.username && !u.password && ["auth.kimi.com", "auth.kimi.ai", "www.kimi.com", "www.kimi.ai", "kimi.com", "kimi.ai"].includes(u.hostname); }
    catch { return false; }
  });
  const code = clean.match(/enter code:\s*([a-zA-Z0-9-]{4,32})/i)?.[1];
  return { ...(url ? { url } : {}), ...(code ? { code } : {}) };
}

