import {
  CLIENT_EVENT_TYPES,
  REACT_CHAT_EVENT_TYPES,
  SERVER_EVENT_TYPES,
  createWsProtocolSnapshot,
  validateClientEvent,
  validateServerEvent,
} from "../shared/ws-events.js";
import type { ClientEvent, ServerEvent } from "../shared/ws-events.js";

export {
  CLIENT_EVENT_TYPES,
  REACT_CHAT_EVENT_TYPES,
  SERVER_EVENT_TYPES,
  createWsProtocolSnapshot,
  validateClientEvent,
  validateServerEvent,
};

const warnedServerEvents = new Set();
const warnedClientEvents = new Set();

interface JsonWebSocket {
  readyState: number;
  send(data: string): void;
}

/** 安全地发送 JSON 消息到 WebSocket */
export function wsSend(ws: JsonWebSocket, msg: ServerEvent | Record<string, unknown>): void {
  if (ws.readyState === 1) { // OPEN
    const validation = validateServerEvent(msg);
    if (!validation.ok) {
      const key = `${msg?.type || "(missing)"}:${validation.errors.join("|")}`;
      if (!warnedServerEvents.has(key)) {
        warnedServerEvents.add(key);
        console.warn(`[ws-protocol] invalid server event: ${validation.errors.join("; ")}`);
      }
    }
    ws.send(JSON.stringify(msg));
  }
}

/** 安全地解析 WebSocket 消息（兼容 Buffer / string / ArrayBuffer） */
export function wsParse(data: string | ArrayBuffer | Buffer | { toString?: () => string } | null | undefined): ClientEvent | Record<string, unknown> | null {
  try {
    const str = typeof data === "string" ? data : (data?.toString?.() ?? String(data));
    const msg = JSON.parse(str);
    const validation = validateClientEvent(msg);
    if (!validation.ok) {
      const key = `${msg?.type || "(missing)"}:${validation.errors.join("|")}`;
      if (!warnedClientEvents.has(key)) {
        warnedClientEvents.add(key);
        console.warn(`[ws-protocol] invalid client event: ${validation.errors.join("; ")}`);
      }
    }
    return msg;
  } catch {
    return null;
  }
}
