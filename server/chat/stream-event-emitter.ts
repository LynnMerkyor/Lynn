import { appendSessionStreamEvent } from "../session-stream-store.js";

export interface StreamEventPayload {
  [key: string]: unknown;
}

export interface SessionStreamEntry {
  streamId: string | null;
  seq: number;
  event: StreamEventPayload;
  ts: number;
}

export interface SessionStreamState {
  streamId?: string | null;
  nextSeq: number;
  events: SessionStreamEntry[];
  maxEvents: number;
  [key: string]: unknown;
}

export type SessionStreamBroadcast = (
  event: StreamEventPayload & { sessionPath: string; streamId: string | null; seq: number },
) => void;

/**
 * Persists an event into the in-memory stream state and broadcasts the public
 * envelope expected by chat clients.
 */
export function emitSessionStreamEvent(
  sessionPath: string,
  ss: SessionStreamState,
  event: StreamEventPayload,
  broadcast: SessionStreamBroadcast,
): SessionStreamEntry {
  const entry = appendSessionStreamEvent(ss, event) as SessionStreamEntry;
  broadcast({
    ...event,
    sessionPath,
    streamId: entry.streamId,
    seq: entry.seq,
  });
  return entry;
}
