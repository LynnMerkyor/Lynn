#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const version = pkg.version;
const dist = path.join(root, "dist");
const dmgs = [
  path.join(dist, `Lynn-${version}-macOS-arm64.dmg`),
  path.join(dist, `Lynn-${version}-macOS-x64.dmg`),
];
const latestMac = path.join(dist, "latest-mac.yml");

function run(label, command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${label} failed\n$ ${[command, ...args].join(" ")}\n${output}`);
  }
  return [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
}

function sha512Base64(file) {
  return crypto.createHash("sha512").update(fs.readFileSync(file)).digest("base64");
}

if (!fs.existsSync(latestMac)) {
  throw new Error(`missing updater manifest: ${path.relative(root, latestMac)}`);
}

const manifestText = fs.readFileSync(latestMac, "utf8");

for (const dmg of dmgs) {
  if (!fs.existsSync(dmg)) {
    throw new Error(`missing DMG: ${path.relative(root, dmg)}`);
  }

  const basename = path.basename(dmg);
  run(`codesign verify ${basename}`, "codesign", ["--verify", "--verbose", dmg]);
  run(`stapler validate ${basename}`, "xcrun", ["stapler", "validate", dmg]);
  run(`Gatekeeper validate ${basename}`, "spctl", [
    "-a",
    "-vv",
    "-t",
    "open",
    "--context",
    "context:primary-signature",
    dmg,
  ]);

  const sha512 = sha512Base64(dmg);
  if (!manifestText.includes(basename) || !manifestText.includes(sha512)) {
    throw new Error(`latest-mac.yml does not match final bytes for ${basename}`);
  }
}

console.log("[verify-macos-release-artifacts] macOS DMGs are notarized, stapled, Gatekeeper-validated, and present in latest-mac.yml");
