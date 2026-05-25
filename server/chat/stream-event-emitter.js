// @ts-check

import { appendSessionStreamEvent } from "../session-stream-store.js";

/**
 * @typedef {{ [key: string]: any }} StreamEventPayload
 * @typedef {{ streamId: string | null, seq: number, event: StreamEventPayload, ts: number }} SessionStreamEntry
 * @typedef {{ streamId?: string | null, nextSeq: number, events: SessionStreamEntry[], maxEvents: number, [key: string]: any }} SessionStreamState
 * @typedef {(event: StreamEventPayload & { sessionPath: string, streamId: string | null, seq: number }) => void} SessionStreamBroadcast
 */

/**
 * Persists an event into the in-memory stream state and broadcasts the public
 * envelope expected by chat clients.
 *
 * @param {string} sessionPath
 * @param {SessionStreamState} ss
 * @param {StreamEventPayload} event
 * @param {SessionStreamBroadcast} broadcast
 * @returns {SessionStreamEntry}
 */
export function emitSessionStreamEvent(sessionPath, ss, event, broadcast) {
  const entry = appendSessionStreamEvent(ss, event);
  broadcast({
    ...event,
    sessionPath,
    streamId: entry.streamId,
    seq: entry.seq,
  });
  return entry;
}
