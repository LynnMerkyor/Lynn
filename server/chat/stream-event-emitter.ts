import { appendSessionStreamEvent } from "../session-stream-store.js";
import type {
  SessionStreamEntry as StoredSessionStreamEntry,
  SessionStreamEvent,
  SessionStreamState as StoredSessionStreamState,
} from "../session-stream-store.js";

export type StreamEventPayload = SessionStreamEvent;
export type SessionStreamEntry = StoredSessionStreamEntry;
export type SessionStreamState = StoredSessionStreamState;

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
