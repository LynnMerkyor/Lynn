#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const args = {
    mode: "quick",
    output: "",
    withTerminal: false,
    realModel: false,
    list: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--mode") args.mode = next();
    else if (arg.startsWith("--mode=")) args.mode = arg.slice("--mode=".length);
    else if (arg === "--output") args.output = next();
    else if (arg.startsWith("--output=")) args.output = arg.slice("--output=".length);
    else if (arg === "--with-terminal") args.withTerminal = true;
    else if (arg === "--real-model") args.realModel = true;
    else if (arg === "--list") args.list = true;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  if (!["quick", "full"].includes(args.mode)) throw new Error(`Unknown mode: ${args.mode}`);
  return args;
}

function printHelp() {
  console.log(`Usage:
  npm run test:cli-nightly
  node scripts/v0804-cli-nightly.mjs --mode full --with-terminal --real-model

Options:
  --mode quick|full     quick is the default; full adds pack/install, pressure, and Fleet gates.
  --with-terminal       include Terminal.app + IME smoke gates.
  --real-model          include the remote real-model soak.
  --output DIR          write report under a custom directory.
  --list                print selected steps without running them.`);
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function formatDuration(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "step";
}

function commandLine(command, args) {
  return [command, ...args].join(" ");
}

function selectedSteps(options) {
  const steps = [
    ["CLI typecheck", "npm", ["--prefix", "cli", "run", "typecheck"], "long-task/cache/headless source remains TS-clean"],
    ["CLI focused tests", "npm", ["--prefix", "cli", "test", "--", "brain-client", "agents", "cache-command", "code-agent-loop-tools", "terminal-spinner", "boxed-input"], "retry, headless contract, cache doctor, resume tool-storm, renderer"],
    ["Build CLI bundle", "npm", ["run", "build:cli"], "bin/lynn.mjs is current"],
    ["CLI smoke", "node", ["scripts/cli-smoke.mjs"], "install guidance, headless contract, cache doctor, sessions, worker bridge"],
    ["Static release regression", "npm", ["run", "test:release:static"], "release metadata, README/download snippets, preflight coverage"],
  ];
  if (options.mode === "full") {
    steps.splice(1, 1, ["CLI full tests", "npm", ["--prefix", "cli", "test"], "full CLI unit/regression suite"]);
    steps.splice(
      4,
      0,
      ["CLI pack smoke", "npm", ["run", "test:cli-pack"], "npm pack guard: correct package, name, size, and manifest"],
      ["CLI install smoke", "npm", ["run", "test:cli-install"], "fresh local install, global install, headless code, and runtime answer"],
    );
    steps.push(
      ["CLI pressure", "npm", ["run", "test:cli-pressure"], "headless -p pressure and empty-answer handling"],
      ["CLI PTY smoke", "npm", ["run", "test:cli-pty"], "TTY prompt/input safety"],
      ["CLI/Fleet focused gates", "npm", ["run", "test:cli-fleet"], "Fleet worker, long-run cache/checkpoint smoke"],
    );
  }
  if (options.withTerminal) {
    steps.push(["Terminal soak", "npm", ["run", "test:cli-terminal-soak"], "Terminal.app + IME smoke"]);
  }
  if (options.realModel) {
    steps.push(["Real model soak", "npm", ["run", "test:cli-real"], "remote Brain path"]);
  }
  return steps.map(([name, command, args, coverage]) => ({ name, command, args, coverage }));
}

async function runStep(step, index, outputDir) {
  const startedAt = Date.now();
  const logPath = path.join(outputDir, `${String(index + 1).padStart(2, "0")}-${slug(step.name)}.log`);
  const chunks = [];
  const child = spawn(step.command, step.args, {
    cwd: ROOT,
    env: { ...process.env, LYNN_CLI_UPDATE_CHECK: "0" },
    shell: process.platform === "win32",
  });
  child.stdout.on("data", (chunk) => chunks.push(chunk));
  child.stderr.on("data", (chunk) => chunks.push(chunk));
  const result = await new Promise((resolve) => {
    child.on("error", (error) => resolve({ code: 1, signal: null, error }));
    child.on("close", (code, signal) => resolve({ code: code ?? 1, signal, error: null }));
  });
  const output = Buffer.concat(chunks.map((chunk) => Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))).toString("utf8");
  await fs.writeFile(logPath, output, "utf8");
  return {
    ...step,
    ok: result.code === 0,
    code: result.code,
    signal: result.signal,
    error: result.error ? String(result.error.message || result.error) : "",
    durationMs: Date.now() - startedAt,
    logPath,
  };
}

function reportMarkdown({ mode, withTerminal, realModel, startedAt, finishedAt, results, outputDir }) {
  const ok = results.every((result) => result.ok);
  const lines = [
    "# Lynn CLI v0.80.4 Nightly Report",
    "",
    `- status: ${ok ? "PASS" : "FAIL"}`,
    `- mode: ${mode}`,
    `- terminal soak: ${withTerminal ? "included" : "not included"}`,
    `- real model soak: ${realModel ? "included" : "not included"}`,
    `- started: ${startedAt}`,
    `- finished: ${finishedAt}`,
    `- output: ${outputDir}`,
    "",
    "## Gates",
    "",
    "| Gate | Status | Duration | Coverage | Log |",
    "|---|---:|---:|---|---|",
    ...results.map((result) => `| ${result.name} | ${result.ok ? "PASS" : `FAIL (${result.code}${result.signal ? `/${result.signal}` : ""})`} | ${formatDuration(result.durationMs)} | ${result.coverage} | ${path.basename(result.logPath)} |`),
    "",
    "## Objective Coverage",
    "",
    "- Long task stability: Brain retry/backoff, runtime compaction, resume tool-storm, long-run smoke.",
    "- Headless/Fleet contract: `Lynn agents --json`, `Lynn code -p ... --json`, worker JSONL bridge.",
    "- Prefix cache productization: `Lynn cache doctor --json` and cache/stable-prefix diagnostics.",
    "- Line TUI quality: boxed input, spinner/card renderer, PTY/Terminal gates when selected.",
    "- Release checks: guarded pack/install/static release regression.",
    "",
  ];
  if (!ok) {
    lines.push("## Failures", "");
    for (const result of results.filter((entry) => !entry.ok)) {
      lines.push(`- ${result.name}: see ${path.basename(result.logPath)}`);
      if (result.error) lines.push(`  - ${result.error}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const steps = selectedSteps(options);
  if (options.list) {
    for (const step of steps) console.log(`${step.name}: ${commandLine(step.command, step.args)} # ${step.coverage}`);
    return;
  }
  const startedAt = new Date().toISOString();
  const outputDir = path.resolve(options.output || path.join(ROOT, "output", `v0804-cli-nightly-${nowStamp()}`));
  await fs.mkdir(outputDir, { recursive: true });
  const results = [];
  console.log(`[v0804-cli-nightly] ${steps.length} gate(s), mode=${options.mode}`);
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    process.stdout.write(`[v0804-cli-nightly] ${i + 1}/${steps.length} ${step.name} ... `);
    const result = await runStep(step, i, outputDir);
    results.push(result);
    console.log(`${result.ok ? "PASS" : "FAIL"} (${formatDuration(result.durationMs)})`);
    if (!result.ok) break;
  }
  const finishedAt = new Date().toISOString();
  const summary = {
    type: "v0804.cli.nightly",
    ok: results.every((result) => result.ok),
    mode: options.mode,
    withTerminal: options.withTerminal,
    realModel: options.realModel,
    startedAt,
    finishedAt,
    outputDir,
    results: results.map((result) => ({
      name: result.name,
      ok: result.ok,
      code: result.code,
      signal: result.signal,
      durationMs: result.durationMs,
      coverage: result.coverage,
      log: result.logPath,
    })),
  };
  await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(outputDir, "report.md"), reportMarkdown({
    ...options,
    startedAt,
    finishedAt,
    results,
    outputDir,
  }), "utf8");
  console.log(`[v0804-cli-nightly] report: ${path.join(outputDir, "report.md")}`);
  if (!summary.ok) process.exit(1);
}

await main();
