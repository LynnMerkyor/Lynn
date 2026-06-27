#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const targets = [
  {
    label: "macOS GUI gate Electron userData",
    root: path.join(os.homedir(), "Library", "Application Support"),
    match: (name) => /^Lynn-(?:gui-live|ui-smoke)-\d+-\d+$/.test(name),
  },
  {
    label: "temporary CLI/GUI gate homes",
    root: os.tmpdir(),
    match: (name) => /^lynn-(?:cli-50|gui-gate)-/.test(name),
  },
  {
    label: "CLI/GUI long-run reports",
    root: path.join(ROOT, "reports"),
    match: (name) => /^(?:cli-50-results-|gui-50-results-).+\.json$/.test(name) || /100.+\.json$/.test(name),
  },
];

async function listEntries(root) {
  try {
    return await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

let removed = 0;
for (const target of targets) {
  const entries = await listEntries(target.root);
  for (const entry of entries) {
    if (!target.match(entry.name)) continue;
    const fullPath = path.join(target.root, entry.name);
    await fs.rm(fullPath, { recursive: true, force: true });
    removed += 1;
    console.log(`[gate-clean-data] removed ${target.label}: ${fullPath}`);
  }
}

console.log(`[gate-clean-data] removed ${removed} item(s)`);
