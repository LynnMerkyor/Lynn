#!/usr/bin/env node

import { spawn } from "node:child_process";
import process from "node:process";

const args = new Set(process.argv.slice(2));

function has(flag) {
  return args.has(flag);
}

if (has("--help") || has("-h")) {
  console.log(`Usage:
  npm run release:gate
  npm run release:gate -- --quick
  npm run release:gate -- --no-ui

Runs the release verification chain without packaging, notarizing, pushing, or
uploading binaries.

Options:
  --quick       Skip full vitest and Electron UI smoke; keep type/build/static gates.
  --no-ui      Skip Electron UI smoke.
  --no-build   Skip build:server/build:main/build:renderer.
`);
  process.exit(0);
}

const steps = [
  ["Typecheck renderer/main", "npm", ["run", "typecheck"]],
  ["Typecheck runtime", "npm", ["run", "typecheck:runtime"]],
  ...(!has("--quick") ? [["Vitest full suite", "npm", ["test", "--", "--reporter=dot"]]] : []),
  ...(!has("--no-build") ? [
    ["Build server bundle", "npm", ["run", "build:server"]],
    ["Build Electron main", "npm", ["run", "build:main"]],
    ["Build renderer", "npm", ["run", "build:renderer"]],
  ] : []),
  ["Static release regression", "npm", ["run", "test:release:smoke", "--", "--mode", "static"]],
  ...(!has("--quick") && !has("--no-ui") ? [["Electron UI smoke", "npm", ["run", "test:release:ui"]]] : []),
];

function formatDuration(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m${String(rest).padStart(2, "0")}s`;
}

function runStep([name, command, stepArgs], index) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    console.log(`\n[release-gate] ${index + 1}/${steps.length} ${name}`);
    console.log(`[release-gate] $ ${[command, ...stepArgs].join(" ")}`);
    const child = spawn(command, stepArgs, {
      cwd: process.cwd(),
      env: process.env,
      shell: process.platform === "win32",
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const duration = formatDuration(Date.now() - startedAt);
      if (code === 0) {
        console.log(`[release-gate] ✓ ${name} (${duration})`);
        resolve();
        return;
      }
      const suffix = signal ? `signal ${signal}` : `exit ${code}`;
      reject(new Error(`${name} failed (${suffix}, ${duration})`));
    });
  });
}

const startedAt = Date.now();
console.log(`[release-gate] starting ${steps.length} steps`);

for (let i = 0; i < steps.length; i += 1) {
  try {
    await runStep(steps[i], i);
  } catch (error) {
    console.error(`\n[release-gate] ✗ ${error?.message || error}`);
    process.exit(1);
  }
}

console.log(`\n[release-gate] all checks passed (${formatDuration(Date.now() - startedAt)})`);
