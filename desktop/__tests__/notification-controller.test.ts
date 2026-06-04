import { describe, expect, it, vi } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createNotificationController } = require("../notification-controller.cjs");

/* eslint-disable @typescript-eslint/no-explicit-any */

// Fake Electron Notification class capturing instances + click handlers.
function makeNotification(supported = true) {
  const instances: any[] = [];
  class FakeNotification {
    static isSupported() { return supported; }
    opts: any; shown = false; handlers: Record<string, () => void> = {};
    constructor(opts: any) { this.opts = opts; instances.push(this); }
    on(event: string, fn: () => void) { this.handlers[event] = fn; }
    show() { this.shown = true; }
  }
  return { FakeNotification, instances };
}

function deps(overrides: Record<string, any> = {}) {
  const dock: any = { setBadge: vi.fn() };
  return {
    app: { dock },
    systemPreferences: { getNotificationSettings: () => ({ authorizationStatus: "authorized" }) },
    wrapIpcHandler: vi.fn(),
    mt: (k: string, _v: unknown, fb: string) => fb || k,
    getMainWindow: () => ({ isDestroyed: () => false, isMinimized: () => false, isVisible: () => true, isFocused: () => true, restore: vi.fn(), show: vi.fn(), focus: vi.fn() }),
    _dock: dock,
    ...overrides,
  };
}

describe("getPermissionStatus", () => {
  it("returns 'unsupported' when notifications are unsupported", () => {
    const { FakeNotification } = makeNotification(false);
    const c = createNotificationController(deps({ Notification: FakeNotification }));
    expect(c.getPermissionStatus()).toBe("unsupported");
  });
  it("maps the macOS authorizationStatus to a permission string", () => {
    const { FakeNotification } = makeNotification(true);
    if (process.platform !== "darwin") return; // mapping below is darwin-only
    const mk = (status: string) => createNotificationController(deps({
      Notification: FakeNotification,
      systemPreferences: { getNotificationSettings: () => ({ authorizationStatus: status }) },
    })).getPermissionStatus();
    expect(mk("authorized")).toBe("granted");
    expect(mk("denied")).toBe("denied");
    expect(mk("not-determined")).toBe("not-determined");
    expect(mk("provisional")).toBe("granted");
  });
});

describe("show", () => {
  it("creates + shows a notification, and focuses the main window on click", () => {
    const { FakeNotification, instances } = makeNotification(true);
    const win = { isDestroyed: () => false, isMinimized: () => true, isVisible: () => false, isFocused: () => false, restore: vi.fn(), show: vi.fn(), focus: vi.fn() };
    const c = createNotificationController(deps({ Notification: FakeNotification, getMainWindow: () => win }));
    c.show("Title", "Body");
    expect(instances).toHaveLength(1);
    expect(instances[0].shown).toBe(true);
    expect(instances[0].opts).toMatchObject({ title: "Title", body: "Body" });
    instances[0].handlers.click();
    expect(win.restore).toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalled();
  });
  it("does nothing when notifications are unsupported", () => {
    const { FakeNotification, instances } = makeNotification(false);
    createNotificationController(deps({ Notification: FakeNotification })).show("t", "b");
    expect(instances).toHaveLength(0);
  });
});

describe("register + clearDockBadge", () => {
  it("registers the 3 notification IPC channels", () => {
    const { FakeNotification } = makeNotification(true);
    const d = deps({ Notification: FakeNotification });
    createNotificationController(d).register();
    const channels = (d.wrapIpcHandler as any).mock.calls.map((c: any[]) => c[0]);
    expect(channels).toEqual(expect.arrayContaining([
      "get-notification-permission-status", "request-notification-permission", "show-notification",
    ]));
  });
  it("clearDockBadge clears the macOS dock badge", () => {
    const { FakeNotification } = makeNotification(true);
    const d = deps({ Notification: FakeNotification });
    createNotificationController(d).clearDockBadge();
    if (process.platform === "darwin") expect(d._dock.setBadge).toHaveBeenCalledWith("");
  });
});
