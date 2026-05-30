#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const isGlobalInstall = process.env.npm_config_global === "true" || process.env.npm_config_global === "1";
const prefix = process.env.npm_config_prefix;

if (isGlobalInstall && prefix && process.platform !== "win32") {
  const legacyLowercaseShim = path.join(prefix, "bin", "lynn");
  try {
    const stat = fs.lstatSync(legacyLowercaseShim);
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(legacyLowercaseShim);
      const normalized = target.split(path.sep).join("/");
      if (normalized.includes("@lynn/cli") || normalized.endsWith("/lynn.mjs") || normalized.includes("/lynn.mjs")) {
        fs.unlinkSync(legacyLowercaseShim);
        process.stderr.write("[lynn-cli] removed legacy lowercase lynn shim before installing Lynn\n");
      }
    }
  } catch (error) {
    if (error && error.code !== "ENOENT") {
      process.stderr.write(`[lynn-cli] skipped legacy lynn shim cleanup: ${error.message || String(error)}\n`);
    }
  }
}
