import { afterEach, describe, expect, it, vi } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createTrayController } = require("../tray-controller.cjs");

/* eslint-disable @typescript-eslint/no-explicit-any */

let savedPlatform: PropertyDescriptor | undefined;
function withPlatform(p: string) {
  savedPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}
afterEach(() => { if (savedPlatform) { Object.defineProperty(process, "platform", savedPlatform); savedPlatform = undefined; } });

function deps(overrides: Record<string, any> = {}) {
  let lastMenu: any = null;
  const FakeTray = class {
    destroyed = false; tip = ""; handlers: Record<string, () => void> = {};
    setToolTip(t: string) { this.tip = t; }
    on(e: string, fn: () => void) { this.handlers[e] = fn; }
    setContextMenu(m: any) { this.contextMenu = m; }
    destroy() { this.destroyed = true; }
    isDestroyed() { return this.destroyed; }
    contextMenu: any;
  };
  return {
    Tray: FakeTray,
    Menu: { buildFromTemplate: (tmpl: any) => { lastMenu = tmpl; return tmpl; } },
    app: {},
    fs: { existsSync: () => true },
    dirname: "/app/desktop",
    lynnHome: "/dev/elsewhere", // != ~/.lynn → isDev true (irrelevant to logic)
    mt: (k: string, _v: unknown, fb: string) => fb || k,
    nativeImage: { createFromPath: () => ({ setTemplateImage: vi.fn() }) },
    onQuit: vi.fn(), onSettings: vi.fn(), onShow: vi.fn(),
    _lastMenu: () => lastMenu,
    ...overrides,
  };
}

describe("createTrayController", () => {
  it("creates no tray on macOS (uses the dock instead)", () => {
    withPlatform("darwin");
    const c = createTrayController(deps());
    c.create();
    expect(c.exists()).toBe(false);
  });

  it("on linux/win builds a tray with show/settings/quit menu wired to callbacks", () => {
    withPlatform("linux");
    const d = deps();
    const c = createTrayController(d);
    c.create();
    expect(c.exists()).toBe(true);

    const menu = d._lastMenu();
    const labels = menu.filter((m: any) => m.label).map((m: any) => m.label);
    expect(labels).toEqual(["Show Lynn", "Settings", "Quit"]);

    // clicking each menu item fires the right callback
    menu.find((m: any) => m.label === "Show Lynn").click();
    menu.find((m: any) => m.label === "Settings").click();
    menu.find((m: any) => m.label === "Quit").click();
    expect(d.onShow).toHaveBeenCalled();
    expect(d.onSettings).toHaveBeenCalled();
    expect(d.onQuit).toHaveBeenCalled();
  });

  it("destroy() tears the tray down", () => {
    withPlatform("linux");
    const c = createTrayController(deps());
    c.create();
    expect(c.exists()).toBe(true);
    c.destroy();
    expect(c.exists()).toBe(false);
  });
});
