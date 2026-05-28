import fsp from "fs/promises";
import path from "path";

type AnyRecord = Record<string, any>;
type AgentLike = AnyRecord;

export type SessionTitleCacheEntry = { titles: Record<string, string>; ts: number };

const SESSION_TITLES_TTL_MS = 60_000;

export function resolveSessionDirForPath(sessionPath: string, opts: {
  agentsDir: string;
  currentAgent: AgentLike;
  agentIdFromSessionPath: (sessionPath: string) => string | null | undefined;
}) {
  const agentId = opts.agentIdFromSessionPath(sessionPath);
  return agentId
    ? path.join(opts.agentsDir, agentId, "sessions")
    : opts.currentAgent.sessionDir;
}

export async function loadSessionTitlesFor(
  sessionDir: string,
  titlesCache: Map<string, SessionTitleCacheEntry>,
  ttlMs = SESSION_TITLES_TTL_MS,
) {
  const cached = titlesCache.get(sessionDir);
  if (cached && Date.now() - cached.ts < ttlMs) {
    return { ...cached.titles };
  }
  try {
    const raw = await fsp.readFile(path.join(sessionDir, "session-titles.json"), "utf-8");
    const titles = JSON.parse(raw);
    titlesCache.set(sessionDir, { titles, ts: Date.now() });
    return { ...titles };
  } catch {
    titlesCache.set(sessionDir, { titles: {}, ts: Date.now() });
    return {};
  }
}

export async function saveSessionTitleFile(sessionPath: string, title: string, opts: {
  agentsDir: string;
  currentAgent: AgentLike;
  agentIdFromSessionPath: (sessionPath: string) => string | null | undefined;
  titlesCache: Map<string, SessionTitleCacheEntry>;
}) {
  const sessionDir = resolveSessionDirForPath(sessionPath, opts);
  const titlePath = path.join(sessionDir, "session-titles.json");
  const titles = await loadSessionTitlesFor(sessionDir, opts.titlesCache);
  titles[sessionPath] = title;
  await fsp.writeFile(titlePath, JSON.stringify(titles, null, 2), "utf-8");
  opts.titlesCache.set(sessionDir, { titles: { ...titles }, ts: Date.now() });
}

export async function saveSessionMetaFile(sessionPath: string, meta: AnyRecord, opts: {
  agentsDir: string;
  currentAgent: AgentLike;
  agentIdFromSessionPath: (sessionPath: string) => string | null | undefined;
}) {
  const sessionDir = resolveSessionDirForPath(sessionPath, opts);
  const metaPath = path.join(sessionDir, "session-meta.json");
  let allMeta: Record<string, AnyRecord> = {};
  try {
    allMeta = JSON.parse(await fsp.readFile(metaPath, "utf-8"));
  } catch {}
  allMeta[sessionPath] = { ...(allMeta[sessionPath] || {}), ...meta };
  await fsp.writeFile(metaPath, JSON.stringify(allMeta, null, 2), "utf-8");
}
