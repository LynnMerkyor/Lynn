#!/usr/bin/env node

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const electronApp = resolve(ROOT, "node_modules/electron/dist/Electron.app");
const electronBin = resolve(electronApp, "Contents/MacOS/Electron");
const betterSqliteAddon = resolve(ROOT, "node_modules/better-sqlite3/build/Release/better_sqlite3.node");

if (process.platform !== "darwin") {
  console.log("[electron-signature] skipped outside macOS");
  process.exit(0);
}

if (!existsSync(electronApp)) throw new Error(`[electron-signature] Electron runtime not found: ${electronApp}`);
if (!existsSync(betterSqliteAddon)) throw new Error(`[electron-signature] better-sqlite3 native addon not found: ${betterSqliteAddon}`);

function runCodesign(args) {
  return spawnSync("codesign", args, { cwd: ROOT, encoding: "utf8" });
}

function isValid() {
  const result = runCodesign(["--verify", "--deep", "--strict", electronApp]);
  return result.status === 0;
}

if (!isValid()) {
  console.warn("[electron-signature] Electron cache signature is invalid; applying local ad-hoc repair");
  const repair = runCodesign(["--force", "--deep", "--sign", "-", electronApp]);
  if (repair.status !== 0) {
    throw new Error(`[electron-signature] ad-hoc repair failed: ${repair.stderr || repair.stdout}`);
  }
}

if (!isValid()) {
  throw new Error("[electron-signature] Electron cache signature remains invalid after repair");
}

// macOS can retain an invalid-page verdict for a native addon even after a
// bundle-level verification succeeds. Refresh the addon signature and verify
// the exact Electron Node ABI that the GUI gate and packaged app will load.
const nativeRepair = runCodesign(["--force", "--sign", "-", betterSqliteAddon]);
if (nativeRepair.status !== 0) {
  throw new Error(`[electron-signature] better-sqlite3 signature refresh failed: ${nativeRepair.stderr || nativeRepair.stdout}`);
}
const nativeVerify = runCodesign(["--verify", "--strict", betterSqliteAddon]);
if (nativeVerify.status !== 0) {
  throw new Error("[electron-signature] better-sqlite3 signature remains invalid after refresh");
}

const nativeProbe = spawnSync(electronBin, ["-e", "const D=require('better-sqlite3'); const db=new D(':memory:'); db.close();"], {
  cwd: ROOT,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  encoding: "utf8",
  timeout: 15_000,
});
if (nativeProbe.status !== 0) {
  throw new Error(`[electron-signature] Electron cannot load better-sqlite3: ${nativeProbe.stderr || nativeProbe.error?.message || "probe failed"}`);
}

console.log("[electron-signature] refreshed local ad-hoc signature for better-sqlite3 (electron-builder applies the release signature later)");
console.log("[electron-signature] Electron runtime and better-sqlite3 load probe verified");
