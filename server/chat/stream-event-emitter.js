import { appendSessionStreamEvent } from "../session-stream-store.js";

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
