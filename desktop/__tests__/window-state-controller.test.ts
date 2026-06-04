import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createWindowStateController } = require("../window-state-controller.cjs");

/* eslint-disable @typescript-eslint/no-explicit-any */

function fakeFs() {
  const store: Record<string, string> = {};
  return {
    store,
    readFileSync: (p: string) => { if (p in store) return store[p]; throw new Error("ENOENT"); },
    writeFileSync: (p: string, data: string) => { store[p] = data; },
  };
}

describe("createWindowStateController.load", () => {
  it("returns null when the state file is missing/invalid", () => {
    const c = createWindowStateController({ fs: { readFileSync: () => { throw new Error("ENOENT"); } }, path, lynnHome: "/h" });
    expect(c.load()).toBeNull();
  });
  it("clamps a darwin titlebar-overlapping y to 0", () => {
    const fs = { readFileSync: () => JSON.stringify({ x: 10, y: 20, width: 800, height: 600 }) };
    const c = createWindowStateController({ fs, path, lynnHome: "/h", platform: "darwin", titlebarHeight: 44 });
    expect(c.load()).toMatchObject({ x: 10, y: 0 });
  });
  it("leaves y untouched when maximized or non-darwin", () => {
    const mk = (platform: string, max: boolean) => createWindowStateController({
      fs: { readFileSync: () => JSON.stringify({ x: 10, y: 20, isMaximized: max }) }, path, lynnHome: "/h", platform,
    });
    expect(mk("darwin", true).load().y).toBe(20);
    expect(mk("win32", false).load().y).toBe(20);
  });
});

describe("createWindowStateController.saveSoon (debounced 500ms)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const win = (max: boolean) => ({
    isMaximized: () => max,
    getBounds: () => ({ x: 1, y: 2, width: 3, height: 4 }),
    getNormalBounds: () => ({ x: 9, y: 8, width: 7, height: 6 }),
  });

  it("debounces repeated calls into a single write of current bounds", () => {
    const fs = fakeFs();
    const c = createWindowStateController({ fs, path, lynnHome: "/h", getWindow: () => win(false) });
    c.saveSoon(); c.saveSoon(); c.saveSoon();
    expect(Object.keys(fs.store)).toHaveLength(0); // nothing yet
    vi.advanceTimersByTime(500);
    const out = JSON.parse(Object.values(fs.store)[0]);
    expect(out).toEqual({ x: 1, y: 2, width: 3, height: 4, isMaximized: false });
  });

  it("persists normalBounds + isMaximized when maximized", () => {
    const fs = fakeFs();
    const c = createWindowStateController({ fs, path, lynnHome: "/h", getWindow: () => win(true) });
    c.saveSoon();
    vi.advanceTimersByTime(500);
    expect(JSON.parse(Object.values(fs.store)[0])).toMatchObject({ x: 9, y: 8, isMaximized: true });
  });

  it("no-ops when there is no window", () => {
    const fs = fakeFs();
    const c = createWindowStateController({ fs, path, lynnHome: "/h", getWindow: () => null });
    c.saveSoon();
    vi.advanceTimersByTime(500);
    expect(Object.keys(fs.store)).toHaveLength(0);
  });
});
