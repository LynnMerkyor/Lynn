import { describe, expect, it, vi } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createGlobalSummonController } = require("../global-summon-controller.cjs");

/* eslint-disable @typescript-eslint/no-explicit-any */

function deps(overrides: Record<string, any> = {}) {
  const prefs: Record<string, any> = {};
  let capturedToggle: (() => void) | null = null;
  return {
    prefs,
    getToggle: () => capturedToggle,
    globalShortcut: { unregister: vi.fn() },
    normalizeConfiguredShortcut: (a: any) => (a ? String(a) : null),
    platform: "darwin",
    readUserPreferences: () => ({ ...prefs }),
    writeUserPreferences: (p: any) => { for (const k of Object.keys(prefs)) delete prefs[k]; Object.assign(prefs, p); },
    registerFirstAvailableGlobalShortcut: vi.fn((_gs: any, toggle: () => void, _plat: any, configured: any) => {
      capturedToggle = toggle;
      return { ok: true, accelerator: configured || "Cmd+Shift+L", fallbackUsed: false, attempted: [configured || "Cmd+Shift+L"], layer: "configured", errors: {} };
    }),
    showPrimaryWindow: vi.fn(),
    writeUserPreferencesSpy: vi.fn(),
    wrapIpcHandler: vi.fn(),
    getMainWindow: () => null,
    ...overrides,
  };
}

describe("createGlobalSummonController", () => {
  it("register() wires the shortcut and exposes its status", () => {
    const d = deps();
    const c = createGlobalSummonController(d);
    const result = c.register("Cmd+Shift+L");
    expect(result.ok).toBe(true);
    expect(c.status().accelerator).toBe("Cmd+Shift+L");
    expect(d.registerFirstAvailableGlobalShortcut).toHaveBeenCalled();
  });

  it("setShortcut() persists the preference then registers", () => {
    const d = deps();
    const c = createGlobalSummonController(d);
    c.setShortcut("Cmd+Option+J");
    expect(d.prefs.jarvis_global_shortcut).toBe("Cmd+Option+J");
    expect(c.status().accelerator).toBe("Cmd+Option+J");
  });

  it("the registered toggle focuses an existing main window and sends 'global-summon'", () => {
    const send = vi.fn();
    const win = { isDestroyed: () => false, isMinimized: () => true, isVisible: () => false, restore: vi.fn(), show: vi.fn(), focus: vi.fn(), webContents: { send } };
    const d = deps({ getMainWindow: () => win });
    const c = createGlobalSummonController(d);
    c.register("Cmd+Shift+L");
    d.getToggle()!(); // simulate the global shortcut firing
    expect(win.restore).toHaveBeenCalled();
    expect(win.show).toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith("global-summon");
  });

  it("the toggle falls back to showPrimaryWindow when there is no main window", () => {
    const d = deps({ getMainWindow: () => null });
    const c = createGlobalSummonController(d);
    c.register("Cmd+Shift+L");
    d.getToggle()!();
    expect(d.showPrimaryWindow).toHaveBeenCalled();
  });

  it("registerIpc registers the status + set channels", () => {
    const d = deps();
    createGlobalSummonController(d).registerIpc();
    const channels = (d.wrapIpcHandler as any).mock.calls.map((c: any[]) => c[0]);
    expect(channels).toEqual(["get-global-summon-shortcut-status", "set-global-summon-shortcut"]);
  });
});
