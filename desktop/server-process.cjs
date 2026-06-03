"use strict";

// Server-process helpers extracted from main.cjs (cut: server-process, part 1).
//
// SCOPE NOTE: only the STATELESS helpers live here. The stateful launch path
// (startServer / monitorServer / heartbeat) stays in main.cjs because it
// assigns the shared serverProcess/serverPort/serverToken vars and is the app's
// boot path — moving it needs a real Electron launch-smoke, not just unit tests.
//
// Stays .cjs because Electron runs main.cjs raw in dev (no .ts loader for the
// main process).

const fs = require("fs");

// Default i18n passthrough so the module never hard-depends on main.cjs's mt().
const defaultMt = (key, _vars, fallback) => fallback || key;

// Poll the server-info file until the server writes it (and its PID is alive),
// or the child process exits, or the timeout elapses. `mt` is injected for
// localized error messages; `proc` (the spawned child) lets us fail fast on exit.
function pollServerInfo(infoPath, { timeout = 60000, interval = 200, process: proc, mt = defaultMt } = {}) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    let exited = false;

    if (proc) {
      proc.on("exit", (code, signal) => {
        exited = true;
        reject(new Error(
          signal
            ? mt("dialog.serverKilledBySignal", { signal })
            : mt("dialog.serverExitedWithCode", { code })
        ));
      });
    }

    const check = () => {
      if (exited) return;
      if (Date.now() > deadline) {
        reject(new Error(mt("dialog.serverStartTimeout", null, "Server start timed out (60s)")));
        return;
      }
      try {
        const info = JSON.parse(fs.readFileSync(infoPath, "utf-8"));
        // 确认 PID 存活
        try { process.kill(info.pid, 0); } catch { setTimeout(check, interval); return; }
        resolve(info);
      } catch {
        setTimeout(check, interval);
      }
    };
    check();
  });
}

// Decide whether an already-running server (its /api/health payload) can be
// reused instead of spawning a new one. `expectedVersion` is injected from the
// caller (app.getVersion()) so this stays pure/testable.
function isReusableServerHealth(health, expectedVersion = "") {
  if (!health || health.status !== "ok") return false;

  // Windows 覆盖安装后最容易留下旧版 lynn-server.exe。旧 server 的
  // /api/health 仍可能返回 200，但缺少新前端依赖的能力（例如
  // /api/translate、/api/tools/tts-bridge.tts_speak），会表现为 404。
  const serverVersion = String(health.version || "").trim();
  if (expectedVersion && serverVersion && serverVersion !== expectedVersion) {
    return false;
  }

  const features = health.features || {};
  if (features.translateRoute !== true || features.toolsRoute !== true) {
    return false;
  }

  return true;
}

module.exports = { pollServerInfo, isReusableServerHealth };
