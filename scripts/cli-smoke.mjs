#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const nodeBin = process.execPath;
const cliBin = path.join(root, "cli", "bin", "lynn.mjs");
const missingDataDir = path.join(os.tmpdir(), "lynn-cli-smoke-missing");
const briefPath = path.join(root, "cli", "fixtures", "worker-brief.md");

function run(name, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(nodeBin, [cliBin, ...args], {
      cwd: root,
      env: { ...process.env, ...(options.env || {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => {
      const result = { name, code, stdout, stderr };
      if (options.expectFailure ? code !== 0 : code === 0) {
        resolve(result);
      } else {
        reject(new Error(`${name} failed with exit ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      }
    });
  });
}

function assertIncludes(name, text, needle) {
  if (!text.includes(needle)) {
    throw new Error(`${name} output did not include ${JSON.stringify(needle)}\n${text}`);
  }
}

function assertNotIncludes(name, text, needle) {
  if (text.includes(needle)) {
    throw new Error(`${name} output unexpectedly included ${JSON.stringify(needle)}\n${text}`);
  }
}

if (!fs.existsSync(cliBin)) {
  throw new Error(`CLI bundle missing: ${cliBin}. Run npm run build:cli first.`);
}

await fs.promises.rm(missingDataDir, { recursive: true, force: true });
await fs.promises.mkdir(missingDataDir, { recursive: true });

const checks = [];

checks.push(run("version", ["version"]).then((r) => {
  assertIncludes(r.name, r.stdout, "@lynn/cli");
}));

checks.push(run("startup banner", []).then((r) => {
  assertIncludes(r.name, r.stdout, ">_ Lynn CLI");
  assertIncludes(r.name, r.stdout, "MiMo via");
  assertIncludes(r.name, r.stdout, "Lynn providers");
}));

checks.push(run("providers", ["providers", "--data-dir", missingDataDir]).then((r) => {
  assertIncludes(r.name, r.stdout, "Lynn Providers / BYOK");
  assertIncludes(r.name, r.stdout, "Provider keys stay");
  assertNotIncludes(r.name, r.stdout, "sk-");
  assertNotIncludes(r.name, r.stdout.toLowerCase(), "api_key");
}));

checks.push(run("mock prompt", ["-p", "你好", "--mock-brain"]).then((r) => {
  assertIncludes(r.name, r.stdout, "Mock Lynn response: 你好");
}));

checks.push(run("mock worker", ["worker", "run", "--brief", briefPath, "--worktree", root, "--mock", "--jsonl"]).then((r) => {
  assertIncludes(r.name, r.stdout, '"type":"worker.started"');
  assertIncludes(r.name, r.stdout, '"type":"worker.finished"');
}));

checks.push(run("brain unreachable recovery", ["-p", "你好", "--brain-url", "http://127.0.0.1:1"], { expectFailure: true }).then((r) => {
  assertIncludes(r.name, r.stderr, "Could not reach Lynn Brain");
  assertIncludes(r.name, r.stderr, "Start the Lynn GUI");
  assertIncludes(r.name, r.stderr, "--mock-brain");
}));

for (const check of checks) {
  await check;
}

console.log("[cli-smoke] all checks passed");
