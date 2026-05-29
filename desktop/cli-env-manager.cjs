/**
 * cli-env-manager.cjs — resolve the runtime the GUI uses to run the Lynn CLI
 * (and, later, to spawn `lynn worker run` for the fleet) WITHOUT making the user
 * configure anything in a terminal.
 *
 * Zero-download by design:
 *  - mac/linux: reuse the real Node binary already shipped for the server
 *    (resources/server/node) — 0 extra bytes.
 *  - any platform / dev / win (server ships a SEA, not a plain node): fall back to
 *    Electron-as-node (process.execPath + ELECTRON_RUN_AS_NODE=1) — always present.
 *  - the CLI itself runs from the bundled esbuild output (resources/cli/lynn.mjs),
 *    shipped via electron-builder extraResources (coordinated with the CLI lane).
 *
 * This module is the foundation for step 4 (GUI really spawns `lynn worker run
 * --jsonl`): getWorkerSpawnCommand() returns the exact { command, args, env }.
 * It does NOT download anything and does NOT touch the user's PATH.
 */
const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

const MIN_NODE_MAJOR = 20; // brain requires >=20; CLI prefers >=22

function defaultFileExists(p) {
  try {
    return !!p && fs.existsSync(p);
  } catch {
    return false;
  }
}

function parseNodeMajor(version) {
  const m = /^v?(\d+)\./.exec(String(version || "").trim());
  return m ? Number(m[1]) : null;
}

/**
 * Pure resolver: given environment facts, decide which Node runs the CLI and
 * whether the bundled CLI entry is present. Injectable for tests.
 */
function resolveCliRuntime(opts = {}) {
  const platform = opts.platform || process.platform;
  const execPath = opts.execPath || process.execPath;
  const resourcesPath = opts.resourcesPath != null ? opts.resourcesPath : process.resourcesPath || "";
  const appRoot = opts.appRoot || path.join(__dirname, "..");
  const fileExists = opts.fileExists || defaultFileExists;

  // Bundled CLI (extraResources: cli/bin/lynn.mjs -> resources/cli/lynn.mjs).
  const bundledCliEntry = resourcesPath ? path.join(resourcesPath, "cli", "lynn.mjs") : "";
  const devCliEntry = path.join(appRoot, "cli", "bin", "lynn.mjs");
  const cliEntry = fileExists(bundledCliEntry) ? bundledCliEntry : fileExists(devCliEntry) ? devCliEntry : "";
  const cliPresent = !!cliEntry;

  // Prefer a REAL bundled node (the mac/linux server bundle ships one).
  // Windows ships lynn-server.exe (a SEA, not a general node) -> not usable here.
  const bundledNode =
    resourcesPath && platform !== "win32" ? path.join(resourcesPath, "server", "node") : "";
  const hasBundledNode = fileExists(bundledNode);

  let node;
  let nodeSource;
  let electronAsNode = false;
  if (hasBundledNode) {
    node = bundledNode;
    nodeSource = "bundled";
  } else {
    // Electron binary can run as a plain Node via ELECTRON_RUN_AS_NODE=1.
    node = execPath;
    nodeSource = "electron";
    electronAsNode = true;
  }

  return {
    node,
    nodeSource, // 'bundled' | 'electron'
    electronAsNode,
    cliEntry: cliPresent ? cliEntry : null,
    cliPresent,
    // A runtime is always available (electron-as-node); the only gate for running
    // the CLI in-app is whether the CLI bundle has been shipped.
    canRunInApp: cliPresent,
  };
}

/** Detect a system `node` on PATH (for the optional terminal-shim path + info). Injectable. */
function detectSystemNode(opts = {}) {
  const platform = opts.platform || process.platform;
  const sp = opts.spawnSync || spawnSync;
  try {
    const whichCmd = platform === "win32" ? "where" : "which";
    const found = sp(whichCmd, ["node"], { encoding: "utf8", timeout: 1500 });
    const nodePath = String((found && found.stdout) || "")
      .trim()
      .split(/\r?\n/)[0]
      .trim();
    if (!nodePath) return null;
    const ver = sp(nodePath, ["--version"], { encoding: "utf8", timeout: 1500 });
    const version = String((ver && ver.stdout) || "").trim() || null;
    return { path: nodePath, version, major: parseNodeMajor(version) };
  } catch {
    return null;
  }
}

function probeNodeVersion(nodePath) {
  try {
    const r = spawnSync(nodePath, ["--version"], { encoding: "utf8", timeout: 1500 });
    return String((r && r.stdout) || "").trim() || null;
  } catch {
    return null;
  }
}

/** Status for the GUI (IPC `cli:status`). */
function getCliEnvStatus() {
  const rt = resolveCliRuntime();
  const nodeVersion =
    rt.nodeSource === "electron" ? `v${process.versions.node}` : probeNodeVersion(rt.node);
  return {
    ready: rt.canRunInApp,
    node: { path: rt.node, source: rt.nodeSource, version: nodeVersion },
    cli: { path: rt.cliEntry, present: rt.cliPresent },
    systemNode: detectSystemNode(),
    minNodeMajor: MIN_NODE_MAJOR,
  };
}

/**
 * The exact spawn descriptor for running the bundled CLI in-app (step 4 / fleet).
 * Returns null if the CLI bundle is not present yet.
 */
function getWorkerSpawnCommand(extraArgs = [], opts = {}) {
  const rt = resolveCliRuntime(opts);
  if (!rt.cliEntry) return null;
  const env = { ...process.env };
  if (rt.electronAsNode) env.ELECTRON_RUN_AS_NODE = "1";
  return { command: rt.node, args: [rt.cliEntry, ...extraArgs], env };
}

/**
 * Env block handed to the local Lynn server so server/fleet can spawn the same
 * bundled CLI runtime without depending on PATH. Kept separate from
 * getWorkerSpawnCommand() because the server needs a stable contract, not a
 * partially materialized command line.
 */
function getWorkerSpawnServerEnv(opts = {}) {
  const rt = resolveCliRuntime(opts);
  if (!rt.cliEntry) return {};
  const env = {
    LYNN_CLI_NODE: rt.node,
    LYNN_CLI_ENTRY: rt.cliEntry,
  };
  if (rt.electronAsNode) env.LYNN_CLI_ELECTRON_AS_NODE = "1";
  return env;
}

module.exports = {
  MIN_NODE_MAJOR,
  parseNodeMajor,
  resolveCliRuntime,
  detectSystemNode,
  getCliEnvStatus,
  getWorkerSpawnCommand,
  getWorkerSpawnServerEnv,
};
