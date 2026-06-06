#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const repo = path.resolve(new URL("..", import.meta.url).pathname);
const cli = path.join(repo, "cli/bin/lynn.mjs");
const outDir = path.join(repo, "output");
const startedAt = new Date();

const args = parseArgs(process.argv.slice(2));
const live = args.live === true || process.env.LYNN_EFFICIENCY_LIVE === "1";
const suite = String(args.suite || process.env.LYNN_EFFICIENCY_SUITE || "smoke");
const label = String(args.label || process.env.LYNN_EFFICIENCY_LABEL || "baseline");
const timeoutMs = Number(args.timeoutMs || process.env.LYNN_EFFICIENCY_TIMEOUT_MS || 240000);
const reportPath = path.resolve(String(args.out || path.join(outDir, `cli-efficiency-gate-${startedAt.toISOString().replace(/[:.]/g, "-")}.json`)));

const allTasks = createTasks();
const tasks = selectTasks(allTasks, suite);

if (!tasks.length) {
  throw new Error(`No efficiency tasks selected for suite=${suite}`);
}

if (!live) {
  printDryRun(tasks);
  process.exit(0);
}

fs.mkdirSync(outDir, { recursive: true });

const results = [];
for (const task of tasks) {
  const working = fs.mkdtempSync(path.join(os.tmpdir(), `lynn-efficiency-${task.id}-`));
  try {
    task.setup?.(working);
    const run = await runTask(task, working);
    const verify = task.verify ? task.verify(working) : { ok: true, stdout: "", stderr: "" };
    const success = run.exitCode === 0 && run.hasVisibleAnswer && verify.ok;
    results.push({
      id: task.id,
      kind: task.kind,
      label,
      success,
      ...run,
      verifier: verify,
      prompt: task.prompt,
      notes: task.notes || "",
    });
    const status = success ? "PASS" : "FAIL";
    console.log(`${status} ${task.id} wall=${run.wallMs}ms ttft=${formatNullable(run.ttftMs)} tools=${run.toolSteps} validation=${run.validationSteps} waste=${run.wasteSteps}`);
  } finally {
    if (args.keep !== true) fs.rmSync(working, { recursive: true, force: true });
  }
}

const report = summarize({ label, suite, startedAt, finishedAt: new Date(), results });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`[cli-efficiency-gate] wrote ${reportPath}`);

if (report.summary.failed > 0) process.exit(1);

function createTasks() {
  return [
    {
      id: "fast-runtime-answer",
      kind: "prompt",
      suite: ["smoke", "full"],
      prompt: "用两句话说明 Lynn CLI 当前默认模型路由和运行时优化。必须回答可见文本,不要调用工具。",
      notes: "Fast interactive TTFT and visible answer.",
      command: () => ["-p", "用两句话说明 Lynn CLI 当前默认模型路由和运行时优化。必须回答可见文本,不要调用工具。", "--json", "--reasoning", "high"],
    },
    {
      id: "structured-short-answer",
      kind: "prompt",
      suite: ["smoke", "full"],
      prompt: "只输出 JSON:{\"route\":\"StepFun-first\",\"localModels\":\"opt-in\"}。不要解释。",
      notes: "Schema boundary task; early stop is allowed only after the required JSON is visible.",
      command: () => ["-p", "只输出 JSON:{\"route\":\"StepFun-first\",\"localModels\":\"opt-in\"}。不要解释。", "--json", "--reasoning", "high"],
      verifyOutput(text) {
        try {
          const first = text.match(/\{[\s\S]*\}/)?.[0] || "";
          const parsed = JSON.parse(first);
          return parsed.route === "StepFun-first" && parsed.localModels === "opt-in";
        } catch {
          return false;
        }
      },
    },
    {
      id: "code-small-fix",
      kind: "code",
      suite: ["coding", "full"],
      prompt: "Fix stats.py median for even-length lists. Read files first, make the smallest edit, then run python3 test_stats.py.",
      setup(dir) {
        write(path.join(dir, "stats.py"), "def median(xs):\n    xs = sorted(xs)\n    n = len(xs)\n    if n == 0:\n        raise ValueError('empty')\n    return xs[n // 2]\n");
        write(path.join(dir, "test_stats.py"), "from stats import median\nassert median([1]) == 1\nassert median([1, 3, 5]) == 3\nassert median([1, 2, 3, 4]) == 2.5\nassert median([4, 1, 2, 3]) == 2.5\nprint('ALL_PASS')\n");
      },
      command: (dir) => ["code", "-p", "Fix stats.py median for even-length lists. Read files first, make the smallest edit, then run python3 test_stats.py.", "--json", "--cwd", dir, "--approval", "yolo", "--sandbox", "danger-full-access", "--reasoning", "high", "--max-steps", "100"],
      verify: (dir) => runVerifier("python3", ["test_stats.py"], dir),
    },
    {
      id: "code-cross-file-refactor",
      kind: "code",
      suite: ["coding", "full"],
      prompt: "Refactor formatUser to formatUser({ user, uppercase }) and update all call sites, including users.map(formatUser). Run npm run typecheck.",
      setup(dir) {
        const tsc = path.join(repo, "node_modules/.bin/tsc");
        write(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, target: "ES2020", module: "CommonJS", outDir: "dist" }, include: ["src/**/*.ts"] }, null, 2));
        write(path.join(dir, "package.json"), JSON.stringify({ scripts: { typecheck: `${tsc} -p tsconfig.json` } }, null, 2));
        write(path.join(dir, "src/types.ts"), "export interface User { id: string; displayName: string; }\n");
        write(path.join(dir, "src/format.ts"), "import type { User } from './types';\nexport function formatUser(user: User, uppercase = false): string {\n  const text = user.id + ':' + user.displayName;\n  return uppercase ? text.toUpperCase() : text;\n}\n");
        write(path.join(dir, "src/report.ts"), "import { formatUser } from './format';\nimport type { User } from './types';\nexport function report(users: User[]): string[] {\n  return users.map(formatUser);\n}\n");
        write(path.join(dir, "src/index.ts"), "import { formatUser } from './format';\nconst u = { id: 'u1', displayName: 'Ada' };\nconsole.log(formatUser(u, true));\n");
      },
      command: (dir) => ["code", "-p", "Refactor formatUser to formatUser({ user, uppercase }) and update all call sites. Be careful with the point-free users.map(formatUser) callback in report.ts. Run npm run typecheck.", "--json", "--cwd", dir, "--approval", "yolo", "--sandbox", "danger-full-access", "--reasoning", "high", "--max-steps", "100"],
      verify: (dir) => runVerifier("npm", ["run", "typecheck"], dir, 60000),
    },
  ];
}

function selectTasks(tasks, requestedSuite) {
  if (requestedSuite === "all") return tasks;
  return tasks.filter((task) => task.suite.includes(requestedSuite));
}

async function runTask(task, cwd) {
  const commandArgs = task.command(cwd);
  const started = Date.now();
  const child = spawn(process.execPath, [cli, ...commandArgs], {
    cwd: repo,
    env: {
      ...process.env,
      LYNN_CLI_UPDATE_CHECK: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let lineBuffer = "";
  let ttftMs = null;
  let firstToolMs = null;
  let finalAnswerMs = null;
  let assistantText = "";
  let toolSteps = 0;
  let validationSteps = 0;
  let repairSteps = 0;
  let wasteSteps = 0;
  let maxStepsReached = false;
  const events = [];

  child.stdout.on("data", (chunk) => {
    const text = String(chunk);
    stdout += text;
    lineBuffer += text;
    let index;
    while ((index = lineBuffer.indexOf("\n")) >= 0) {
      const line = lineBuffer.slice(0, index);
      lineBuffer = lineBuffer.slice(index + 1);
      const event = parseJsonLine(line);
      if (!event) continue;
      const atMs = Date.now() - started;
      events.push({ atMs, event });
      const visible = visibleDelta(event);
      if (visible) {
        assistantText += visible;
        ttftMs ??= atMs;
        finalAnswerMs = atMs;
      }
      if (isToolStart(event)) {
        toolSteps += 1;
        firstToolMs ??= atMs;
        if (isValidationTool(event)) validationSteps += 1;
      }
      if (isRepairEvent(event)) repairSteps += 1;
      if (isWasteEvent(event)) wasteSteps += 1;
      if (event.maxStepsReached === true || event.code === "max_steps_reached") maxStepsReached = true;
    }
  });

  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const exitCode = await waitForExit(child, timeoutMs);
  const wallMs = Date.now() - started;
  if (exitCode === null) {
    try { child.kill("SIGKILL"); } catch {}
  }

  const outputOk = task.verifyOutput ? task.verifyOutput(assistantText) : true;
  if (!outputOk) wasteSteps += 1;

  return {
    exitCode: exitCode ?? 124,
    wallMs,
    ttftMs,
    firstToolMs,
    finalAnswerMs,
    toolSteps,
    validationSteps,
    repairSteps,
    wasteSteps,
    maxStepsReached,
    hasVisibleAnswer: assistantText.trim().length > 0,
    outputOk,
    assistantText: assistantText.slice(0, 4000),
    stdoutTail: stdout.split(/\r?\n/).slice(-20).join("\n"),
    stderrTail: stderr.split(/\r?\n/).slice(-20).join("\n"),
    eventCount: events.length,
  };
}

function parseJsonLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function visibleDelta(event) {
  if (event.type === "assistant.delta" && typeof event.text === "string") return event.text;
  if (event.type === "assistant.final" && typeof event.text === "string") return event.text;
  return "";
}

function isToolStart(event) {
  const type = String(event.type || "");
  const phase = String(event.event || event.phase || event.status || "");
  return (type.includes("tool") && (phase === "start" || type.includes("requested"))) || event.type === "tool.started";
}

function isValidationTool(event) {
  const name = String(event.name || event.tool || event.toolName || event.request?.name || "");
  const command = String(event.command || event.request?.args?.command || event.args?.command || "");
  if (/auto.?verify|refuter|verify|typecheck|test/i.test(name)) return true;
  return /\b(tsc|typecheck|npm\s+test|npm\s+run\s+test|python3?\s+test_|node\s+test|pytest|vitest)\b/i.test(command);
}

function isRepairEvent(event) {
  const text = JSON.stringify(event);
  return /repair|retry|rerun|auto-verify.*failed|verification.*failed/i.test(text);
}

function isWasteEvent(event) {
  const text = JSON.stringify(event);
  return /empty_visible_answer|loop_guard|duplicate|denied|not permitted|EPERM|full-disk|same fingerprint/i.test(text);
}

function waitForExit(child, timeout) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeout);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
}

function runVerifier(cmd, args, cwd, timeout = 30000) {
  const result = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout });
  return {
    ok: result.status === 0,
    code: result.status ?? 1,
    signal: result.signal || null,
    stdout: (result.stdout || "").slice(-4000),
    stderr: (result.stderr || "").slice(-4000),
  };
}

function summarize(input) {
  const failed = input.results.filter((result) => !result.success).length;
  const passed = input.results.length - failed;
  const wall = input.results.map((result) => result.wallMs).sort((a, b) => a - b);
  const ttft = input.results.map((result) => result.ttftMs).filter((value) => typeof value === "number").sort((a, b) => a - b);
  const summary = {
    total: input.results.length,
    passed,
    failed,
    wallMs: percentileSummary(wall),
    ttftMs: percentileSummary(ttft),
    toolSteps: sum(input.results, "toolSteps"),
    validationSteps: sum(input.results, "validationSteps"),
    repairSteps: sum(input.results, "repairSteps"),
    wasteSteps: sum(input.results, "wasteSteps"),
    maxStepsReached: input.results.filter((result) => result.maxStepsReached).length,
  };
  return {
    schema: "lynn-cli-efficiency-gate-v1",
    label: input.label,
    suite: input.suite,
    startedAt: input.startedAt.toISOString(),
    finishedAt: input.finishedAt.toISOString(),
    summary,
    results: input.results,
  };
}

function percentileSummary(values) {
  if (!values.length) return null;
  return {
    min: values[0],
    p50: percentile(values, 0.5),
    p90: percentile(values, 0.9),
    max: values[values.length - 1],
  };
}

function percentile(values, p) {
  const idx = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * p) - 1));
  return values[idx];
}

function sum(results, field) {
  return results.reduce((acc, result) => acc + Number(result[field] || 0), 0);
}

function printDryRun(selected) {
  console.log("Lynn Harness Efficiency Gate (dry-run)");
  console.log("");
  console.log("This script measures StepFun-first task wall-clock without rewarding shallow answers.");
  console.log("Run live with:");
  console.log("  npm run build:cli && node scripts/cli-efficiency-gate.mjs --live --suite smoke");
  console.log("");
  console.log(`Selected suite: ${suite}`);
  for (const task of selected) {
    console.log(`- ${task.id} [${task.kind}] ${task.notes || ""}`);
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const eq = token.indexOf("=");
    if (eq > 0) {
      parsed[toCamel(token.slice(2, eq))] = token.slice(eq + 1);
      continue;
    }
    const key = toCamel(token.slice(2));
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      parsed[key] = next;
      i += 1;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function formatNullable(value) {
  return typeof value === "number" ? `${value}ms` : "--";
}
