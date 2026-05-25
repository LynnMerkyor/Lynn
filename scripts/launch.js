/**
 * Cross-platform dev launcher
 * 解决 POSIX `VAR=val cmd` 语法和 `~` 在 Windows 上不工作的问题
 *
 * server 模式会自动选择能加载 native addon 的运行时：
 * - 当前 Node 能加载 `better-sqlite3`：直接用当前 Node
 * - ABI 不兼容：自动回退到 Electron 的 Node（ELECTRON_RUN_AS_NODE=1）
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const defaultLynnHome = join(homedir(), ".lynn-dev");
const serverJsEntry = "server/index.js";
const serverTsEntry = "server/index.ts";
const tsxSpecifier = "tsx";
const runtimeTsSentinelFiles = [
  serverTsEntry,
  "server/chat/content-utils.ts",
  "core/provider-registry.ts",
];

export function canLoadBetterSqlite3(requireFn = require) {
  try {
    const Database = requireFn("better-sqlite3");
    const db = new Database(":memory:");
    db.close();
    return true;
  } catch {
    return false;
  }
}

function hasRuntimeTsSources(fileExists) {
  return runtimeTsSentinelFiles.some((file) => fileExists(file));
}

function resolveServerEntry({ env, fileExists }) {
  const entryHint = String(env.LYNN_SERVER_ENTRY || "auto").toLowerCase();
  const needsTsLoader = hasRuntimeTsSources(fileExists);

  if (["ts", "typescript", "source"].includes(entryHint)) {
    return { path: serverTsEntry, usesTsLoader: true };
  }
  if (["js", "javascript", "bundle"].includes(entryHint)) {
    return { path: serverJsEntry, usesTsLoader: needsTsLoader };
  }
  if (entryHint !== "auto") {
    throw new Error("[launch] LYNN_SERVER_ENTRY must be auto, js, or ts");
  }

  if (fileExists(serverJsEntry)) {
    return { path: serverJsEntry, usesTsLoader: needsTsLoader };
  }
  if (fileExists(serverTsEntry)) {
    return { path: serverTsEntry, usesTsLoader: true };
  }
  return { path: serverJsEntry, usesTsLoader: needsTsLoader };
}

function assertTsxAvailable(resolveFn) {
  try {
    resolveFn(tsxSpecifier);
  } catch {
    throw new Error(
      "[launch] TypeScript server sources require dev dependency `tsx`. Run `npm install` and retry."
    );
  }
}

function serverArgsFor(entry, extra) {
  if (!entry.usesTsLoader) return [entry.path, ...extra];
  return ["--import", tsxSpecifier, entry.path, ...extra];
}

export function resolveLaunchPlan(options = {}) {
  const {
    mode,
    extra = [],
    env = process.env,
    execPath = process.execPath,
    requireFn = require,
    resolveFn = requireFn.resolve?.bind(requireFn) ?? require.resolve.bind(require),
    fileExists = existsSync,
    nodeVersion = process.version,
  } = options;
  const childEnv = {
    ...env,
    LYNN_HOME: env.LYNN_HOME || defaultLynnHome,
  };
  delete childEnv.ELECTRON_RUN_AS_NODE;

  let bin;
  let args;
  let warning = null;

  switch (mode) {
    case "electron":
      bin = requireFn("electron");
      args = [".", ...extra];
      break;
    case "electron-dev":
      bin = requireFn("electron");
      args = [".", "--dev", ...extra];
      break;
    case "electron-vite":
      childEnv.VITE_DEV_URL = "http://localhost:5173";
      bin = requireFn("electron");
      args = [".", "--dev", ...extra];
      break;
    case "cli":
      bin = execPath;
      args = ["index.js", ...extra];
      break;
    case "server": {
      const entry = resolveServerEntry({ env: childEnv, fileExists });
      if (entry.usesTsLoader) assertTsxAvailable(resolveFn);

      const runtimeHint = String(childEnv.LYNN_SERVER_RUNTIME || "auto").toLowerCase();
      const shouldUseNode = runtimeHint === "node"
        || (runtimeHint !== "electron" && canLoadBetterSqlite3(requireFn));
      const serverArgs = serverArgsFor(entry, extra);

      if (shouldUseNode) {
        bin = execPath;
        args = serverArgs;
      } else {
        try {
          bin = requireFn("electron");
        } catch (err) {
          throw new Error(
            `[launch] 当前 Node ${nodeVersion} 无法加载 better-sqlite3，且 Electron 运行时不可用：${err.message}`
          );
        }
        args = serverArgs;
        childEnv.ELECTRON_RUN_AS_NODE = "1";
        warning = runtimeHint === "electron"
          ? "[launch] LYNN_SERVER_RUNTIME=electron，使用 Electron 的 Node 运行 server"
          : `[launch] 当前 Node ${nodeVersion} 无法加载 better-sqlite3，已自动切换到 Electron 运行时`;
      }
      break;
    }
    default:
      throw new Error("Usage: node scripts/launch.js <electron|electron-dev|electron-vite|cli|server>");
  }

  return { bin, args, env: childEnv, warning };
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const [mode, ...extra] = argv;

  let plan;
  try {
    plan = resolveLaunchPlan({ mode, extra, env });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  if (plan.warning) console.warn(plan.warning);

  const child = spawn(plan.bin, plan.args, { stdio: "inherit", env: plan.env });
  child.on("exit", (code) => process.exit(code ?? 1));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
