import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { createUiTestIsolation } = require('../desktop/ui-test-isolation.cjs');
const HOME = path.resolve('/users/test');

function fixture() {
  class Window {
    static instances = [];
    static getAllWindows() { return this.instances; }
    constructor(options) { this.options = options; this.visible = Boolean(options.show); Window.instances.push(this); }
    show() { this.visible = true; }
    showInactive() { this.visible = true; }
    focus() { this.focused = true; }
    restore() { this.visible = true; }
    maximize() { this.visible = true; }
    setFullScreen() { this.visible = true; }
    setSimpleFullScreen() { this.visible = true; }
  }
  class Notification { show() { this.shown = true; } }
  return { BrowserWindow: Window, Notification, shell: { openExternal: vi.fn() }, dialog: { showErrorBox: vi.fn() } };
}
const env = { LYNN_UI_HEADLESS: '1', LYNN_HOME: path.resolve('/tmp/lynn-ui-hidden-test') };

describe('isolated hidden UI tests', () => {
  it('leaves production constructors and APIs unchanged by default', () => {
    const original = fixture(); const result = createUiTestIsolation(original, {}, HOME);
    expect(result.enabled).toBe(false);
    expect(result.BrowserWindow).toBe(original.BrowserWindow);
    expect(result.Notification).toBe(original.Notification);
    expect(result.shell).toBe(original.shell);
    expect(result.dialog).toBe(original.dialog);
    const win = new result.BrowserWindow({ show: true }); expect(win.visible).toBe(true);
  });
  it.each([{}, { LYNN_HOME: path.join(HOME, '.lynn') }, { LYNN_HOME: '~/.lynn' }])('rejects non-isolated homes %j', extra => {
    expect(() => createUiTestIsolation(fixture(), { LYNN_UI_HEADLESS: '1', ...extra }, HOME)).toThrow('isolated LYNN_HOME');
  });
  it('keeps all native windows hidden while preserving renderer security options and static APIs', () => {
    const original = fixture(); const result = createUiTestIsolation(original, env, HOME);
    const options = { show: true, webPreferences: { contextIsolation: true, nodeIntegration: false, preload: '/test/preload.cjs' } };
    const win = new result.BrowserWindow(options);
    for (const method of ['show', 'showInactive', 'focus', 'restore', 'maximize', 'setFullScreen', 'setSimpleFullScreen']) win[method](true);
    expect(win.visible).toBe(false); expect(win.focused).not.toBe(true);
    expect(result.BrowserWindow.getAllWindows()).toEqual([win]);
    expect(win).toBeInstanceOf(original.BrowserWindow);
    expect(win.options.webPreferences).toEqual({ ...options.webPreferences, backgroundThrottling: false });
    expect(options.show).toBe(true); expect(result.suppressed).toHaveLength(7);
  });
  it('suppresses native notifications', () => {
    const result = createUiTestIsolation(fixture(), env, HOME);
    const notification = new result.Notification({ title: 'test' }); notification.show();
    expect(notification.shown).not.toBe(true);
  });
  it('rejects external navigation and native dialogs instead of opening user UI', async () => {
    const original = fixture(); const result = createUiTestIsolation(original, env, HOME);
    await expect(result.shell.openExternal('https://example.com')).rejects.toThrow('hidden UI test');
    await expect(result.dialog.showOpenDialog({})).rejects.toThrow('hidden UI test');
    expect(() => result.dialog.showSaveDialogSync({})).toThrow('hidden UI test');
    expect(original.shell.openExternal).not.toHaveBeenCalled();
  });
});
