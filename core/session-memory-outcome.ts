import { isMemoryOutcomeFeedbackEnabled, normalizeMemoryOutcome, type MemoryOutcome } from "../lib/memory/outcome-feedback.js";

type AnyRecord = Record<string, any>;

function normalizeFactIds(value: unknown): Array<string | number> {
  if (!Array.isArray(value)) return [];
  const ids: Array<string | number> = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const key = String(raw || "").trim();
    if (!key || seen.has(key)) continue;
    if (!Number.isInteger(raw) && !/^[0-9]+$/.test(key)) continue;
    seen.add(key);
    ids.push(raw as string | number);
  }
  return ids;
}

export function markInjectedMemoryOutcome(opts: {
  entry: AnyRecord | null | undefined;
  agent: AnyRecord | null | undefined;
  outcome: MemoryOutcome | string;
  reason: string;
}): number {
  if (!isMemoryOutcomeFeedbackEnabled()) return 0;

  const outcome = normalizeMemoryOutcome(opts.outcome);
  if (!outcome) return 0;

  const ids = normalizeFactIds(opts.entry?._lastRecallFactIds);
  if (ids.length === 0) return 0;

  // TODO(P0 follow-up): wire other strong signals only from their real owners:
  // explicit user correction, explicit task acceptance, and edit-resend/
  // regenerate events from the chat route. Do not infer helpful from silence.
  try {
    return Number(opts.agent?.factStore?.markOutcome?.(ids, outcome) || 0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[memory-outcome] mark ${outcome} failed: ${message}`);
    return 0;
  }
}

export function markInjectedMemoryOutcomeOnce(opts: {
  entry: AnyRecord | null | undefined;
  agent: AnyRecord | null | undefined;
  outcome: MemoryOutcome | string;
  reason: string;
  markerKey: string;
}): number {
  if (!opts.entry) return 0;
  if (opts.entry[opts.markerKey]) return 0;
  const touched = markInjectedMemoryOutcome(opts);
  if (touched > 0) opts.entry[opts.markerKey] = true;
  return touched;
}
