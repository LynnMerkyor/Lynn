import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export interface SessionFile {
  fileId: string; sessionId: string; name: string; size: number; createdAt: string;
  storageKind: "external" | "session_copy"; downloadUrl: string;
}
interface StoredFile extends SessionFile { localPath: string; sourcePath: string }
const MAX_FILE_BYTES = 50 * 1024 * 1024;

export function sessionIdForPath(sessionPath: string): string {
  return createHash("sha256").update(fs.realpathSync(sessionPath)).digest("hex").slice(0, 32);
}
function readRecords(sessionPath: string): StoredFile[] {
  const file = `${fs.realpathSync(sessionPath)}.files.json`;
  try {
    if (fs.statSync(file).size > 2 * 1024 * 1024) throw new Error("Session file registry is too large");
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (data.version !== 1 || !Array.isArray(data.files)) throw new Error("Invalid session file registry");
    return data.files;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
function publicFile({ localPath: _localPath, sourcePath: _sourcePath, ...file }: StoredFile): SessionFile { return file; }

/** Called only at an authorized upload / tool-output / bridge-delivery boundary. */
export function registerSessionFile(sessionPath: string, filePath: string, options: { copy?: boolean; name?: string } = {}): SessionFile {
  const canonicalSession = fs.realpathSync(sessionPath);
  const sourcePath = fs.realpathSync(filePath);
  const stat = fs.statSync(sourcePath);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error("Session attachment must be a regular file up to 50 MB");
  const files = readRecords(canonicalSession);
  const existing = files.find(file => file.sourcePath === sourcePath && (options.copy ? file.storageKind === "session_copy" : true));
  if (existing) return publicFile(existing);
  if (files.length >= 1000) throw new Error("Session attachment limit reached");
  const sessionId = sessionIdForPath(canonicalSession);
  const fileId = randomUUID();
  let localPath = sourcePath;
  if (options.copy) {
    const directory = `${canonicalSession}.attachments`;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.realpathSync(directory) !== directory) throw new Error("Invalid session attachment directory");
    localPath = path.join(directory, fileId + path.extname(sourcePath).slice(0, 16));
    fs.copyFileSync(sourcePath, localPath, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(localPath, 0o600);
  }
  const file: StoredFile = { fileId, sessionId, name: path.basename(options.name || sourcePath), size: stat.size, createdAt: new Date().toISOString(), storageKind: options.copy ? "session_copy" : "external", downloadUrl: `/api/session-files/${sessionId}/${fileId}`, localPath, sourcePath };
  files.push(file);
  const destination = `${canonicalSession}.files.json`;
  const temporary = `${destination}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ version: 1, files }), { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, destination);
  return publicFile(file);
}

export function listSessionFiles(sessionPath: string): SessionFile[] { return readRecords(sessionPath).map(publicFile); }
export function findSessionFile(sessionPath: string, filePath: string): SessionFile | undefined {
  try { const source = fs.realpathSync(filePath); const record = readRecords(sessionPath).find(file => file.sourcePath === source || file.localPath === source); return record ? publicFile(record) : undefined; }
  catch { return undefined; }
}
export function resolveSessionFile(sessionPath: string, fileId: string): { file: SessionFile; localPath: string } {
  const record = readRecords(sessionPath).find(file => file.fileId === fileId && file.sessionId === sessionIdForPath(sessionPath));
  if (!record) throw new Error("Session attachment not found");
  const real = fs.realpathSync(record.localPath);
  if (real !== record.localPath) throw new Error("Session attachment path changed");
  const stat = fs.statSync(real);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error("Session attachment is unavailable or exceeds 50 MB");
  return { file: { ...publicFile(record), size: stat.size }, localPath: real };
}
