#!/usr/bin/env node
/**
 * postinstall.mjs — make sure a lowercase `lynn` does not rot.
 *
 * The package deliberately installs `Lynn` (macOS filesystems are usually
 * case-insensitive, so npm cannot ship both names in one prefix). Users still
 * type `lynn`, and older previews left lowercase symlinks pointing at deleted
 * temp builds. This script repairs only Lynn-owned lowercase links;
 * it never overwrites a real file or a link owned by another tool.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

if (process.platform === "win32") process.exit(0);
if (!["true", "1"].includes(process.env.npm_config_global)) process.exit(0);

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installedBin = path.join(packageRoot, "bin", "lynn.mjs");
if (!fs.existsSync(installedBin)) process.exit(0);

const candidates = new Set();
if (process.env.npm_config_prefix) candidates.add(path.join(process.env.npm_config_prefix, "bin", "lynn"));
if (process.env.LYNN_REPAIR_USER_SHIM === "1") candidates.add(path.join(os.homedir(), ".local", "bin", "lynn"));

function isLynnOwned(linkTarget) {
  const normalized = String(linkTarget || "").split(path.sep).join("/");
  if (normalized.includes("@lynn/cli")) return true;
  if (normalized.includes("/lynn.mjs")) return true;
  if (/\/lynn-v\d+/.test(normalized)) return true;
  return false;
}

for (const target of candidates) {
  const dir = path.dirname(target);
  if (!fs.existsSync(dir)) continue;
  // On case-insensitive volumes lstat("lynn") also finds npm's "Lynn".
  // Only repair an actual lowercase directory entry, never rename the official bin.
  if (!fs.readdirSync(dir).includes("lynn")) continue;
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if (error?.code !== "ENOENT") continue;
    continue;
  }
  if (!stat.isSymbolicLink()) continue;
  let linkTarget = "";
  try {
    linkTarget = fs.readlinkSync(target);
  } catch {
    continue;
  }
  const resolved = path.resolve(dir, linkTarget);
  if (!isLynnOwned(linkTarget)) continue;
  if (fs.existsSync(resolved) && fs.realpathSync(resolved) === fs.realpathSync(installedBin)) continue;
  try {
    fs.unlinkSync(target);
    fs.symlinkSync(installedBin, target);
    process.stderr.write(`[lynn-cli] repaired lowercase shim ${target}\n`);
  } catch (error) {
    process.stderr.write(`[lynn-cli] could not repair ${target}: ${error?.message || error}\n`);
  }
}
