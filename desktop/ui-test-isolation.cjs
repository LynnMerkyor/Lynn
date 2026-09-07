const os = require('node:os');
const path = require('node:path');

// Explicit, process-local rendering tests only. Never hide a normal user session.
function createUiTestIsolation(electron, env = process.env, home = os.homedir()) {
  const enabled = env.LYNN_UI_HEADLESS === '1';
  if (!enabled) return { ...electron, enabled: false };
  const testHome = env.LYNN_HOME && path.resolve(env.LYNN_HOME.replace(/^~/, home));
  if (!testHome || testHome === path.join(home, '.lynn')) {
    throw new Error('LYNN_UI_HEADLESS requires an isolated LYNN_HOME');
  }
  const suppressed = [];
  const wrapConstructor = (Original, hiddenWindow) => new Proxy(Original, {
    construct(Target, args) {
      const options = args[0] || {};
      const next = hiddenWindow ? {
        ...options, show: false,
        webPreferences: { ...options.webPreferences, backgroundThrottling: false },
      } : options;
      const instance = Reflect.construct(Target, [next, ...args.slice(1)]);
      const methods = hiddenWindow
        ? ['show', 'showInactive', 'focus', 'restore', 'maximize', 'setFullScreen', 'setSimpleFullScreen']
        : ['show'];
      for (const method of methods) {
        if (typeof instance[method] !== 'function') continue;
        Object.defineProperty(instance, method, { configurable: true, value: () => {
          suppressed.push({ type: hiddenWindow ? 'window' : 'notification', method });
        } });
      }
      return instance;
    },
    get(Target, key) {
      const value = Reflect.get(Target, key, Target);
      return typeof value === 'function' ? value.bind(Target) : value;
    },
  });
  const rejectDialog = async () => { throw new Error('Native dialog disabled in hidden UI test'); };
  const rejectDialogSync = () => { throw new Error('Native dialog disabled in hidden UI test'); };
  return {
    ...electron, enabled: true, suppressed,
    BrowserWindow: wrapConstructor(electron.BrowserWindow, true),
    Notification: wrapConstructor(electron.Notification, false),
    shell: { ...electron.shell,
      openExternal: rejectDialog, openPath: rejectDialog, showItemInFolder: rejectDialogSync,
    },
    dialog: { ...electron.dialog,
      showOpenDialog: rejectDialog, showSaveDialog: rejectDialog, showMessageBox: rejectDialog,
      showOpenDialogSync: rejectDialogSync, showSaveDialogSync: rejectDialogSync, showMessageBoxSync: rejectDialogSync,
      showErrorBox: (title) => { console.error('[hidden-ui-test] native error dialog suppressed:', title); },
    },
  };
}

module.exports = { createUiTestIsolation };
