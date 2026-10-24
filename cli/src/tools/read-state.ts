/**
 * tools/read-state.ts — task-scoped memory of what the model has already read.
 *
 * Two features depend on it:
 *  - read dedupe: reading an unchanged file again returns a stub instead of the
 *    whole file, so long sessions do not pay for the same bytes twice;
 *  - edit/overwrite safety: `edit` refuses to touch a file the model has not read
 *    in this session, which is the single cheapest way to stop blind rewrites.
 *
 * Agent tasks use isolated async scopes, cleared after context compaction,
 * because the bytes were dropped from the model's context at that point.
 */
import type { Stats } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";

interface ReadRecord {
  /** "read" means the model saw the bytes; "write" only means it authored them. */
  source: "read" | "write";
  mtimeMs: number;
  size: number;
  offset: number;
  nextOffset: number;
  truncated: boolean;
  recordedAt: number;
}

const fallbackReads = new Map<string, ReadRecord>();
const readScopes = new AsyncLocalStorage<Map<string, ReadRecord>>();
const currentReads = () => readScopes.getStore() ?? fallbackReads;

export function withReadState<T>(operation: () => T): T {
  return readScopes.run(new Map(), operation);
}

export interface ReadFingerprint {
  mtimeMs: number;
  size: number;
}

export function fingerprintOf(stat: Stats): ReadFingerprint {
  return { mtimeMs: stat.mtimeMs, size: stat.size };
}

export function recordFileRead(
  filePath: string,
  stat: ReadFingerprint,
  range: { offset: number; nextOffset: number; truncated: boolean },
  source: "read" | "write" = "read",
): void {
  currentReads().set(filePath, {
    source,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    offset: range.offset,
    nextOffset: range.nextOffset,
    truncated: range.truncated,
    recordedAt: Date.now(),
  });
}

export function wasFileRead(filePath: string): boolean {
  return currentReads().has(filePath);
}

/** True when the model already has this exact range and the file did not change. */
export function isReadUnchanged(filePath: string, stat: ReadFingerprint, offset = 0): boolean {
  const record = currentReads().get(filePath);
  if (!record) return false;
  return record.source === "read"
    && record.mtimeMs === stat.mtimeMs
    && record.size === stat.size
    && record.offset === offset
    && !record.truncated;
}

/** True when the file was read at all and has not changed since. */
export function isKnownUnchanged(filePath: string, stat: ReadFingerprint): boolean {
  const record = currentReads().get(filePath);
  if (!record) return false;
  return record.mtimeMs === stat.mtimeMs && record.size === stat.size;
}

export function readRecord(filePath: string): ReadRecord | undefined {
  return currentReads().get(filePath);
}

export function clearReadState(): void {
  currentReads().clear();
}

/** Most recently read paths, newest first. */
export function recentReadPaths(limit = 5): string[] {
  return [...currentReads().entries()]
    .sort((a, b) => b[1].recordedAt - a[1].recordedAt)
    .slice(0, Math.max(0, limit))
    .map(([filePath]) => filePath);
}
