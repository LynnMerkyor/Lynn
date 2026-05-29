import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface LocalServerInfo {
  pid?: number;
  port: number;
  token?: string;
  version?: string;
}

export interface LocalServerLookup {
  status: "ok" | "missing" | "stale" | "invalid" | "unreachable";
  url?: string;
  token?: string;
  version?: string;
  message?: string;
}

export function resolveLynnHome(dataDir?: string | null): string {
  const raw = dataDir || process.env.LYNN_HOME || process.env.HANA_HOME || path.join(os.homedir(), ".lynn");
  return path.resolve(raw.replace(/^~/, os.homedir()));
}

export async function readLocalServerInfo(dataDir?: string | null): Promise<LocalServerLookup> {
  const file = path.join(resolveLynnHome(dataDir), "server-info.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : "";
    return code === "ENOENT"
      ? { status: "missing", message: "Lynn GUI server-info.json not found" }
      : { status: "invalid", message: error instanceof Error ? error.message : String(error) };
  }

  if (!parsed || typeof parsed !== "object") return { status: "invalid", message: "server-info.json is not an object" };
  const info = parsed as Partial<LocalServerInfo>;
  const port = Number(info.port);
  if (!Number.isInteger(port) || port <= 0) return { status: "invalid", message: "server-info.json has no valid port" };

  const pid = Number(info.pid);
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 0);
    } catch {
      return { status: "stale", url: `http://127.0.0.1:${port}`, version: info.version, message: `server pid ${pid} is not running` };
    }
  }

  return {
    status: "ok",
    url: `http://127.0.0.1:${port}`,
    token: typeof info.token === "string" ? info.token : undefined,
    version: typeof info.version === "string" ? info.version : undefined,
  };
}

export async function fetchLocalServerJson<T>(
  lookup: LocalServerLookup,
  apiPath: string,
  timeoutMs = 1500,
): Promise<T> {
  if (lookup.status !== "ok" || !lookup.url) {
    throw new Error(lookup.message || `local server ${lookup.status}`);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {};
    if (lookup.token) headers.Authorization = `Bearer ${lookup.token}`;
    const res = await fetch(new URL(apiPath, lookup.url), { headers, signal: ctrl.signal });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`.trim());
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}
