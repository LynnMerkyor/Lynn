import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  adapter: { sendReply: vi.fn(), stop: vi.fn() },
  createFeishuAdapter: vi.fn(),
}));

vi.mock("../lib/bridge/telegram-adapter.js", () => ({ createTelegramAdapter: vi.fn() }));
vi.mock("../lib/bridge/feishu-adapter.js", () => ({ createFeishuAdapter: mocks.createFeishuAdapter }));
vi.mock("../lib/debug-log.js", () => ({ debugLog: () => null }));

import { BridgeManager } from "../lib/bridge/bridge-manager.js";

describe("BridgeManager Feishu status", () => {
  it("keeps Feishu connected after the adapter handshake resolves", async () => {
    mocks.createFeishuAdapter.mockResolvedValueOnce(mocks.adapter);
    const emitted = vi.fn();
    const manager = new BridgeManager({
      engine: {
        lynnHome: "/tmp",
        getPreferences: () => ({ bridge: {} }),
        agent: {},
      },
      hub: { eventBus: { emit: emitted } },
    });

    await manager.startPlatform("feishu", { appId: "cli_test", appSecret: "secret" });

    expect(manager.getStatus().feishu).toEqual({ status: "connected", error: null });
    expect(emitted).toHaveBeenCalledWith(expect.objectContaining({ type: "bridge_status", platform: "feishu", status: "connected" }), null);
  });
});
