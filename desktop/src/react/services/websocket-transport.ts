let activeWebSocket: WebSocket | null = null;

export function getWebSocket(): WebSocket | null {
  return activeWebSocket;
}

export function setWebSocket(socket: WebSocket): void {
  activeWebSocket = socket;
}

export function clearWebSocket(socket?: WebSocket): void {
  if (!socket || activeWebSocket === socket) activeWebSocket = null;
}
