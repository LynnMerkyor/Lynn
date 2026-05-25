import fsp from "fs/promises";
import path from "path";

export const SESSION_INDEX_FILENAME = "session-index.json";

export interface SessionIndexAgent {
  id?: string | null;
  name?: string | null;
}

export interface SessionIndexOptions {
  agent?: SessionIndexAgent;
}

export interface SessionIndexInput {
  path?: unknown;
  title?: string | null;
  firstMessage?: string;
  modified?: string | number | Date | null;
  messageCount?: number | string | null;
  cwd?: string;
  agentId?: string | null;
  agentName?: string | null;
  modelId?: string | null;
  modelProvider?: string | null;
  pinned?: unknown;
  labels?: unknown;
}

export interface SessionIndexEntry {
  path: string;
  title: string | null;
  firstMessage: string;
  modified: string | null;
  messageCount: number;
  cwd: string;
  agentId: string | null;
  agentName: string | null;
  modelId: string | null;
  modelProvider: string | null;
  pinned: boolean;
  labels: unknown[];
}

export interface SessionIndexPayload {
  version: 1;
  updatedAt: string;
  sessions: SessionIndexEntry[];
}

function toIso(value: string | number | Date | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function normalizeSessionIndexEntry(session: SessionIndexInput | null | undefined, opts: SessionIndexOptions = {}): SessionIndexEntry {
  const agent = opts.agent || {};
  return {
    path: String(session?.path || ""),
    title: session?.title || null,
    firstMessage: session?.firstMessage || "",
    modified: toIso(session?.modified),
    messageCount: Number(session?.messageCount || 0),
    cwd: session?.cwd || "",
    agentId: session?.agentId || agent.id || null,
    agentName: session?.agentName || agent.name || null,
    modelId: session?.modelId || null,
    modelProvider: session?.modelProvider || null,
    pinned: !!session?.pinned,
    labels: Array.isArray(session?.labels) ? session.labels.filter(Boolean) : [],
  };
}

export function sessionIndexPath(sessionDir: string): string {
  return path.join(sessionDir, SESSION_INDEX_FILENAME);
}

export async function readSessionIndex(sessionDir: string): Promise<unknown[]> {
  try {
    const raw = await fsp.readFile(sessionIndexPath(sessionDir), "utf-8");
    const parsed = JSON.parse(raw) as { sessions?: unknown } | null;
    return Array.isArray(parsed?.sessions) ? parsed.sessions : [];
  } catch {
    return [];
  }
}

export async function writeSessionIndex(sessionDir: string, sessions: unknown, opts: SessionIndexOptions = {}): Promise<SessionIndexPayload> {
  const entries = (Array.isArray(sessions) ? sessions : [])
    .map((session) => normalizeSessionIndexEntry(session as SessionIndexInput, opts))
    .filter((entry) => entry.path);
  const payload: SessionIndexPayload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    sessions: entries,
  };
  await fsp.mkdir(sessionDir, { recursive: true });
  const target = sessionIndexPath(sessionDir);
  const tmp = `${target}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  await fsp.rename(tmp, target);
  return payload;
}

export async function refreshSessionIndex(sessionDir: string, sessions: unknown, opts: SessionIndexOptions = {}): Promise<SessionIndexPayload> {
  return writeSessionIndex(sessionDir, sessions, opts);
}
