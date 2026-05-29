import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const CLI_AGENT_ID = "cli";
export const SESSION_INDEX_FILENAME = "session-index.json";

export interface CliSessionLine {
  type: "user" | "assistant" | "metadata";
  content?: string;
  ts: string;
  data?: Record<string, unknown>;
}

export interface CliSessionMetadataInput {
  dataDir: string;
  sessionPath: string;
  data: Record<string, unknown>;
}

export interface CliSessionIndexEntry {
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

export interface CliSessionIndexPayload {
  version: 1;
  updatedAt: string;
  sessions: CliSessionIndexEntry[];
}

export function resolveDataDir(explicit?: string | null): string {
  if (explicit?.trim()) return path.resolve(explicit);
  if (process.env.LYNN_DATA_DIR?.trim()) return path.resolve(process.env.LYNN_DATA_DIR);
  return path.join(os.homedir(), ".lynn");
}

export function cliSessionDir(dataDir: string): string {
  return path.join(dataDir, "agents", CLI_AGENT_ID, "sessions");
}

export function sessionIndexPath(dataDir: string): string {
  return path.join(cliSessionDir(dataDir), SESSION_INDEX_FILENAME);
}

export function newSessionPath(dataDir: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = Math.random().toString(36).slice(2, 8);
  return path.join(cliSessionDir(dataDir), `${stamp}-${suffix}.jsonl`);
}

async function readIndex(dataDir: string): Promise<CliSessionIndexEntry[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(sessionIndexPath(dataDir), "utf8")) as { sessions?: unknown };
    return Array.isArray(parsed.sessions) ? parsed.sessions as CliSessionIndexEntry[] : [];
  } catch {
    return [];
  }
}

async function writeIndex(dataDir: string, entries: CliSessionIndexEntry[]): Promise<void> {
  const dir = cliSessionDir(dataDir);
  await fs.mkdir(dir, { recursive: true });
  const payload: CliSessionIndexPayload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    sessions: entries,
  };
  const target = sessionIndexPath(dataDir);
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.rename(tmp, target);
}

export async function readSessionLines(sessionPath: string): Promise<CliSessionLine[]> {
  const raw = await fs.readFile(sessionPath, "utf8");
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CliSessionLine);
}

export async function appendSessionTurn(input: {
  dataDir: string;
  sessionPath?: string | null;
  cwd: string;
  title?: string | null;
  prompt: string;
  assistant: string;
  modelId?: string | null;
  modelProvider?: string | null;
}): Promise<string> {
  const target = input.sessionPath ? path.resolve(input.sessionPath) : newSessionPath(input.dataDir);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const ts = new Date().toISOString();
  const lines: CliSessionLine[] = [
    { type: "user", content: input.prompt, ts },
    { type: "assistant", content: input.assistant, ts: new Date().toISOString() },
  ];
  await fs.appendFile(target, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");

  const existing = await readIndex(input.dataDir);
  const old = existing.find((entry) => path.resolve(entry.path) === path.resolve(target));
  const messageCount = (old?.messageCount || 0) + 2;
  const entry: CliSessionIndexEntry = {
    path: target,
    title: input.title || old?.title || input.prompt.slice(0, 80) || null,
    firstMessage: old?.firstMessage || input.prompt,
    modified: new Date().toISOString(),
    messageCount,
    cwd: input.cwd,
    agentId: CLI_AGENT_ID,
    agentName: "Lynn CLI",
    modelId: input.modelId || old?.modelId || null,
    modelProvider: input.modelProvider || old?.modelProvider || null,
    pinned: old?.pinned || false,
    labels: Array.isArray(old?.labels) ? old.labels : [],
  };
  const next = [entry, ...existing.filter((candidate) => path.resolve(candidate.path) !== path.resolve(target))];
  await writeIndex(input.dataDir, next);
  return target;
}

export async function appendSessionLine(input: {
  dataDir: string;
  sessionPath?: string | null;
  cwd: string;
  title?: string | null;
  line: Omit<CliSessionLine, "ts"> & { ts?: string };
  modelId?: string | null;
  modelProvider?: string | null;
}): Promise<string> {
  const target = input.sessionPath ? path.resolve(input.sessionPath) : newSessionPath(input.dataDir);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const line: CliSessionLine = {
    ...input.line,
    ts: input.line.ts || new Date().toISOString(),
  };
  await fs.appendFile(target, `${JSON.stringify(line)}\n`, "utf8");

  const existing = await readIndex(input.dataDir);
  const old = existing.find((entry) => path.resolve(entry.path) === path.resolve(target));
  const isMessage = line.type === "user" || line.type === "assistant";
  const messageCount = (old?.messageCount || 0) + (isMessage ? 1 : 0);
  const firstMessage = old?.firstMessage || (line.type === "user" && line.content ? line.content : input.title || "");
  const entry: CliSessionIndexEntry = {
    path: target,
    title: input.title || old?.title || (line.content || "").slice(0, 80) || null,
    firstMessage,
    modified: new Date().toISOString(),
    messageCount,
    cwd: input.cwd,
    agentId: CLI_AGENT_ID,
    agentName: "Lynn CLI",
    modelId: input.modelId || old?.modelId || null,
    modelProvider: input.modelProvider || old?.modelProvider || null,
    pinned: old?.pinned || false,
    labels: Array.isArray(old?.labels) ? old.labels : [],
  };
  const next = [entry, ...existing.filter((candidate) => path.resolve(candidate.path) !== path.resolve(target))];
  await writeIndex(input.dataDir, next);
  return target;
}

export async function appendSessionMetadata(input: CliSessionMetadataInput): Promise<void> {
  const target = path.resolve(input.sessionPath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.appendFile(target, `${JSON.stringify({ type: "metadata", ts: new Date().toISOString(), data: input.data } satisfies CliSessionLine)}\n`, "utf8");
}

export async function listSessions(dataDir: string): Promise<CliSessionIndexEntry[]> {
  const entries = await readIndex(dataDir);
  return entries.sort((a, b) => String(b.modified || "").localeCompare(String(a.modified || "")));
}

export async function latestSessionPath(dataDir: string): Promise<string | null> {
  const latest = (await listSessions(dataDir))[0];
  return latest?.path || null;
}
