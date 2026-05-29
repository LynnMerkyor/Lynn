/**
 * playback.ts — turn a worker JSONL string into fleet events and (optionally)
 * replay them on a timer. The same `dispatch` path the live WS handler will use,
 * so swapping the mock for a real `lynn worker run` stream is a drop-in later.
 */
import { parseFleetJsonLine, type FleetWorkerEvent } from '../../../../../shared/fleet-events.js';

export interface FleetCollectResult {
  events: FleetWorkerEvent[];
  skipped: string[];
}

/** Parse every non-empty line; valid events collected, malformed lines reported (never dropped silently). */
export function collectFleetEvents(jsonl: string): FleetCollectResult {
  const events: FleetWorkerEvent[] = [];
  const skipped: string[] = [];
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    const parsed = parseFleetJsonLine(line);
    if (parsed.ok && parsed.event) events.push(parsed.event);
    else skipped.push(parsed.raw ?? line);
  }
  return { events, skipped };
}

/**
 * Replay a fixture stream through `dispatch` on an interval. Returns a cancel fn
 * (call it from a React effect cleanup).
 */
export function playFleetFixture(
  jsonl: string,
  dispatch: (event: FleetWorkerEvent) => void,
  opts: { intervalMs?: number } = {},
): () => void {
  const { events } = collectFleetEvents(jsonl);
  const interval = opts.intervalMs ?? 300;
  let i = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;

  const step = () => {
    if (cancelled || i >= events.length) return;
    dispatch(events[i]);
    i += 1;
    if (i < events.length) timer = setTimeout(step, interval);
  };
  step();

  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
}
