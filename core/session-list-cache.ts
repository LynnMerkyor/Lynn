import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { SESSION_INDEX_FILENAME, readSessionIndex, refreshSessionIndex } from "./session-index.js";

type AnyRecord = Record<string, any>;
type AgentLike = AnyRecord;
type SessionLike = AnyRecord;
type SessionEntryLike = AnyRecord & {
  session?: AnyRecord;
  agentId?: string;
  lastTouchedAt?: number;
  unsub?: () => void;
};

export const MAX_CACHED_SESSIONS = 20;

const SESSION_LIST_TIMEOUT_MS = 700;
const SESSION_STAT_TIMEOUT_MS = 250;
const SESSION_LIST_MAX_FILES = 600;
const SESSION_AUX_FILES = new Set([
  SESSION_INDEX_FILENAME,
  "session-meta.json",
  "session-titles.json",
]);

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
    }),
  ]);
}

export async function listSessionFileSkeletons(sessionDir: string, agent: AgentLike) {
  const entries = await withTimeout(
    fsp.readdir(sessionDir, { withFileTypes: true }),
    SESSION_LIST_TIMEOUT_MS,
    [],
  );
  if (!Array.isArray(entries) || entries.length === 0) return [];

  const files = entries
    .filter((entry) => entry.isFile?.() && entry.name.endsWith(".jsonl") && !SESSION_AUX_FILES.has(entry.name))
    .map((entry) => entry.name)
    .sort()
    .slice(-SESSION_LIST_MAX_FILES);

  const skeletons = await Promise.all(files.map(async (fileName: string) => {
    const sessionPath = path.join(sessionDir, fileName);
    const stat = await withTimeout(fsp.stat(sessionPath), SESSION_STAT_TIMEOUT_MS, null);
    return {
      path: sessionPath,
      title: null,
      firstMessage: "",
      modified: stat?.mtime || new Date(0),
      messageCount: 0,
      cwd: "",
      agentId: agent.id,
      agentName: agent.name,
      modelId: null,
      modelProvider: null,
      pinned: false,
      labels: [],
    };
  }));
  return skeletons.filter((entry) => entry.path);
}

export async function collectAgentSessionEntries(opts: {
  agentsDir: string;
  agents: AgentLike[];
  onIndexRefreshError?: (agent: AgentLike, err: unknown) => void;
}) {
  const sessions: AnyRecord[] = [];
  for (const agent of opts.agents) {
    const sessionDir = path.join(opts.agentsDir, agent.id, "sessions");
    if (!fs.existsSync(sessionDir)) continue;
    try {
      const indexed = (await readSessionIndex(sessionDir)) as AnyRecord[];
      if (indexed.length > 0) {
        for (const entry of indexed) {
          const modified = entry.modified ? new Date(entry.modified) : new Date(0);
          sessions.push({
            ...entry,
            modified: Number.isNaN(modified.getTime()) ? new Date(0) : modified,
            agentId: entry.agentId || agent.id,
            agentName: entry.agentName || agent.name,
            labels: Array.isArray(entry.labels) ? entry.labels.filter(Boolean) : [],
          });
        }
        continue;
      }

      const skeletons = await listSessionFileSkeletons(sessionDir, agent);
      for (const session of skeletons) sessions.push(session);
      await refreshSessionIndex(sessionDir, skeletons, { agent }).catch((err: unknown) => {
        opts.onIndexRefreshError?.(agent, err);
      });
    } catch {}
  }
  return sessions;
}

export async function refreshMissingSessionIndexes(opts: {
  agentsDir: string;
  agents: AgentLike[];
  onError?: (agent: AgentLike, err: unknown) => void;
}) {
  for (const agent of opts.agents) {
    const sessionDir = path.join(opts.agentsDir, agent.id, "sessions");
    if (!fs.existsSync(sessionDir)) continue;
    try {
      const existing = await readSessionIndex(sessionDir);
      if (existing.length > 0) continue;
      const skeletons = await listSessionFileSkeletons(sessionDir, agent);
      await refreshSessionIndex(sessionDir, skeletons, { agent });
    } catch (err) {
      opts.onError?.(agent, err);
    }
  }
}

export function buildCurrentSessionListEntry(opts: {
  currentPath?: string | null;
  sessionStarted: boolean;
  allSessions: AnyRecord[];
  currentSession?: SessionLike | null;
  currentEntry?: SessionEntryLike | null;
  activeAgentId: string;
  activeAgent: AgentLike;
}) {
  if (!opts.currentPath || !opts.sessionStarted) return null;
  if (opts.allSessions.find((session) => session.path === opts.currentPath)) return null;
  return {
    path: opts.currentPath,
    title: null,
    firstMessage: "",
    modified: new Date(),
    messageCount: 0,
    cwd: opts.currentSession?.sessionManager?.getCwd?.() || "",
    agentId: opts.activeAgentId,
    agentName: opts.activeAgent.agentName,
    modelId: opts.currentEntry?.modelId || null,
    modelProvider: opts.currentEntry?.modelProvider || null,
  };
}

export function sortSessionEntriesByModified(sessions: AnyRecord[]) {
  sessions.sort((a, b) => b.modified - a.modified);
  return sessions;
}

export async function listCoordinatorSessions(opts: {
  agentsDir: string;
  agents: AgentLike[];
  currentPath?: string | null;
  sessionStarted: boolean;
  currentSession?: SessionLike | null;
  currentEntry?: SessionEntryLike | null;
  activeAgentId: string;
  activeAgent: AgentLike;
  onIndexRefreshError?: (agent: AgentLike, err: unknown) => void;
}) {
  const allSessions = await collectAgentSessionEntries({
    agentsDir: opts.agentsDir,
    agents: opts.agents,
    onIndexRefreshError: opts.onIndexRefreshError,
  });
  const currentEntry = buildCurrentSessionListEntry({
    currentPath: opts.currentPath,
    sessionStarted: opts.sessionStarted,
    allSessions,
    currentSession: opts.currentSession,
    currentEntry: opts.currentEntry,
    activeAgentId: opts.activeAgentId,
    activeAgent: opts.activeAgent,
  });
  if (currentEntry) allSessions.unshift(currentEntry);
  return sortSessionEntriesByModified(allSessions);
}

export function evictSessionCacheEntries(opts: {
  sessions: Map<string, SessionEntryLike>;
  currentKey: string;
  focusPath?: string | null;
  maxSessions?: number;
  getAgentById: (agentId: string) => AgentLike | null | undefined;
  getFallbackAgent: () => AgentLike | null | undefined;
  notifySessionEnd: (agent: AgentLike | null | undefined, sessionPath: string, context: string) => unknown;
}) {
  const maxSessions = opts.maxSessions || MAX_CACHED_SESSIONS;
  if (opts.sessions.size <= maxSessions) return 0;

  let evicted = 0;
  const candidates = [...opts.sessions.entries()]
    .filter(([key, entry]) => (
      key !== opts.currentKey
      && key !== opts.focusPath
      && !entry.session?.isStreaming
    ))
    .sort((a, b) => Number(a[1].lastTouchedAt || 0) - Number(b[1].lastTouchedAt || 0));

  for (const [key, entry] of candidates) {
    const agent = opts.getAgentById(String(entry.agentId || "")) || opts.getFallbackAgent();
    opts.notifySessionEnd(agent, key, "cache eviction");
    entry.unsub?.();
    opts.sessions.delete(key);
    evicted += 1;
    if (opts.sessions.size <= maxSessions) break;
  }
  return evicted;
}
