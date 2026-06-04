import { describe, expect, it, vi } from "vitest";
import path from "node:path";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createEditorWindowController } = require("../editor-window-controller.cjs");

/* eslint-disable @typescript-eslint/no-explicit-any */

class FakeBrowserWindow {
  opts: any; handlers: Record<string, any> = {}; wcHandlers: Record<string, any> = {}; destroyed = false; sent: any[] = [];
  webContents = { on: (e: string, fn: any) => { this.wcHandlers[e] = fn; }, send: (...a: any[]) => { this.sent.push(a); } };
  constructor(opts: any) { this.opts = opts; }
  on(e: string, fn: any) { this.handlers[e] = fn; }
  show() {} focus() {} hide() {} destroy() { this.destroyed = true; }
  isDestroyed() { return this.destroyed; }
}

function setup(canWriteAllowed: boolean) {
  const handlers: Record<string, any> = {};
  const grantWebContentsAccess = vi.fn();
  const mainSent: any[] = [];
  const c = createEditorWindowController({
    BrowserWindow: FakeBrowserWindow as any,
    nativeTheme: { shouldUseDarkColors: false },
    wrapIpcHandler: (name: string, fn: any) => { handlers[name] = fn; },
    dirname: "/app/desktop", loadWindowURL: vi.fn(), titleBarOpts: {}, themeBg: { "warm-paper": "#fff" },
    canWritePath: () => ({ allowed: canWriteAllowed }),
    grantWebContentsAccess,
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: (...a: any[]) => mainSent.push(a) } }),
    markPreferredPrimaryWindow: vi.fn(), isQuitting: () => false, closeFileWatchers: vi.fn(),
  });
  c.register();
  return { c, handlers, grantWebContentsAccess, mainSent };
}

describe("editor-window: open-editor-window security gate", () => {
  it("registers the 3 editor channels", () => {
    const { handlers } = setup(true);
    expect(Object.keys(handlers).sort()).toEqual(["editor-close", "editor-dock", "open-editor-window"]);
  });

  it("refuses to open when canWritePath denies the file", () => {
    const { c, handlers, grantWebContentsAccess } = setup(false);
    handlers["open-editor-window"]({ sender: {} }, { filePath: "/secret", title: "x" });
    expect(c.getWindow()).toBeNull();
    expect(grantWebContentsAccess).not.toHaveBeenCalled();
  });

  it("refuses to open when no filePath is given", () => {
    const { c, handlers } = setup(true);
    handlers["open-editor-window"]({ sender: {} }, {});
    expect(c.getWindow()).toBeNull();
  });

  it("opens + grants readwrite access when canWritePath allows", () => {
    const { c, handlers, grantWebContentsAccess } = setup(true);
    handlers["open-editor-window"]({ sender: {} }, { filePath: "/ok/file.md", title: "Doc" });
    expect(c.getWindow()).not.toBeNull();
    expect(grantWebContentsAccess).toHaveBeenCalledWith(expect.anything(), "/ok/file.md", "readwrite");
  });
});

describe("editor-window: dock/close notify the main window", () => {
  it("editor-dock sends editor-detached:false to the main window", () => {
    const { handlers, mainSent } = setup(true);
    handlers["editor-dock"]();
    expect(mainSent).toContainEqual(["editor-detached", false]);
  });
});
