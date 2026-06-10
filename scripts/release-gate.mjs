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
  --no-ui      Skip Electron UI smoke (also skips the GUI startup-recovery matrix).
  --no-build   Skip build:server/build:main/build:renderer.
  --no-cli-fleet
                Skip focused CLI/Fleet regression tests.
  --no-cli-efficiency
                Skip live StepFun route/efficiency gates.
  --no-cli-task
                Skip the live CLI task-execution gate (issue #72 class-3 net).
`);
  process.exit(0);
}

const steps = [
  ["Typecheck renderer/main", "npm", ["run", "typecheck"]],
  ["Typecheck runtime", "npm", ["run", "typecheck:runtime"]],
  ["Build CLI", "npm", ["run", "build:cli"]],
  ["CLI smoke", "node", ["scripts/cli-smoke.mjs"]],
  ["CLI packed install smoke", "node", ["scripts/cli-install-smoke.mjs"]],
  ...(!has("--no-cli-fleet") ? [["CLI/Fleet focused regressions", "npm", ["run", "test:cli-fleet"]]] : []),
  ...(!has("--no-cli-efficiency") ? [["CLI StepFun efficiency gates", "npm", ["run", "release:cli-efficiency"]]] : []),
  ...(!has("--quick") ? [["Vitest full suite", "npm", ["test", "--", "--reporter=dot"]]] : []),
  ...(!has("--no-build") ? [
    ["Build server bundle", "npm", ["run", "build:server"]],
    ["Build Electron main", "npm", ["run", "build:main"]],
    ["Build renderer", "npm", ["run", "build:renderer"]],
  ] : []),
  ["Static release regression", "npm", ["run", "test:release:smoke", "--", "--mode", "static"]],
  ...(!has("--quick") && !has("--no-ui") ? [["Electron UI smoke", "npm", ["run", "test:release:ui"]]] : []),
  // issue #72 regression nets. Both are HEADLESS (no Electron window):
  //  - startup recovery: boots dist-server-bundle through fresh/corrupt-db/.hanako-sentinel
  //    profiles (needs build:server, so it rides with --no-build).
  //  - CLI task: real -p tasks must produce VISIBLE answers (reasoning-only = fail).
  ...(!has("--no-build") ? [["Startup recovery matrix (issue #72, headless)", "node", ["scripts/gate-startup-recovery.mjs"]]] : []),
  ...(!has("--no-cli-task") ? [["CLI live task gate (issue #72)", "node", ["scripts/gate-cli-task.mjs"]]] : []),
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
