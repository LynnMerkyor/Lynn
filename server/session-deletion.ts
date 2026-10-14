import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export class SessionDeletionError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 = 403) { super(message); }
}

export function validateSessionFile(agentsDir: string, input: string) {
  const root = path.resolve(agentsDir);
  const target = path.resolve(input);
  const parts = path.relative(root, target).split(path.sep);
  const archived = parts.length === 4 && parts[2] === "archived";
  if (!path.isAbsolute(input) || (parts.length !== 3 && !archived) || parts[0] === ".."
    || parts[1] !== "sessions" || !parts.at(-1)?.endsWith(".jsonl")) {
    throw new SessionDeletionError("Invalid session path");
  }
  try {
    const canonicalRoot = fs.realpathSync(root);
    const expected = path.join(canonicalRoot, ...parts);
    if (fs.realpathSync(target) !== expected || !fs.lstatSync(target).isFile()) {
      throw new SessionDeletionError("Session symlinks are not allowed");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new SessionDeletionError("Session not found", 404);
    throw error;
  }
  return { target, archived, sessionDir: path.join(root, parts[0], "sessions"), agentId: parts[0] };
}

function readObject(file: string): Record<string, any> {
  try {
    if (!fs.lstatSync(file).isFile()) throw new SessionDeletionError("Invalid session metadata file");
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export function listArchivedSessions(agentsDir: string) {
  const sessions: Array<{ path: string; title: string; modified: string; agentId: string }> = [];
  let agents: fs.Dirent[];
  try { agents = fs.readdirSync(agentsDir, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return sessions; throw error; }
  for (const agent of agents) {
    if (!agent.isDirectory()) continue;
    const sessionDir = path.join(agentsDir, agent.name, "sessions");
    const archiveDir = path.join(sessionDir, "archived");
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(archiveDir, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    let titles: ReturnType<typeof readObject> | undefined;
    let meta: ReturnType<typeof readObject> | undefined;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const target = path.join(archiveDir, entry.name);
      try { validateSessionFile(agentsDir, target); }
      catch (error) { if (error instanceof SessionDeletionError) continue; throw error; }
      titles ??= readObject(path.join(sessionDir, "session-titles.json"));
      meta ??= readObject(path.join(sessionDir, "session-meta.json"));
      const title = titles[target] || titles[path.join(sessionDir, entry.name)] || meta[entry.name]?.title;
      sessions.push({ path: target, title: typeof title === "string" ? title : entry.name, modified: fs.statSync(target).mtime.toISOString(), agentId: agent.name });
    }
  }
  return sessions.sort((left, right) => right.modified.localeCompare(left.modified));
}

export async function deleteSessionFile(engine: { agentsDir: string; closeSession(path: string): unknown }, input: string, beforeClose?: (sessionPath: string) => unknown) {
  const checked = validateSessionFile(engine.agentsDir, input);
  const restoreOnFailure = await beforeClose?.(checked.target);
  try {
    await engine.closeSession(checked.target);
    removeClosedSessionFile(engine.agentsDir, input);
  } catch (error) {
    if (typeof restoreOnFailure === "function") restoreOnFailure();
    throw error;
  }
}

function removeClosedSessionFile(agentsDir: string, input: string) {
  const { target, archived, sessionDir } = validateSessionFile(agentsDir, input);
  const original = path.join(sessionDir, path.basename(target));
  const keys = new Set([target]);
  if (!archived || !fs.existsSync(original)) { keys.add(original); keys.add(path.basename(target)); }
  const updates: Array<{ file: string; data: Record<string, any> }> = [];
  for (const directory of new Set([sessionDir, path.dirname(target)])) {
    for (const name of ["session-meta.json", "session-titles.json", "session-index.json"]) {
      const file = path.join(directory, name);
      if (!fs.existsSync(file)) continue;
      const data = readObject(file);
      if (name === "session-index.json") {
        if (Array.isArray(data.sessions)) data.sessions = data.sessions.filter((entry: { path?: string }) => !keys.has(String(entry?.path)));
      } else for (const key of keys) delete data[key];
      updates.push({ file, data });
    }
  }
  for (const { file, data } of updates) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + "\n", { flag: "wx", mode: 0o600 }); fs.renameSync(temporary, file); }
    finally { fs.rmSync(temporary, { force: true }); }
  }
  const sidecarBases = new Set([target]);
  if (archived && !fs.existsSync(original)) sidecarBases.add(original);
  for (const base of sidecarBases) {
    fs.rmSync(`${base}.files.json`, { force: true });
    fs.rmSync(`${base}.attachments`, { recursive: true, force: true });
  }
  fs.unlinkSync(target);
}
