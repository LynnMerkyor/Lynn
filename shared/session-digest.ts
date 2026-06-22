export type SessionInsightStatus = "unread" | "consumed" | "archived";

export interface SessionDigest {
  objective: string | null;
  status: string | null;
  summary: string | null;
  decisions: string[];
  openQuestions: string[];
  nextSteps: string[];
  evidenceRefs: string[];
  updatedAt: string | null;
}

export interface SessionInsight {
  id: string;
  source: string | null;
  targetSessionPath: string | null;
  content: string;
  status: SessionInsightStatus;
  createdAt: string;
  consumedAt: string | null;
}

type AnyRecord = Record<string, unknown>;

const INSIGHT_STATUSES = new Set<SessionInsightStatus>(["unread", "consumed", "archived"]);

function asRecord(value: unknown): AnyRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as AnyRecord : {};
}

function cleanString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

function cleanStringArray(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((item) => cleanString(item, maxLength))
    .filter((item): item is string => !!item))]
    .slice(0, maxItems);
}

function cleanIso(value: unknown): string | null {
  const raw = cleanString(value, 64);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function hasMeaningfulDigest(value: SessionDigest): boolean {
  return !!(
    value.objective
    || value.status
    || value.summary
    || value.decisions.length
    || value.openQuestions.length
    || value.nextSteps.length
    || value.evidenceRefs.length
  );
}

export function normalizeSessionDigest(value: unknown): SessionDigest | null {
  const raw = asRecord(value);
  const digest: SessionDigest = {
    objective: cleanString(raw.objective ?? raw.goal, 500),
    status: cleanString(raw.status, 80),
    summary: cleanString(raw.summary, 4_000),
    decisions: cleanStringArray(raw.decisions, 12, 500),
    openQuestions: cleanStringArray(raw.openQuestions ?? raw.questions, 12, 500),
    nextSteps: cleanStringArray(raw.nextSteps ?? raw.todos, 12, 500),
    evidenceRefs: cleanStringArray(raw.evidenceRefs ?? raw.evidence, 20, 1_000),
    updatedAt: cleanIso(raw.updatedAt),
  };
  return hasMeaningfulDigest(digest) ? digest : null;
}

export function mergeSessionDigest(base: unknown, patch: unknown, now = new Date()): SessionDigest | null {
  const previous = normalizeSessionDigest(base);
  const rawPatch = asRecord(patch);
  const merged = normalizeSessionDigest({
    ...(previous || {}),
    ...rawPatch,
    updatedAt: rawPatch.updatedAt ?? now.toISOString(),
  });
  return merged;
}

function normalizeInsightStatus(value: unknown): SessionInsightStatus {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  return INSIGHT_STATUSES.has(raw as SessionInsightStatus) ? raw as SessionInsightStatus : "unread";
}

function defaultInsightId(now = new Date()): string {
  return `insight-${now.toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeSessionInsight(value: unknown, now = new Date()): SessionInsight | null {
  const raw = asRecord(value);
  const content = cleanString(raw.content ?? raw.text ?? raw.message, 8_000);
  if (!content) return null;
  const status = normalizeInsightStatus(raw.status);
  return {
    id: cleanString(raw.id, 160) || defaultInsightId(now),
    source: cleanString(raw.source ?? raw.from, 160),
    targetSessionPath: cleanString(raw.targetSessionPath ?? raw.target, 2048),
    content,
    status,
    createdAt: cleanIso(raw.createdAt) || now.toISOString(),
    consumedAt: status === "consumed" ? cleanIso(raw.consumedAt) : cleanIso(raw.consumedAt),
  };
}

export function normalizeSessionInsights(value: unknown, now = new Date()): SessionInsight[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: SessionInsight[] = [];
  for (const item of value) {
    const insight = normalizeSessionInsight(item, now);
    if (!insight || seen.has(insight.id)) continue;
    seen.add(insight.id);
    out.push(insight);
    if (out.length >= 100) break;
  }
  return out;
}

export function appendSessionInsight(base: unknown, insight: unknown, now = new Date()): SessionInsight[] {
  const nextInsight = normalizeSessionInsight(insight, now);
  const existing = normalizeSessionInsights(base, now);
  if (!nextInsight) return existing;
  return [nextInsight, ...existing.filter((item) => item.id !== nextInsight.id)].slice(0, 100);
}

export function consumeSessionInsights(base: unknown, ids?: unknown, now = new Date()): SessionInsight[] {
  const existing = normalizeSessionInsights(base, now);
  const idSet = Array.isArray(ids)
    ? new Set(ids.map((id) => String(id || "").trim()).filter(Boolean))
    : null;
  return existing.map((item) => {
    if (item.status !== "unread") return item;
    if (idSet && !idSet.has(item.id)) return item;
    return { ...item, status: "consumed", consumedAt: now.toISOString() };
  });
}

export function unreadInsightCount(value: unknown): number {
  return normalizeSessionInsights(value).filter((item) => item.status === "unread").length;
}
