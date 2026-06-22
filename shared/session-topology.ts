export const SESSION_TOPOLOGY_STATUSES = ["active", "paused", "completed", "archived"] as const;

export type SessionTopologyStatus = typeof SESSION_TOPOLOGY_STATUSES[number];

export interface SessionTopologyMeta {
  parentSessionPath: string | null;
  rootSessionPath: string | null;
  branchLabel: string | null;
  taskStatus: SessionTopologyStatus;
  summary: string | null;
  resumeHint: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

type AnyRecord = Record<string, unknown>;

const STATUS_SET = new Set<string>(SESSION_TOPOLOGY_STATUSES);

function asRecord(value: unknown): AnyRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as AnyRecord : {};
}

function cleanString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

function cleanIso(value: unknown): string | null {
  const raw = cleanString(value, 64);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function normalizeSessionTopologyStatus(value: unknown): SessionTopologyStatus {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  return STATUS_SET.has(raw) ? raw as SessionTopologyStatus : "active";
}

export function hasMeaningfulSessionTopology(value: SessionTopologyMeta | null | undefined): boolean {
  if (!value) return false;
  return !!(
    value.parentSessionPath
    || value.rootSessionPath
    || value.branchLabel
    || value.summary
    || value.resumeHint
    || value.taskStatus !== "active"
  );
}

export function normalizeSessionTopology(value: unknown): SessionTopologyMeta | null {
  const raw = asRecord(value);
  const topology: SessionTopologyMeta = {
    parentSessionPath: cleanString(raw.parentSessionPath ?? raw.parent, 2048),
    rootSessionPath: cleanString(raw.rootSessionPath ?? raw.root, 2048),
    branchLabel: cleanString(raw.branchLabel ?? raw.label, 120),
    taskStatus: normalizeSessionTopologyStatus(raw.taskStatus ?? raw.status),
    summary: cleanString(raw.summary, 12_000),
    resumeHint: cleanString(raw.resumeHint ?? raw.resume, 4_000),
    createdAt: cleanIso(raw.createdAt),
    updatedAt: cleanIso(raw.updatedAt),
  };
  return hasMeaningfulSessionTopology(topology) ? topology : null;
}

export function mergeSessionTopology(base: unknown, patch: unknown, now = new Date()): SessionTopologyMeta | null {
  const previous = normalizeSessionTopology(base);
  const rawPatch = asRecord(patch);
  const statusPatch = rawPatch.taskStatus ?? rawPatch.status;
  const next = normalizeSessionTopology({
    ...(previous || {}),
    ...rawPatch,
    ...(statusPatch !== undefined && { taskStatus: statusPatch }),
    createdAt: rawPatch.createdAt ?? previous?.createdAt ?? now.toISOString(),
    updatedAt: rawPatch.updatedAt ?? now.toISOString(),
  });
  return next;
}
