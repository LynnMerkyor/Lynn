"use strict";

// Server-process helpers extracted from main.cjs (state-migration §1, Step S1).
//
// SCOPE NOTE: only the STATELESS / pure helpers live here. The stateful launch
// path (startServer / monitorServer / heartbeat) stays in main.cjs for now and
// migrates into createServerProcessController in S2-S4 — that needs a real
// Electron launch-smoke, not just unit tests.
//
// Stays .cjs because Electron runs main.cjs raw in dev (no .ts loader for the
// main process). Every helper takes its environment (existsSync, platform,
// paths, process) injected so it is pure and unit-testable without Electron.

const fs = require("fs");
const path = require("path");

// Default i18n passthrough so the module never hard-depends on main.cjs's mt().
const defaultMt = (key, _vars, fallback) => fallback || key;

// process.kill(pid, 0) probes liveness without sending a real signal.
function isPidAlive(pid, proc = process) {
  try { proc.kill(pid, 0); return true; } catch { return false; }
}

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
        if (!isPidAlive(info.pid)) { setTimeout(check, interval); return; }
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

// Resolve the native AEC module dir to inject as LYNN_AEC_NATIVE_DIR.
//   dev:  <dirname>/native-modules/aec
//   prod: app.asar.unpacked/.../native-modules/aec (asarUnpack)
// Returns the existing dir or null (caller only sets the env var when non-null).
function resolveAecNativeDir({ dirname, existsSync }) {
  const devAecDir = path.join(dirname, "native-modules", "aec");
  const unpackedAecDir = dirname.includes("app.asar")
    ? path.join(dirname.replace("app.asar", "app.asar.unpacked"), "native-modules", "aec")
    : devAecDir;
  const aecDir = existsSync(unpackedAecDir) ? unpackedAecDir : devAecDir;
  return existsSync(aecDir) ? aecDir : null;
}

// Inject the bundled MinGit paths into a Windows server env. Mutates and returns
// `env`. No-op on non-win32. Handles the Path/PATH casing trap deliberately.
function injectWindowsGitPath(env, { platform, resourcesPath, existsSync }) {
  if (platform !== "win32") return env;
  // MinGit-busybox 结构：cmd/git.exe, mingw64/bin/git.exe+sh.exe
  const gitRoot = path.join(resourcesPath || "", "git");
  const gitPaths = [
    path.join(gitRoot, "mingw64", "bin"),
    path.join(gitRoot, "cmd"),
  ].filter(p => existsSync(p));
  if (gitPaths.length) {
    // Windows 的 PATH 环境变量 key 可能是 "Path"（title case）或 "PATH"，
    // { ...process.env } 展开后变成普通对象（区分大小写）。必须找到原始
    // key 并删除，否则会同时存在 Path 和 PATH 两个 key，spawn 子进程的
    // PATH 不可预测。
    const pathKey = Object.keys(env).find(k => k.toLowerCase() === "path") || "PATH";
    const existingPath = env[pathKey] || "";
    if (pathKey !== "PATH") delete env[pathKey];
    env.PATH = gitPaths.join(";") + ";" + existingPath;
  }
  return env;
}

// Pick how to launch the server (bundled standalone vs dev source), returning
// the binary, args, extra env, and which mode was chosen. Pure given existsSync.
//   - bundled (extraResources/server present): HANA_ROOT set
//   - dev: Electron's own Node via ELECTRON_RUN_AS_NODE=1 on the source entry
function resolveBundledServerLaunch({ platform, resourcesPath, dirname, execPath, existsSync }) {
  const bundledServerDir = path.join(resourcesPath || "", "server");
  const bundledWrapper = path.join(bundledServerDir, "lynn-server");
  const bundledExe = path.join(bundledServerDir, "lynn-server.exe");
  const bundledNode = path.join(bundledServerDir, platform === "win32" ? "lynn-server.exe" : "node");
  const bundledEntry = path.join(bundledServerDir, "bundle", "index.js");
  const hasBundledWrapper = existsSync(bundledWrapper) || existsSync(bundledExe);
  const hasBundledNodeRuntime = existsSync(bundledNode) && existsSync(bundledEntry);

  if (hasBundledWrapper || hasBundledNodeRuntime) {
    // 打包模式：优先使用 extraResources 里的独立 server。兼容两种产物：
    // 1. 旧结构：macOS/Linux lynn-server shell wrapper；Windows lynn-server.exe
    // 2. 新结构：直接带 node/lynn-server.exe + bundle/index.js
    let serverBin, serverArgs;
    if (platform === "win32") {
      serverBin = existsSync(bundledExe) ? bundledExe : bundledNode;
      serverArgs = [bundledEntry];
    } else if (hasBundledNodeRuntime) {
      serverBin = bundledNode;
      serverArgs = [bundledEntry];
    } else {
      serverBin = bundledWrapper;
      serverArgs = [];
    }
    return { mode: "bundled", serverBin, serverArgs, env: { HANA_ROOT: bundledServerDir } };
  }

  // 开发模式：用 Electron 自带的 Node（ELECTRON_RUN_AS_NODE=1）跑源码。
  // native addon（better-sqlite3 等）按 Electron ABI 编译，必须用 Electron 的 Node。
  return {
    mode: "dev",
    serverBin: execPath,
    serverArgs: [path.join(dirname, "..", "server", "index.js")],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
}

module.exports = {
  isPidAlive,
  pollServerInfo,
  isReusableServerHealth,
  resolveAecNativeDir,
  injectWindowsGitPath,
  resolveBundledServerLaunch,
};
