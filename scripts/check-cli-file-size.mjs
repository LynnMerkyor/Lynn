#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const limit = Number.parseInt(process.env.LYNN_CLI_MAX_FILE_LINES || "900", 10);
const roots = ["cli/src", "cli/tests"];
const offenders = [];

for (const relRoot of roots) {
  walk(path.join(root, relRoot));
}

if (offenders.length) {
  offenders.sort((a, b) => b.lines - a.lines);
  console.error(`[check-cli-file-size] CLI TS files must stay under ${limit} lines.`);
  for (const item of offenders) {
    console.error(`  ${item.lines.toString().padStart(4, " ")}  ${path.relative(root, item.file)}`);
  }
  process.exit(1);
}

console.log(`[check-cli-file-size] ok: cli/src and cli/tests stay under ${limit} lines`);

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
    } else if (entry.isFile() && full.endsWith(".ts")) {
      const lines = fs.readFileSync(full, "utf8").split(/\r?\n/).length;
      if (lines >= limit) offenders.push({ file: full, lines });
    }
  }
}
