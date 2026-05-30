#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const require = createRequire(import.meta.url);
const {
  getWorkerSpawnCommand,
  getWorkerSpawnServerEnv,
  resolveCliRuntime,
} = require("../desktop/cli-env-manager.cjs");

const root = process.cwd();

function stringArg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

function exists(p) {
  try {
    return !!p && fs.existsSync(p);
  } catch {
    return false;
  }
}

function findPackagedApp() {
  const explicit = stringArg("--app");
  if (explicit) return path.resolve(explicit);
  const candidates = [
    path.join(root, "dist", "mac-arm64", "Lynn.app"),
    path.join(root, "dist", "mac", "Lynn.app"),
  ];
  return candidates.find((candidate) => exists(candidate)) || null;
}

function resolvePackagedPaths(appPath) {
  if (!appPath) {
    throw new Error("[packaged-cli-smoke] missing packaged app. Run `npm run pack` first, or pass --app <Lynn.app>");
  }
  if (process.platform === "darwin" || appPath.endsWith(".app")) {
    return {
      execPath: path.join(appPath, "Contents", "MacOS", "Lynn"),
      resourcesPath: path.join(appPath, "Contents", "Resources"),
      platform: "darwin",
    };
  }
  throw new Error(`[packaged-cli-smoke] unsupported packaged app path for this smoke: ${appPath}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(`[packaged-cli-smoke] ${message}`);
}

function run(name, command, args, env) {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 20_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `[packaged-cli-smoke] ${name} failed with exit ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return `${result.stdout || ""}${result.stderr || ""}`;
}

const appPath = findPackagedApp();
const runtime = resolvePackagedPaths(appPath);

const rt = resolveCliRuntime({
  platform: runtime.platform,
  execPath: runtime.execPath,
  resourcesPath: runtime.resourcesPath,
  appRoot: root,
});

assert(rt.cliPresent, `CLI bundle is missing under ${runtime.resourcesPath}/cli/lynn.mjs`);
assert(rt.cliEntry === path.join(runtime.resourcesPath, "cli", "lynn.mjs"), `unexpected CLI entry: ${rt.cliEntry}`);
assert(rt.canRunInApp, "CLI runtime is not runnable in app");

const serverEnv = getWorkerSpawnServerEnv({
  platform: runtime.platform,
  execPath: runtime.execPath,
  resourcesPath: runtime.resourcesPath,
  appRoot: root,
});
assert(serverEnv.LYNN_CLI_ENTRY === rt.cliEntry, "server env does not expose LYNN_CLI_ENTRY");
assert(serverEnv.LYNN_CLI_NODE, "server env does not expose LYNN_CLI_NODE");

const versionCmd = getWorkerSpawnCommand(["version"], {
  platform: runtime.platform,
  execPath: runtime.execPath,
  resourcesPath: runtime.resourcesPath,
  appRoot: root,
});
assert(versionCmd, "could not materialize packaged CLI spawn command");
const versionOutput = run("packaged Lynn version", versionCmd.command, versionCmd.args, versionCmd.env);
assert(versionOutput.includes("@lynn/cli"), `version output did not prove Lynn CLI ran:\n${versionOutput}`);

const briefPath = path.join(root, "cli", "fixtures", "worker-brief.md");
const workerCmd = getWorkerSpawnCommand([
  "worker",
  "run",
  "--brief",
  briefPath,
  "--worktree",
  root,
  "--mock",
  "--jsonl",
], {
  platform: runtime.platform,
  execPath: runtime.execPath,
  resourcesPath: runtime.resourcesPath,
  appRoot: root,
});
assert(workerCmd, "could not materialize packaged worker spawn command");
const workerOutput = run("packaged worker mock", workerCmd.command, workerCmd.args, workerCmd.env);
assert(workerOutput.includes('"type":"worker.started"'), `worker JSONL did not include worker.started:\n${workerOutput}`);
assert(workerOutput.includes('"type":"worker.finished"'), `worker JSONL did not include worker.finished:\n${workerOutput}`);

console.log(
  `[packaged-cli-smoke] packaged CLI runtime ok: ${path.relative(root, appPath)} (${rt.nodeSource}, ${path.relative(root, rt.cliEntry)})`,
);
