#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const startedAt = new Date();
const report = {
  version: "v0.80.6-cli-nightly",
  startedAt: startedAt.toISOString(),
  cwd: root,
  checks: [],
};

const quick = process.argv.includes("--quick");
const real = process.argv.includes("--real") || process.env.LYNN_CLI_NIGHTLY_REAL === "1";

const checks = [
  ["cli build", "npm", ["run", "build:cli"]],
  ["cli typecheck", "npm", ["--prefix", "cli", "run", "typecheck"]],
  ["approval/tool UI tests", "npm", ["--prefix", "cli", "exec", "--", "vitest", "run", "tests/code-tool-render.test.ts", "tests/boxed-input.test.ts", "tests/terminal-spinner.test.ts"]],
  ["headless/agent contract tests", "npm", ["--prefix", "cli", "exec", "--", "vitest", "run", "tests/agents.test.ts", "tests/help.test.ts", "tests/local-command.test.ts"]],
  ["long task loop tests", "npm", ["--prefix", "cli", "exec", "--", "vitest", "run", "tests/code-agent-loop.test.ts", "tests/code-agent-loop-tools.test.ts", "tests/code-agent-loop-resume.test.ts", "tests/code-plan-contract.test.ts", "tests/code-tool-verify.test.ts"]],
  ["cli smoke", "node", ["scripts/cli-smoke.mjs"]],
  ["pty boxed-input smoke", "npm", ["run", "test:cli-pty"]],
  ["longrun checkpoint/cache smoke", "node", ["scripts/cli-longrun-smoke.mjs"]],
];

if (!quick) {
  checks.push(["fleet/headless gate", "npm", ["run", "test:cli-fleet"]]);
}

if (real) {
  checks.push(["real model soak", "node", ["scripts/cli-real-model-soak.mjs"]]);
}

for (const [name, command, args] of checks) {
  await runCheck(name, command, args);
}

report.finishedAt = new Date().toISOString();
report.ok = report.checks.every((check) => check.ok);
await writeReport();
console.log(`[v0806-cli-nightly] ${report.ok ? "passed" : "failed"} ${report.checks.length} checks`);
if (!report.ok) process.exit(1);

async function runCheck(name, command, args) {
  const started = Date.now();
  console.log(`[v0806-cli-nightly] start ${name}`);
  const result = await run(command, args);
  const check = {
    name,
    command: [command, ...args].join(" "),
    ok: result.code === 0,
    code: result.code,
    ms: Date.now() - started,
    stdoutTail: tail(result.stdout),
    stderrTail: tail(result.stderr),
  };
  report.checks.push(check);
  if (!check.ok) {
    await writeReport();
    throw new Error(`[v0806-cli-nightly] ${name} failed with ${result.code}\n${check.stderrTail || check.stdoutTail}`);
  }
  console.log(`[v0806-cli-nightly] ok ${name} ${check.ms}ms`);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: {
        ...process.env,
        LYNN_CLI_UPDATE_CHECK: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function writeReport() {
  const outDir = path.join(root, "output");
  await fs.mkdir(outDir, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  const file = path.join(outDir, `v0806-cli-nightly-${stamp}.json`);
  await fs.writeFile(file, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  report.reportPath = file;
}

function tail(value, max = 4000) {
  const text = String(value || "");
  return text.length > max ? text.slice(-max) : text;
}
