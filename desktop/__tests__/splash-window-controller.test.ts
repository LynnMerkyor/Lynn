import { describe, expect, it, vi } from "vitest";
import path from "node:path";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createSplashWindow } = require("../splash-window-controller.cjs");

/* eslint-disable @typescript-eslint/no-explicit-any */

class FakeBrowserWindow {
  opts: any; handlers: Record<string, () => void> = {}; shown = false;
  constructor(opts: any) { this.opts = opts; }
  setWindowButtonVisibility() {}
  once(e: string, fn: () => void) { this.handlers[e] = fn; }
  on(e: string, fn: () => void) { this.handlers[e] = fn; }
  show() { this.shown = true; }
}

describe("createSplashWindow", () => {
  it("creates a frameless transparent splash and loads the splash route", () => {
    const loadWindowURL = vi.fn();
    const win = createSplashWindow({ BrowserWindow: FakeBrowserWindow as any, path, dirname: "/app/desktop", loadWindowURL, onClosed: vi.fn() });
    expect(win.opts).toMatchObject({ width: 380, height: 280, frame: false, transparent: true, show: false, resizable: false });
    expect(loadWindowURL).toHaveBeenCalledWith(win, "splash");
  });

  it("shows itself on ready-to-show and fires onClosed on close", () => {
    const onClosed = vi.fn();
    const win = createSplashWindow({ BrowserWindow: FakeBrowserWindow as any, path, dirname: "/app/desktop", loadWindowURL: () => {}, onClosed });
    win.handlers["ready-to-show"]();
    expect(win.shown).toBe(true);
    win.handlers["closed"]();
    expect(onClosed).toHaveBeenCalled();
  });
});
