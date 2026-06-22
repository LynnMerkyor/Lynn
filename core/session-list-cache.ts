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

type SessionSkeletonListResult = {
  skeletons: AnyRecord[];
  complete: boolean;
};

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
    }),
  ]);
}

async function listSessionFileSkeletonsWithStatus(sessionDir: string, agent: AgentLike): Promise<SessionSkeletonListResult> {
  const timedOut = Symbol("session-list-timeout");
  const entries = await withTimeout<fs.Dirent[] | typeof timedOut>(
    fsp.readdir(sessionDir, { withFileTypes: true }) as Promise<fs.Dirent[]>,
    SESSION_LIST_TIMEOUT_MS,
    timedOut,
  );
  if (entries === timedOut) return { skeletons: [], complete: false };
  if (!Array.isArray(entries) || entries.length === 0) return { skeletons: [], complete: true };

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
      topology: null,
      digest: null,
      insights: [],
    };
  }));
  return { skeletons: skeletons.filter((entry) => entry.path), complete: true };
}

export async function listSessionFileSkeletons(sessionDir: string, agent: AgentLike) {
  return (await listSessionFileSkeletonsWithStatus(sessionDir, agent)).skeletons;
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
      const { skeletons, complete: skeletonListComplete } = await listSessionFileSkeletonsWithStatus(sessionDir, agent);
      if (indexed.length > 0) {
        if (!skeletonListComplete) {
          sessions.push(...indexed.map((entry) => {
            const modified = entry.modified ? new Date(entry.modified) : new Date(0);
            return {
              ...entry,
              modified: Number.isNaN(modified.getTime()) ? new Date(0) : modified,
              agentId: entry.agentId || agent.id,
              agentName: entry.agentName || agent.name,
              labels: Array.isArray(entry.labels) ? entry.labels.filter(Boolean) : [],
              topology: entry.topology || null,
              digest: entry.digest || null,
              insights: Array.isArray(entry.insights) ? entry.insights : [],
            };
          }));
          continue;
        }
        const skeletonPaths = new Set(skeletons.map((entry) => entry.path));
        const indexedPaths = new Set<string>();
        const merged: AnyRecord[] = [];
        for (const entry of indexed) {
          const entryPath = String(entry?.path || "");
          if (!entryPath || !skeletonPaths.has(entryPath)) continue;
          indexedPaths.add(entryPath);
          const modified = entry.modified ? new Date(entry.modified) : new Date(0);
          merged.push({
            ...entry,
            modified: Number.isNaN(modified.getTime()) ? new Date(0) : modified,
            agentId: entry.agentId || agent.id,
            agentName: entry.agentName || agent.name,
            labels: Array.isArray(entry.labels) ? entry.labels.filter(Boolean) : [],
            topology: entry.topology || null,
            digest: entry.digest || null,
            insights: Array.isArray(entry.insights) ? entry.insights : [],
          });
        }
        for (const skeleton of skeletons) {
          if (!indexedPaths.has(skeleton.path)) merged.push(skeleton);
        }
        sessions.push(...merged);
        if (merged.length !== indexed.length || skeletons.some((entry) => !indexedPaths.has(entry.path))) {
          await refreshSessionIndex(sessionDir, merged, { agent }).catch((err: unknown) => {
            opts.onIndexRefreshError?.(agent, err);
          });
        }
        continue;
      }

      for (const session of skeletons) sessions.push(session);
      if (skeletonListComplete) {
        await refreshSessionIndex(sessionDir, skeletons, { agent }).catch((err: unknown) => {
          opts.onIndexRefreshError?.(agent, err);
        });
      }
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
      const { skeletons, complete: skeletonListComplete } = await listSessionFileSkeletonsWithStatus(sessionDir, agent);
      if (skeletonListComplete) await refreshSessionIndex(sessionDir, skeletons, { agent });
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
    topology: opts.currentEntry?.topology || null,
    digest: opts.currentEntry?.digest || null,
    insights: Array.isArray(opts.currentEntry?.insights) ? opts.currentEntry?.insights : [],
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
