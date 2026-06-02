import fs from "node:fs/promises";
import path from "node:path";
import { readWorkspaceSnapshotManifest, restoreWorkspaceSnapshot, workspaceSnapshotFromRef, type WorkspaceSnapshotManifest } from "./code-snapshot.js";
import { latestSessionPath, readSessionLinesResult, type CliSessionLine } from "./session/store.js";
import { bold, cyan, dim, green, red, supportsColor, yellow } from "./terminal-style.js";

export interface CodeRewindCheckpoint {
  ordinal: number;
  lineIndex: number;
  beforeLine: number;
  snapshotRef: string;
  restoreCommand: string | null;
  cwd: string | null;
  task: string | null;
  createdAt: string | null;
  entries: Array<{ path: string; existed: boolean }>;
  skipped: string[];
  missing: boolean;
}

export interface CodeRewindSession {
  sessionPath: string;
  lines: CliSessionLine[];
  skippedLines: number;
  checkpoints: CodeRewindCheckpoint[];
}

export interface CodeRewindSpec {
  sessionRef: string | null;
  ordinal: number | null;
  apply: boolean;
}

export interface CodeRewindApplyResult {
  sessionPath: string;
  target: CodeRewindCheckpoint;
  restoredSnapshots: number;
  restoredFiles: string[];
  deletedFiles: string[];
  skippedFiles: string[];
  trimmedSessionPath: string;
  restoreMessages: string[];
}

export function parseCodeRewindSpec(raw: string, apply = false): CodeRewindSpec {
  const body = raw.replace(/^\/?rewind\b/, "").trim();
  const tokens = body.split(/\s+/).filter(Boolean);
  let sessionRef: string | null = null;
  let ordinal: number | null = null;
  let shouldApply = apply;
  for (const token of tokens) {
    if (token === "--apply" || token === "-y") {
      shouldApply = true;
      continue;
    }
    const hash = token.match(/^(.+?)#(\d+)$/);
    if (hash) {
      sessionRef = hash[1];
      ordinal = Number(hash[2]);
      continue;
    }
    if (/^\d+$/.test(token) && ordinal === null) {
      ordinal = Number(token);
      continue;
    }
    if (!sessionRef) sessionRef = token;
  }
  return { sessionRef, ordinal, apply: shouldApply };
}

export async function resolveCodeRewindSessionPath(raw: string | null, dataDir: string): Promise<string> {
  const value = (raw || "last").trim();
  if (!value || value === "last" || value === "latest") {
    const latest = await latestSessionPath(dataDir);
    if (!latest) throw new Error("No CLI session found to rewind. Run a saved code task first.");
    return latest;
  }
  const expanded = value.startsWith("~/") ? path.join(process.env.HOME || "", value.slice(2)) : value;
  return path.resolve(expanded);
}

export async function readCodeRewindSession(sessionPath: string): Promise<CodeRewindSession> {
  const { lines, skipped } = await readSessionLinesResult(sessionPath);
  const checkpoints: CodeRewindCheckpoint[] = [];
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line.type !== "metadata" || line.data?.kind !== "code_rewind_checkpoint") continue;
    const snapshotRef = typeof line.data.snapshotRef === "string" ? line.data.snapshotRef : "";
    if (!snapshotRef) continue;
    const manifest = readWorkspaceSnapshotManifest(snapshotRef);
    checkpoints.push(checkpointFromMetadata(checkpoints.length + 1, index, line, manifest));
  }
  return { sessionPath, lines, skippedLines: skipped, checkpoints };
}

export function selectCodeRewindCheckpoint(session: CodeRewindSession, ordinal: number): CodeRewindCheckpoint {
  const checkpoint = session.checkpoints.find((candidate) => candidate.ordinal === ordinal);
  if (!checkpoint) throw new Error(`No rewind checkpoint #${ordinal}. Run /rewind to list available checkpoints.`);
  return checkpoint;
}

export async function applyCodeRewind(input: { sessionPath: string; ordinal: number }): Promise<CodeRewindApplyResult> {
  const session = await readCodeRewindSession(input.sessionPath);
  const target = selectCodeRewindCheckpoint(session, input.ordinal);
  const restoreRange = session.checkpoints.filter((checkpoint) => checkpoint.ordinal <= input.ordinal);
  const restoredFiles: string[] = [];
  const deletedFiles: string[] = [];
  const skippedFiles = new Set<string>();
  const restoreMessages: string[] = [];
  for (const checkpoint of restoreRange) {
    const snapshot = workspaceSnapshotFromRef(checkpoint.snapshotRef);
    if (!snapshot) {
      restoreMessages.push(`missing snapshot ${checkpoint.snapshotRef}`);
      continue;
    }
    const cwd = checkpoint.cwd || readWorkspaceSnapshotManifest(checkpoint.snapshotRef)?.cwd || process.cwd();
    const result = restoreWorkspaceSnapshot(cwd, snapshot);
    restoreMessages.push(result.message);
    for (const entry of checkpoint.entries) {
      if (entry.existed) restoredFiles.push(entry.path);
      else deletedFiles.push(entry.path);
    }
    for (const skipped of checkpoint.skipped) skippedFiles.add(skipped);
  }
  const trimmedSessionPath = await writeTrimmedSessionCopy(input.sessionPath, session.lines, target.beforeLine, {
    type: "metadata",
    ts: new Date().toISOString(),
    data: {
      kind: "code_rewind_applied",
      sourceSessionPath: input.sessionPath,
      targetOrdinal: target.ordinal,
      targetSnapshotRef: target.snapshotRef,
      restoredSnapshots: restoreRange.length,
      restoredFiles,
      deletedFiles,
      skippedFiles: [...skippedFiles],
    },
  });
  return {
    sessionPath: input.sessionPath,
    target,
    restoredSnapshots: restoreRange.length,
    restoredFiles: unique(restoredFiles),
    deletedFiles: unique(deletedFiles),
    skippedFiles: [...skippedFiles].sort(),
    trimmedSessionPath,
    restoreMessages,
  };
}

export function renderCodeRewindList(session: CodeRewindSession, color = supportsColor(process.stdout)): string {
  if (!session.checkpoints.length) return "No rewind checkpoints found for this session.";
  const rows = session.checkpoints.map((checkpoint) => {
    const task = checkpoint.task ? truncate(checkpoint.task, 48) : "untitled code turn";
    const files = checkpoint.entries.length ? `${checkpoint.entries.length} touched` : "no files";
    const skipped = checkpoint.skipped.length ? `, ${checkpoint.skipped.length} skipped` : "";
    const missing = checkpoint.missing ? red(" missing snapshot", color) : "";
    return `${dim(`${checkpoint.ordinal}.`, color)} ${cyan(task, color)} ${dim(`(${files}${skipped})`, color)}${missing}`;
  });
  return [`Rewind checkpoints for ${session.sessionPath}:`, ...rows, dim("Use /rewind N to preview, /rewind N --apply to restore touched files.", color)].join("\n");
}

export function renderCodeRewindPreview(session: CodeRewindSession, ordinal: number, color = supportsColor(process.stdout)): string {
  const target = selectCodeRewindCheckpoint(session, ordinal);
  const range = session.checkpoints.filter((checkpoint) => checkpoint.ordinal <= ordinal);
  const restored = unique(range.flatMap((checkpoint) => checkpoint.entries.filter((entry) => entry.existed).map((entry) => entry.path)));
  const deleted = unique(range.flatMap((checkpoint) => checkpoint.entries.filter((entry) => !entry.existed).map((entry) => entry.path)));
  const skipped = unique(range.flatMap((checkpoint) => checkpoint.skipped));
  const lines = [
    bold(`Preview rewind #${ordinal}`, color),
    `Session: ${session.sessionPath}`,
    `Target: ${target.task || "untitled code turn"}`,
    `Trimmed transcript lines: ${Math.max(0, Math.min(target.beforeLine, session.lines.length))}/${session.lines.length}`,
  ];
  if (restored.length) lines.push(`${green("restore", color)}: ${restored.join(", ")}`);
  if (deleted.length) lines.push(`${yellow("delete created", color)}: ${deleted.join(", ")}`);
  if (skipped.length) lines.push(`${red("skipped", color)}: ${skipped.join(", ")}`);
  lines.push(dim("No files outside these touched paths will be restored.", color));
  lines.push(dim(`Apply with /rewind ${ordinal} --apply`, color));
  return lines.join("\n");
}

export function renderCodeRewindApply(result: CodeRewindApplyResult, color = supportsColor(process.stdout)): string {
  const lines = [
    green(`Rewind #${result.target.ordinal} applied`, color),
    `Restored snapshots: ${result.restoredSnapshots}`,
    `Trimmed session: ${result.trimmedSessionPath}`,
  ];
  if (result.restoredFiles.length) lines.push(`${green("restored", color)}: ${result.restoredFiles.join(", ")}`);
  if (result.deletedFiles.length) lines.push(`${yellow("deleted created", color)}: ${result.deletedFiles.join(", ")}`);
  if (result.skippedFiles.length) lines.push(`${red("skipped", color)}: ${result.skippedFiles.join(", ")}`);
  lines.push(dim(`Resume with: Lynn code --resume ${shellQuote(result.trimmedSessionPath)} --long "continue"`, color));
  return lines.join("\n");
}

function checkpointFromMetadata(
  ordinal: number,
  lineIndex: number,
  line: CliSessionLine,
  manifest: WorkspaceSnapshotManifest | null,
): CodeRewindCheckpoint {
  const data = line.data || {};
  const entries = manifest?.entries.map((entry) => ({ path: entry.path, existed: entry.existed })) || [];
  return {
    ordinal,
    lineIndex,
    beforeLine: typeof data.beforeLine === "number" ? data.beforeLine : lineIndex,
    snapshotRef: String(data.snapshotRef || manifest?.id || ""),
    restoreCommand: typeof data.restoreCommand === "string" ? data.restoreCommand : manifest ? `internal://lynn-cli-snapshot/${manifest.id}` : null,
    cwd: typeof data.cwd === "string" ? data.cwd : manifest?.cwd || null,
    task: typeof data.task === "string" ? data.task : null,
    createdAt: typeof data.createdAt === "string" ? data.createdAt : manifest?.createdAt || null,
    entries,
    skipped: manifest?.skipped || [],
    missing: !manifest,
  };
}

async function writeTrimmedSessionCopy(sessionPath: string, lines: CliSessionLine[], beforeLine: number, metadata: CliSessionLine): Promise<string> {
  const dir = path.dirname(path.resolve(sessionPath));
  const base = path.basename(sessionPath).replace(/\.jsonl$/i, "");
  const target = path.join(dir, `${base}-rewind-${Date.now().toString(36)}.jsonl`);
  const kept = lines.slice(0, Math.max(0, Math.min(beforeLine, lines.length)));
  const payload = [...kept, metadata].map((line) => JSON.stringify(line)).join("\n") + "\n";
  await fs.writeFile(target, payload, "utf8");
  return target;
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function truncate(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
