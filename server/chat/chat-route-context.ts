export interface ChatRouteRuntimeOptions<UpgradeWebSocket = unknown> {
  upgradeWebSocket: UpgradeWebSocket;
}

export interface ChatRouteContext<Engine = unknown, Hub = unknown, UpgradeWebSocket = unknown> {
  engine: Engine;
  hub: Hub;
  upgradeWebSocket: UpgradeWebSocket;
}

export function createChatRouteContext<Engine, Hub, UpgradeWebSocket>(
  engine: Engine,
  hub: Hub,
  options: ChatRouteRuntimeOptions<UpgradeWebSocket>,
): ChatRouteContext<Engine, Hub, UpgradeWebSocket> {
  return {
    engine,
    hub,
    upgradeWebSocket: options.upgradeWebSocket,
  };
}
