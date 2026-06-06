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
const repeat = positiveInt(args.repeat || process.env.LYNN_EFFICIENCY_REPEAT || 1, "repeat");
const reportPath = path.resolve(String(args.out || path.join(outDir, `cli-efficiency-gate-${startedAt.toISOString().replace(/[:.]/g, "-")}.json`)));

if (args.compare === true) {
  const { baselinePath, experimentPath } = resolveCompareInputs(args);
  const baseline = loadReport(baselinePath);
  const experiment = loadReport(experimentPath);
  const comparison = compareReports(baseline, experiment, { requireSpeedup: args.requireSpeedup === true });
  printComparison(comparison);
  if (args.out) {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(comparison, null, 2)}\n`);
    console.log(`[cli-efficiency-gate] wrote ${reportPath}`);
  }
  process.exit(comparison.pass ? 0 : 1);
}

const allTasks = createTasks();
const tasks = selectTasks(allTasks, suite);
const taskRuns = expandTaskRuns(tasks, repeat);

if (!tasks.length) {
  throw new Error(`No efficiency tasks selected for suite=${suite}`);
}

if (!live) {
  printDryRun(tasks, taskRuns);
  process.exit(0);
}

fs.mkdirSync(outDir, { recursive: true });

const results = [];
for (const task of taskRuns) {
  const working = fs.mkdtempSync(path.join(os.tmpdir(), `lynn-efficiency-${safeFileId(task.id)}-`));
  try {
    task.setup?.(working);
    const run = await runTask(task, working);
    const verify = task.verify ? task.verify(working) : { ok: true, stdout: "", stderr: "" };
    const externalValidationSteps = task.verify ? 1 : 0;
    const validationSteps = run.validationSteps + externalValidationSteps;
    const success = run.exitCode === 0 && run.hasVisibleAnswer && run.outputOk && run.modelOk !== false && verify.ok;
    results.push({
      id: task.id,
      taskId: task.taskId,
      runIndex: task.runIndex,
      kind: task.kind,
      label,
      success,
      ...run,
      internalValidationSteps: run.validationSteps,
      externalValidationSteps,
      validationSteps,
      verifier: verify,
      prompt: task.prompt,
      notes: task.notes || "",
    });
    const status = success ? "PASS" : "FAIL";
    console.log(`${status} ${task.id} wall=${run.wallMs}ms ttft=${formatNullable(run.ttftMs)} tools=${run.toolSteps} validation=${validationSteps} waste=${run.wasteSteps}`);
  } finally {
    if (args.keep !== true) fs.rmSync(working, { recursive: true, force: true });
  }
}

const report = summarize({ label, suite, repeat, startedAt, finishedAt: new Date(), results });
const gate = evaluateEfficiencyGate(report.summary, args);
const finalReport = { ...report, gate };
fs.writeFileSync(reportPath, `${JSON.stringify(finalReport, null, 2)}\n`);
printGate(gate);
console.log(`[cli-efficiency-gate] wrote ${reportPath}`);

if (finalReport.summary.failed > 0 || !gate.pass) process.exit(1);

function createTasks() {
  return [
    {
      id: "local-runtime-answer",
      kind: "prompt",
      suite: ["smoke", "full"],
      prompt: "用两句话说明 Lynn CLI 当前默认模型路由和运行时优化。必须回答可见文本,不要调用工具。",
      notes: "Local runtime-knowledge shortcut; measures no-network UX, not StepFun model latency.",
      command: () => ["-p", "用两句话说明 Lynn CLI 当前默认模型路由和运行时优化。必须回答可见文本,不要调用工具。", "--json", "--reasoning", "high"],
    },
    {
      id: "fast-model-answer",
      kind: "prompt",
      suite: ["smoke", "cache", "full"],
      prompt: "用两句话解释 TypeScript discriminated union 适合解决什么问题。不要调用工具。",
      notes: "Fast StepFun model TTFT and visible answer.",
      requireModel: true,
      command: () => ["-p", "用两句话解释 TypeScript discriminated union 适合解决什么问题。不要调用工具。", "--json", "--reasoning", "high"],
    },
    {
      id: "structured-short-answer",
      kind: "prompt",
      suite: ["smoke", "full"],
      prompt: "只输出 JSON:{\"route\":\"StepFun-first\",\"localModels\":\"opt-in\"}。不要解释。",
      notes: "Schema boundary task; boundary stop is allowed only after the required JSON is visible.",
      command: () => ["-p", "只输出 JSON:{\"route\":\"StepFun-first\",\"localModels\":\"opt-in\"}。不要解释。", "--json", "--stop-at-json", "--reasoning", "high"],
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

function expandTaskRuns(tasks, repeatCount) {
  const runs = [];
  for (const task of tasks) {
    for (let i = 1; i <= repeatCount; i += 1) {
      runs.push({
        ...task,
        id: repeatCount > 1 ? `${task.id}#${i}` : task.id,
        taskId: task.id,
        runIndex: i,
      });
    }
  }
  return runs;
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
  let localAnswer = false;
  let usageEventCount = 0;
  let lastUsage = null;
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
      if (event.type === "run.finished" && event.local === true) localAnswer = true;
      if (event.type === "usage" && event.usage) {
        usageEventCount += 1;
        lastUsage = event.usage;
      }
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
  const modelOk = task.requireModel ? !localAnswer && usageEventCount > 0 : true;
  if (!outputOk) wasteSteps += 1;
  if (!modelOk) wasteSteps += 1;

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
    localAnswer,
    modelOk,
    usageEventCount,
    usage: summarizeUsage(lastUsage),
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
  const eventText = JSON.stringify(event);
  if (/auto.?verify|refuter|verify|typecheck|test/i.test(name)) return true;
  return /\b(tsc|typecheck|npm\s+test|npm\s+run\s+(?:test|typecheck)|python3?\s+test_|node\s+test|pytest|vitest)\b/i.test(`${command}\n${eventText}`);
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
    taskCount: new Set(input.results.map((result) => result.taskId || result.id)).size,
    repeat: input.repeat,
    passed,
    failed,
    successRate: input.results.length ? passed / input.results.length : 0,
    totalWallMs: sum(input.results, "wallMs"),
    successPerHour: successPerHour(passed, sum(input.results, "wallMs")),
    wallMs: percentileSummary(wall),
    ttftMs: percentileSummary(ttft),
    toolSteps: sum(input.results, "toolSteps"),
    validationSteps: sum(input.results, "validationSteps"),
    repairSteps: sum(input.results, "repairSteps"),
    validRepairSteps: sum(input.results, "repairSteps"),
    wasteSteps: sum(input.results, "wasteSteps"),
    maxStepsReached: input.results.filter((result) => result.maxStepsReached).length,
    localAnswers: input.results.filter((result) => result.localAnswer).length,
    modelRuns: input.results.filter((result) => result.modelOk !== false && result.usageEventCount > 0).length,
    promptTokens: sumUsage(input.results, "promptTokens"),
    completionTokens: sumUsage(input.results, "completionTokens"),
    cacheHitTokens: sumUsage(input.results, "cacheHitTokens"),
    cacheWriteTokens: sumUsage(input.results, "cacheWriteTokens"),
  };
  summary.cacheHitRatio = summary.promptTokens > 0 ? summary.cacheHitTokens / summary.promptTokens : null;
  summary.taskStats = summarizeByTask(input.results);
  return {
    schema: "lynn-cli-efficiency-gate-v1",
    label: input.label,
    suite: input.suite,
    repeat: input.repeat,
    startedAt: input.startedAt.toISOString(),
    finishedAt: input.finishedAt.toISOString(),
    summary,
    results: input.results,
  };
}

function evaluateEfficiencyGate(summary, parsedArgs) {
  const checks = [
    thresholdCheck("minSuccessRate", "success rate", readRatioOption(parsedArgs, "minSuccessRate", "LYNN_EFFICIENCY_MIN_SUCCESS_RATE"), summary.successRate, (actual, expected) => actual >= expected, percent),
    thresholdCheck("minSuccessPerHour", "success/hour", readNumberOption(parsedArgs, "minSuccessPerHour", "LYNN_EFFICIENCY_MIN_SUCCESS_PER_HOUR"), summary.successPerHour, (actual, expected) => actual >= expected, fmtNumber),
    thresholdCheck("maxP50WallMs", "p50 wall", readNumberOption(parsedArgs, "maxP50WallMs", "LYNN_EFFICIENCY_MAX_P50_WALL_MS"), summary.wallMs?.p50, (actual, expected) => actual <= expected, formatNullable),
    thresholdCheck("maxP50TtftMs", "p50 TTFT", readNumberOption(parsedArgs, "maxP50TtftMs", "LYNN_EFFICIENCY_MAX_P50_TTFT_MS"), summary.ttftMs?.p50, (actual, expected) => actual <= expected, formatNullable),
    thresholdCheck("minCacheHitRatio", "prefix-cache hit ratio", readRatioOption(parsedArgs, "minCacheHitRatio", "LYNN_EFFICIENCY_MIN_CACHE_HIT_RATIO"), summary.cacheHitRatio, (actual, expected) => actual >= expected, percent),
    thresholdCheck("minCacheHitTokens", "prefix-cache hit tokens", readNumberOption(parsedArgs, "minCacheHitTokens", "LYNN_EFFICIENCY_MIN_CACHE_HIT_TOKENS"), summary.cacheHitTokens, (actual, expected) => actual >= expected, String),
    thresholdCheck("maxWasteSteps", "waste steps", readNumberOption(parsedArgs, "maxWasteSteps", "LYNN_EFFICIENCY_MAX_WASTE_STEPS"), summary.wasteSteps, (actual, expected) => actual <= expected, String),
    thresholdCheck("maxMaxStepsReached", "max-steps hits", readNumberOption(parsedArgs, "maxMaxStepsReached", "LYNN_EFFICIENCY_MAX_MAX_STEPS_REACHED"), summary.maxStepsReached, (actual, expected) => actual <= expected, String),
  ].filter(Boolean);
  const failures = checks.filter((check) => !check.pass);
  return {
    pass: failures.length === 0,
    checked: checks.length,
    checks,
    reasons: failures.map((check) => `${check.label} ${check.actualFormatted} failed ${check.operator} ${check.expectedFormatted}`),
  };
}

function thresholdCheck(key, label, expected, actual, predicate, format) {
  if (expected === null) return null;
  const actualNumber = typeof actual === "number" && Number.isFinite(actual) ? actual : null;
  const pass = actualNumber !== null && predicate(actualNumber, expected);
  return {
    key,
    label,
    pass,
    actual: actualNumber,
    expected,
    actualFormatted: actualNumber === null ? "--" : format(actualNumber),
    expectedFormatted: format(expected),
    operator: predicate(2, 1) ? ">=" : "<=",
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

function summarizeByTask(results) {
  const groups = new Map();
  for (const result of results) {
    const taskId = result.taskId || result.id;
    if (!groups.has(taskId)) groups.set(taskId, []);
    groups.get(taskId).push(result);
  }
  return Array.from(groups.entries()).map(([taskId, taskResults]) => {
    const sorted = [...taskResults].sort((a, b) => Number(a.runIndex || 1) - Number(b.runIndex || 1));
    const passed = sorted.filter((result) => result.success).length;
    const promptTokens = sumUsage(sorted, "promptTokens");
    const cacheHitTokens = sumUsage(sorted, "cacheHitTokens");
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    return {
      taskId,
      runs: sorted.length,
      passed,
      failed: sorted.length - passed,
      successRate: sorted.length ? passed / sorted.length : 0,
      successPerHour: successPerHour(passed, sum(sorted, "wallMs")),
      wallMs: percentileSummary(sorted.map((result) => result.wallMs).sort((a, b) => a - b)),
      ttftMs: percentileSummary(sorted.map((result) => result.ttftMs).filter((value) => typeof value === "number").sort((a, b) => a - b)),
      toolSteps: sum(sorted, "toolSteps"),
      validationSteps: sum(sorted, "validationSteps"),
      wasteSteps: sum(sorted, "wasteSteps"),
      promptTokens,
      cacheHitTokens,
      cacheHitRatio: promptTokens > 0 ? cacheHitTokens / promptTokens : null,
      firstRun: summarizeRunForTrend(first),
      lastRun: summarizeRunForTrend(last),
      cacheHitTokensDelta: runUsageValue(last, "cacheHitTokens") - runUsageValue(first, "cacheHitTokens"),
      wallMsDelta: Number(last?.wallMs || 0) - Number(first?.wallMs || 0),
      ttftMsDelta: nullableDelta(last?.ttftMs, first?.ttftMs),
    };
  });
}

function summarizeRunForTrend(result) {
  if (!result) return null;
  return {
    id: result.id,
    runIndex: result.runIndex,
    success: Boolean(result.success),
    wallMs: result.wallMs,
    ttftMs: result.ttftMs,
    promptTokens: runUsageValue(result, "promptTokens"),
    cacheHitTokens: runUsageValue(result, "cacheHitTokens"),
    cacheHitRatio: runUsageRatio(result),
  };
}

function runUsageValue(result, field) {
  return Number(result?.usage?.[field] || 0);
}

function runUsageRatio(result) {
  const promptTokens = runUsageValue(result, "promptTokens");
  if (!promptTokens) return null;
  return runUsageValue(result, "cacheHitTokens") / promptTokens;
}

function percentile(values, p) {
  const idx = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * p) - 1));
  return values[idx];
}

function sum(results, field) {
  return results.reduce((acc, result) => acc + Number(result[field] || 0), 0);
}

function sumUsage(results, field) {
  return results.reduce((acc, result) => acc + Number(result.usage?.[field] || 0), 0);
}

function successPerHour(passed, totalWallMs) {
  if (!totalWallMs) return null;
  return passed / (totalWallMs / 3600000);
}

function resolveCompareInputs(parsedArgs) {
  const positionals = parsedArgs._ || [];
  const baselinePath = parsedArgs.baseline || parsedArgs.base || positionals[0];
  const experimentPath = parsedArgs.experiment || parsedArgs.exp || positionals[1];
  if (!baselinePath || !experimentPath) {
    throw new Error("Usage: node scripts/cli-efficiency-gate.mjs --compare --baseline baseline.json --experiment experiment.json");
  }
  return {
    baselinePath: path.resolve(String(baselinePath)),
    experimentPath: path.resolve(String(experimentPath)),
  };
}

function loadReport(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function compareReports(baseline, experiment, options = {}) {
  const base = normalizedReportMetrics(baseline);
  const exp = normalizedReportMetrics(experiment);
  const reasons = [];
  const warnings = [];
  const taskComparisons = compareTasks(baseline.results || [], experiment.results || [], reasons, warnings);
  const taskStatComparisons = compareTaskStats(baseline, experiment, reasons, warnings);

  if (exp.successRate < base.successRate) {
    reasons.push(`success rate regressed: ${percent(exp.successRate)} < ${percent(base.successRate)}`);
  }
  if (exp.failed > base.failed) {
    reasons.push(`failed task count increased: ${exp.failed} > ${base.failed}`);
  }
  if (exp.wasteSteps > base.wasteSteps) {
    reasons.push(`waste steps increased: ${exp.wasteSteps} > ${base.wasteSteps}`);
  }
  if (exp.maxStepsReached > base.maxStepsReached) {
    reasons.push(`max-steps hits increased: ${exp.maxStepsReached} > ${base.maxStepsReached}`);
  }
  if (options.requireSpeedup && Number(exp.successPerHour || 0) <= Number(base.successPerHour || 0)) {
    reasons.push(`success/hour did not improve: ${fmtNumber(exp.successPerHour)} <= ${fmtNumber(base.successPerHour)}`);
  }

  return {
    schema: "lynn-cli-efficiency-compare-v1",
    pass: reasons.length === 0,
    requireSpeedup: Boolean(options.requireSpeedup),
    baseline: base,
    experiment: exp,
    deltas: {
      successRate: exp.successRate - base.successRate,
      successPerHour: nullableDelta(exp.successPerHour, base.successPerHour),
      totalWallMs: exp.totalWallMs - base.totalWallMs,
      p50WallMs: nullableDelta(exp.p50WallMs, base.p50WallMs),
      p50TtftMs: nullableDelta(exp.p50TtftMs, base.p50TtftMs),
      wasteSteps: exp.wasteSteps - base.wasteSteps,
      validationSteps: exp.validationSteps - base.validationSteps,
      repairSteps: exp.repairSteps - base.repairSteps,
      cacheHitRatio: nullableDelta(exp.cacheHitRatio, base.cacheHitRatio),
    },
    taskComparisons,
    taskStatComparisons,
    reasons,
    warnings,
  };
}

function normalizedReportMetrics(report) {
  const results = report.results || [];
  const summary = report.summary || {};
  const total = Number(summary.total ?? results.length ?? 0);
  const taskCount = Number(summary.taskCount ?? new Set(results.map((result) => result.taskId || result.id)).size ?? total);
  const repeat = Number(summary.repeat ?? report.repeat ?? 1);
  const passed = Number(summary.passed ?? results.filter((result) => result.success).length ?? 0);
  const failed = Number(summary.failed ?? Math.max(0, total - passed));
  const totalWallMs = Number(summary.totalWallMs ?? sum(results, "wallMs"));
  const promptTokens = Number(summary.promptTokens ?? sumUsage(results, "promptTokens"));
  const cacheHitTokens = Number(summary.cacheHitTokens ?? sumUsage(results, "cacheHitTokens"));
  return {
    label: String(report.label || ""),
    suite: String(report.suite || ""),
    total,
    taskCount,
    repeat,
    passed,
    failed,
    successRate: Number(summary.successRate ?? (total ? passed / total : 0)),
    totalWallMs,
    successPerHour: Number(summary.successPerHour ?? successPerHour(passed, totalWallMs) ?? 0),
    p50WallMs: valueAt(summary.wallMs, "p50"),
    p50TtftMs: valueAt(summary.ttftMs, "p50"),
    toolSteps: Number(summary.toolSteps || 0),
    validationSteps: Number(summary.validationSteps || 0),
    repairSteps: Number(summary.repairSteps || 0),
    wasteSteps: Number(summary.wasteSteps || 0),
    maxStepsReached: Number(summary.maxStepsReached || 0),
    promptTokens,
    completionTokens: Number(summary.completionTokens || sumUsage(results, "completionTokens")),
    cacheHitTokens,
    cacheWriteTokens: Number(summary.cacheWriteTokens || sumUsage(results, "cacheWriteTokens")),
    cacheHitRatio: summary.cacheHitRatio ?? (promptTokens > 0 ? cacheHitTokens / promptTokens : null),
  };
}

function compareTasks(baselineResults, experimentResults, reasons, warnings) {
  const experimentById = new Map(experimentResults.map((result) => [result.id, result]));
  const comparisons = [];
  for (const baseTask of baselineResults) {
    const expTask = experimentById.get(baseTask.id);
    if (!expTask) {
      reasons.push(`missing experiment task: ${baseTask.id}`);
      continue;
    }
    const comparison = {
      id: baseTask.id,
      kind: baseTask.kind,
      baselineSuccess: Boolean(baseTask.success),
      experimentSuccess: Boolean(expTask.success),
      wallMsDelta: Number(expTask.wallMs || 0) - Number(baseTask.wallMs || 0),
      validationStepsDelta: Number(expTask.validationSteps || 0) - Number(baseTask.validationSteps || 0),
      wasteStepsDelta: Number(expTask.wasteSteps || 0) - Number(baseTask.wasteSteps || 0),
    };
    comparisons.push(comparison);
    if (baseTask.success && !expTask.success) {
      reasons.push(`task regressed from pass to fail: ${baseTask.id}`);
    }
    if (Number(expTask.wasteSteps || 0) > Number(baseTask.wasteSteps || 0)) {
      reasons.push(`task waste increased: ${baseTask.id}`);
    }
    if (isQualityTask(baseTask) && Number(baseTask.validationSteps || 0) > 0 && Number(expTask.validationSteps || 0) < Number(baseTask.validationSteps || 0)) {
      reasons.push(`quality task lost validation work: ${baseTask.id} (${expTask.validationSteps} < ${baseTask.validationSteps})`);
    }
    if (Number(expTask.repairSteps || 0) < Number(baseTask.repairSteps || 0)) {
      warnings.push(`repair steps decreased for ${baseTask.id}; confirm this is due to fewer failures, not disabled repair`);
    }
  }
  return comparisons;
}

function compareTaskStats(baseline, experiment, reasons, warnings) {
  const baselineStats = normalizedTaskStats(baseline);
  const experimentStats = normalizedTaskStats(experiment);
  const experimentByTaskId = new Map(experimentStats.map((stat) => [stat.taskId, stat]));
  const comparisons = [];
  for (const baseTask of baselineStats) {
    const expTask = experimentByTaskId.get(baseTask.taskId);
    if (!expTask) {
      reasons.push(`missing experiment task group: ${baseTask.taskId}`);
      continue;
    }
    const comparison = {
      taskId: baseTask.taskId,
      baselineRuns: baseTask.runs,
      experimentRuns: expTask.runs,
      successRateDelta: nullableDelta(expTask.successRate, baseTask.successRate),
      successPerHourDelta: nullableDelta(expTask.successPerHour, baseTask.successPerHour),
      p50WallMsDelta: nullableDelta(valueAt(expTask.wallMs, "p50"), valueAt(baseTask.wallMs, "p50")),
      p50TtftMsDelta: nullableDelta(valueAt(expTask.ttftMs, "p50"), valueAt(baseTask.ttftMs, "p50")),
      cacheHitRatioDelta: nullableDelta(expTask.cacheHitRatio, baseTask.cacheHitRatio),
      cacheHitTokensDeltaDelta: nullableDelta(expTask.cacheHitTokensDelta, baseTask.cacheHitTokensDelta),
      validationStepsDelta: Number(expTask.validationSteps || 0) - Number(baseTask.validationSteps || 0),
      wasteStepsDelta: Number(expTask.wasteSteps || 0) - Number(baseTask.wasteSteps || 0),
    };
    comparisons.push(comparison);
    if (Number(expTask.runs || 0) < Number(baseTask.runs || 0)) {
      reasons.push(`task repeat coverage regressed: ${baseTask.taskId} (${expTask.runs} < ${baseTask.runs})`);
    }
    if (Number(expTask.wasteSteps || 0) > Number(baseTask.wasteSteps || 0)) {
      reasons.push(`task group waste increased: ${baseTask.taskId}`);
    }
    if (typeof comparison.cacheHitRatioDelta === "number" && comparison.cacheHitRatioDelta < -0.05) {
      warnings.push(`prefix-cache ratio decreased for ${baseTask.taskId}: ${signedPercentPoints(comparison.cacheHitRatioDelta)}`);
    }
  }
  return comparisons;
}

function normalizedTaskStats(report) {
  const fromSummary = report?.summary?.taskStats;
  if (Array.isArray(fromSummary) && fromSummary.length) return fromSummary;
  return summarizeByTask(report?.results || []);
}

function isQualityTask(task) {
  return task.kind === "code" || /refactor|fix|review|exhaustive|ultra/i.test(String(task.id || ""));
}

function valueAt(object, key) {
  return object && typeof object[key] === "number" ? object[key] : null;
}

function nullableDelta(value, base) {
  if (typeof value !== "number" || typeof base !== "number") return null;
  return value - base;
}

function printComparison(comparison) {
  const mark = comparison.pass ? "PASS" : "FAIL";
  console.log(`Lynn Harness Efficiency Compare: ${mark}`);
  console.log(`baseline:   success=${comparison.baseline.passed}/${comparison.baseline.total} success/hour=${fmtNumber(comparison.baseline.successPerHour)} p50Wall=${formatNullable(comparison.baseline.p50WallMs)} p50TTFT=${formatNullable(comparison.baseline.p50TtftMs)} waste=${comparison.baseline.wasteSteps} validation=${comparison.baseline.validationSteps} cache=${percent(comparison.baseline.cacheHitRatio)}`);
  console.log(`experiment: success=${comparison.experiment.passed}/${comparison.experiment.total} success/hour=${fmtNumber(comparison.experiment.successPerHour)} p50Wall=${formatNullable(comparison.experiment.p50WallMs)} p50TTFT=${formatNullable(comparison.experiment.p50TtftMs)} waste=${comparison.experiment.wasteSteps} validation=${comparison.experiment.validationSteps} cache=${percent(comparison.experiment.cacheHitRatio)}`);
  console.log(`delta:      success/hour=${signed(comparison.deltas.successPerHour)} totalWall=${signedMs(comparison.deltas.totalWallMs)} p50Wall=${signedMs(comparison.deltas.p50WallMs)} p50TTFT=${signedMs(comparison.deltas.p50TtftMs)} waste=${signed(comparison.deltas.wasteSteps)} validation=${signed(comparison.deltas.validationSteps)}`);
  if (comparison.taskStatComparisons.length) {
    console.log("");
    console.log("Per-task deltas:");
    for (const task of comparison.taskStatComparisons) {
      console.log(`- ${task.taskId}: runs ${task.baselineRuns}->${task.experimentRuns} success=${signedPercentPoints(task.successRateDelta)} success/hour=${signed(task.successPerHourDelta)} p50Wall=${signedMs(task.p50WallMsDelta)} p50TTFT=${signedMs(task.p50TtftMsDelta)} cache=${signedPercentPoints(task.cacheHitRatioDelta)} validation=${signed(task.validationStepsDelta)} waste=${signed(task.wasteStepsDelta)}`);
    }
  }
  if (comparison.reasons.length) {
    console.log("");
    console.log("Quality gate failures:");
    for (const reason of comparison.reasons) console.log(`- ${reason}`);
  }
  if (comparison.warnings.length) {
    console.log("");
    console.log("Warnings:");
    for (const warning of comparison.warnings) console.log(`- ${warning}`);
  }
}

function fmtNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "--";
}

function percent(value) {
  return typeof value === "number" && Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "--";
}

function signedPercentPoints(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "--";
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}pp`;
}

function signed(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "--";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
}

function signedMs(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "--";
  return `${value >= 0 ? "+" : ""}${Math.round(value)}ms`;
}

function summarizeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const promptTokens = Number(usage.prompt_tokens || usage.input_tokens || 0);
  const completionTokens = Number(usage.completion_tokens || usage.output_tokens || 0);
  const totalTokens = Number(usage.total_tokens || promptTokens + completionTokens || 0);
  const details = usage.prompt_tokens_details || usage.input_tokens_details || {};
  const cacheHitTokens = Number(details.cached_tokens || details.cache_read_input_tokens || usage.cacheHitTokens || 0);
  const cacheWriteTokens = Number(details.cache_creation_input_tokens || details.cache_write_input_tokens || usage.cacheWriteTokens || 0);
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cacheHitTokens,
    cacheWriteTokens,
  };
}

function printDryRun(selected, runs) {
  console.log("Lynn Harness Efficiency Gate (dry-run)");
  console.log("");
  console.log("This script measures StepFun-first wall-clock without rewarding shallow answers.");
  console.log("Valid repair, rerun, verification, and refuter steps are quality work; only repeated no-op failures count as waste.");
  console.log("Run live with:");
  console.log("  npm run build:cli && node scripts/cli-efficiency-gate.mjs --live --suite smoke");
  console.log("");
  console.log(`Selected suite: ${suite}`);
  console.log(`Repeat: ${repeat} (${runs.length} task runs)`);
  for (const task of selected) {
    console.log(`- ${task.id} [${task.kind}] ${task.notes || ""}`);
  }
}

function printGate(gate) {
  if (!gate.checked) return;
  console.log(`Gate: ${gate.pass ? "PASS" : "FAIL"} (${gate.checked} checks)`);
  for (const check of gate.checks) {
    const mark = check.pass ? "PASS" : "FAIL";
    console.log(`- ${mark} ${check.label}: ${check.actualFormatted} ${check.operator} ${check.expectedFormatted}`);
  }
}

function positiveInt(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function readNumberOption(parsedArgs, key, envName) {
  const raw = parsedArgs[key] ?? process.env[envName];
  if (raw === undefined || raw === null || raw === false) return null;
  const parsed = Number(String(raw).trim());
  if (!Number.isFinite(parsed)) throw new Error(`${key} must be a number`);
  return parsed;
}

function readRatioOption(parsedArgs, key, envName) {
  const raw = parsedArgs[key] ?? process.env[envName];
  if (raw === undefined || raw === null || raw === false) return null;
  const text = String(raw).trim();
  const parsed = text.endsWith("%") ? Number(text.slice(0, -1)) / 100 : Number(text);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${key} must be a ratio such as 0.95 or 95%`);
  return parsed > 1 ? parsed / 100 : parsed;
}

function safeFileId(value) {
  return String(value).replace(/[^a-zA-Z0-9_.-]/g, "-");
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      if (!parsed._) parsed._ = [];
      parsed._.push(token);
      continue;
    }
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
