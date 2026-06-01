import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CodeToolRequest } from "./code-tool-protocol.js";

const SNAPSHOT_VERSION = 1;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

export interface WorkspaceSnapshot {
  available: boolean;
  ref: string | null;
  restoreCommand: string | null;
  file: string | null;
  entries: number;
  skipped: string[];
}

interface SnapshotEntry {
  path: string;
  existed: boolean;
  data?: string;
  mode?: number;
}

interface SnapshotManifest {
  version: typeof SNAPSHOT_VERSION;
  id: string;
  cwd: string;
  createdAt: string;
  entries: SnapshotEntry[];
  skipped: string[];
}

const UNAVAILABLE: WorkspaceSnapshot = { available: false, ref: null, restoreCommand: null, file: null, entries: 0, skipped: [] };

export function createWorkspaceSnapshot(cwd: string): WorkspaceSnapshot {
  try {
    const id = crypto.randomUUID();
    const file = path.join(snapshotRoot(), `${id}.json`);
    const manifest: SnapshotManifest = {
      version: SNAPSHOT_VERSION,
      id,
      cwd: path.resolve(cwd),
      createdAt: new Date().toISOString(),
      entries: [],
      skipped: [],
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
    return { available: true, ref: id, restoreCommand: `internal://lynn-cli-snapshot/${id}`, file, entries: 0, skipped: [] };
  } catch {
    return UNAVAILABLE;
  }
}

export function recordWorkspaceSnapshotForRequest(cwd: string, snapshot: WorkspaceSnapshot | null, request: CodeToolRequest): WorkspaceSnapshot {
  if (!snapshot?.available || !snapshot.file) return snapshot || UNAVAILABLE;
  const manifest = readManifest(snapshot);
  if (!manifest) return snapshot;
  const seen = new Set(manifest.entries.map((entry) => entry.path));
  const skipped = new Set(manifest.skipped);
  let changed = false;
  for (const rel of filesForRequest(cwd, request)) {
    if (seen.has(rel) || skipped.has(rel)) continue;
    const target = path.resolve(cwd, rel);
    try {
      const stat = fs.statSync(target);
      if (!stat.isFile()) {
        skipped.add(rel);
        changed = true;
        continue;
      }
      if (stat.size > MAX_FILE_BYTES) {
        skipped.add(rel);
        changed = true;
        continue;
      }
      manifest.entries.push({
        path: rel,
        existed: true,
        data: fs.readFileSync(target).toString("base64"),
        mode: stat.mode,
      });
      seen.add(rel);
      changed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        manifest.entries.push({ path: rel, existed: false });
        seen.add(rel);
        changed = true;
      } else {
        skipped.add(rel);
        changed = true;
      }
    }
  }
  manifest.skipped = [...skipped].sort();
  if (changed) writeManifest(snapshot.file, manifest);
  return { ...snapshot, entries: manifest.entries.length, skipped: manifest.skipped };
}

export function restoreWorkspaceSnapshot(cwd: string, snapshot: WorkspaceSnapshot | null): { ok: boolean; message: string } {
  if (!snapshot?.available || !snapshot.file) return { ok: false, message: "no snapshot available" };
  const manifest = readManifest(snapshot);
  if (!manifest) return { ok: false, message: "snapshot manifest is missing or unreadable" };
  let restored = 0;
  for (const entry of manifest.entries) {
    const target = safeTarget(cwd, entry.path);
    if (!target) continue;
    if (!entry.existed) {
      fs.rmSync(target, { force: true });
      restored += 1;
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(entry.data || "", "base64"));
    if (entry.mode) fs.chmodSync(target, entry.mode);
    restored += 1;
  }
  const suffix = manifest.skipped.length ? ` (${manifest.skipped.length} oversized/non-file path(s) were not snapshotted)` : "";
  return { ok: true, message: `restored ${restored} touched file(s) from snapshot ${manifest.id.slice(0, 12)}${suffix}` };
}

export function autoRollbackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LYNN_CLI_AUTO_ROLLBACK === "1";
}

function snapshotRoot(): string {
  return path.join(os.homedir(), ".lynn", "cli-snapshots");
}

function readManifest(snapshot: Pick<WorkspaceSnapshot, "file">): SnapshotManifest | null {
  if (!snapshot.file) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(snapshot.file, "utf8")) as SnapshotManifest;
    return parsed?.version === SNAPSHOT_VERSION && Array.isArray(parsed.entries) ? parsed : null;
  } catch {
    return null;
  }
}

function writeManifest(file: string, manifest: SnapshotManifest): void {
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
}

function filesForRequest(cwd: string, request: CodeToolRequest): string[] {
  if (request.tool === "write_file") return normalizeFiles(cwd, [request.args.path]);
  if (request.tool === "apply_patch") return normalizeFiles(cwd, patchFiles(request.args.text || ""));
  return [];
}

function normalizeFiles(cwd: string, files: Array<string | undefined>): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const target = file ? safeRelative(cwd, file) : null;
    if (!target || seen.has(target)) continue;
    seen.add(target);
    result.push(target);
  }
  return result;
}

function safeRelative(cwd: string, file: string): string | null {
  const abs = path.isAbsolute(file) ? path.resolve(file) : path.resolve(cwd, file);
  const rel = path.relative(path.resolve(cwd), abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

function safeTarget(cwd: string, rel: string): string | null {
  const target = path.resolve(cwd, rel);
  const relative = path.relative(path.resolve(cwd), target);
  return !relative.startsWith("..") && !path.isAbsolute(relative) ? target : null;
}

function patchFiles(patch: string): string[] {
  const files: string[] = [];
  const add = (value: string | undefined) => {
    const clean = (value || "").trim().replace(/^[ab]\//, "");
    if (!clean || clean === "/dev/null") return;
    files.push(clean);
  };
  for (const line of patch.replace(/\r\n/g, "\n").split("\n")) {
    const git = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (git) {
      add(git[1]);
      add(git[2]);
      continue;
    }
    const codex = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/);
    if (codex) {
      add(codex[1]);
      continue;
    }
    const plusMinus = line.match(/^(?:---|\+\+\+) (?:[ab]\/)?(.+)$/);
    if (plusMinus) add(plusMinus[1]);
  }
  return files;
}
