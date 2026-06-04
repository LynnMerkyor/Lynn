import { describe, expect, it, vi } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createVoiceTunnelController } = require("../voice-tunnel-controller.cjs");

/* eslint-disable @typescript-eslint/no-explicit-any */

function makeVTM() {
  const instances: any[] = [];
  class FakeVoiceTunnelManager {
    opts: any; started = false; stopped = false;
    constructor(opts: any) { this.opts = opts; instances.push(this); }
    start() { this.started = true; }
    stop() { this.stopped = true; }
    getStatus() { return { running: true, tunnel: "up" }; }
  }
  return { FakeVoiceTunnelManager, instances };
}

function deps(VTM: any, windows: any[] = []) {
  return {
    BrowserWindow: { getAllWindows: () => windows },
    VoiceTunnelManager: VTM,
    wrapIpcHandler: vi.fn(),
  };
}

describe("createVoiceTunnelController", () => {
  it("start() constructs + starts the manager and is idempotent", () => {
    const { FakeVoiceTunnelManager, instances } = makeVTM();
    const c = createVoiceTunnelController(deps(FakeVoiceTunnelManager));
    c.start();
    c.start(); // idempotent
    expect(instances).toHaveLength(1);
    expect(instances[0].started).toBe(true);
  });

  it("broadcasts onState to all live windows as 'voice-tunnel-state'", () => {
    const { FakeVoiceTunnelManager, instances } = makeVTM();
    const send = vi.fn();
    const win = { isDestroyed: () => false, webContents: { send } };
    const c = createVoiceTunnelController(deps(FakeVoiceTunnelManager, [win]));
    c.start();
    instances[0].opts.onState({ phase: "connected" });
    expect(send).toHaveBeenCalledWith("voice-tunnel-state", { phase: "connected" });
  });

  it("status() reflects running vs stopped; stop() tears down", () => {
    const { FakeVoiceTunnelManager } = makeVTM();
    const c = createVoiceTunnelController(deps(FakeVoiceTunnelManager));
    expect(c.status()).toEqual({ stopped: true });
    c.start();
    expect(c.status()).toEqual({ running: true, tunnel: "up" });
    c.stop();
    expect(c.status()).toEqual({ stopped: true });
  });

  it("register registers the status channel", () => {
    const { FakeVoiceTunnelManager } = makeVTM();
    const d = deps(FakeVoiceTunnelManager);
    createVoiceTunnelController(d).register();
    expect((d.wrapIpcHandler as any).mock.calls.map((c: any[]) => c[0])).toEqual(["voice-tunnel-status"]);
  });
});
