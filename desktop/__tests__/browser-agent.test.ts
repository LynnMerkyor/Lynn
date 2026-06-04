import { describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createBrowserAgentController } = require("../browser-agent.cjs");

/* eslint-disable @typescript-eslint/no-explicit-any */

// Minimal deps — the paths under test (command routing, guards, state accessors)
// don't touch the WebContentsView/window lifecycle (that's GUI-smoke territory).
function ctl() {
  return createBrowserAgentController({
    BrowserWindow: {}, WebContentsView: class {}, session: {},
    loadWindowURL: () => {}, preloadPath: "", themeBg: {}, titlebarHeight: 44,
    getIsQuitting: () => false,
    markPreferredPrimaryWindow: () => {}, getPreferredPrimaryWindowKind: () => null, setPreferredPrimaryWindowKind: () => {},
    getServerPort: () => null, getServerToken: () => null,
  });
}

describe("browser-agent: state accessors", () => {
  it("starts with no active view/window and a default theme", () => {
    const c = ctl();
    expect(c.getWebView()).toBeNull();
    expect(c.getWindow()).toBeNull();
    expect(c.getTheme()).toBe("warm-paper");
  });
  it("setTheme updates the theme", () => {
    const c = ctl();
    c.setTheme("midnight");
    expect(c.getTheme()).toBe("midnight");
    c.setTheme(undefined); // ignored
    expect(c.getTheme()).toBe("midnight");
  });
});

describe("browser-agent: handleCommand routing + guards", () => {
  it("resume with an unknown session returns { found:false }", async () => {
    expect(await ctl().handleCommand("resume", { sessionPath: "/nope" })).toEqual({ found: false });
  });

  it("delegates view-action commands to runBrowserAction (guards 'not launched')", async () => {
    await expect(ctl().handleCommand("snapshot", {})).rejects.toThrow("Browser not launched");
  });

  it("navigate routes through the URL guard before touching the view", async () => {
    await expect(ctl().handleCommand("navigate", { url: "file:///etc/passwd" }))
      .rejects.toThrow("Only http/https URLs are allowed");
  });

  it("rejects an unknown command", async () => {
    await expect(ctl().handleCommand("teleport", {})).rejects.toThrow("Unknown browser command");
  });

  it("close / suspend are safe no-ops when nothing is launched", async () => {
    const c = ctl();
    expect(await c.handleCommand("close", {})).toEqual({});
    expect(await c.handleCommand("suspend", {})).toEqual({});
    expect(c.getWebView()).toBeNull();
  });
});

describe("browser-agent: nav controls are safe with no active view", () => {
  it("goBack / goForward / reload / emergencyStop do not throw", () => {
    const c = ctl();
    expect(() => { c.goBack(); c.goForward(); c.reload(); c.emergencyStop(); }).not.toThrow();
  });
});
