#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const repo = path.resolve(new URL("..", import.meta.url).pathname);
const cli = path.join(repo, "cli/bin/lynn.mjs");
const outDir = path.join(repo, "output");
const startedAt = new Date();
const args = parseArgs(process.argv.slice(2));

const stepfunRuns = positiveInt(args.stepfunRuns || process.env.LYNN_ROUTE_STEPFUN_RUNS || 5, "stepfun-runs");
const sparkRuns = positiveInt(args.sparkRuns || process.env.LYNN_ROUTE_SPARK_RUNS || 3, "spark-runs");
const timeoutMs = positiveInt(args.timeoutMs || process.env.LYNN_ROUTE_TIMEOUT_MS || 30000, "timeout-ms");
const sparkBaseUrl = String(args.sparkBaseUrl || process.env.LYNN_SPARK_URL || "http://127.0.0.1:18098/v1").replace(/\/$/, "");
const sparkModel = String(args.sparkModel || process.env.LYNN_SPARK_MODEL || "qwen36-35b-a3b-apex-mtp");
const label = String(args.label || process.env.LYNN_ROUTE_LABEL || "route-latency-smoke");
const reportPath = path.resolve(String(args.out || path.join(outDir, `cli-route-latency-${startedAt.toISOString().replace(/[:.]/g, "-")}.json`)));
const requireSpark = args.requireSpark === true || process.env.LYNN_ROUTE_REQUIRE_SPARK === "1";

if (args.help === true) {
  printHelp();
  process.exit(0);
}

fs.mkdirSync(outDir, { recursive: true });

const stepfun = [];
for (let i = 1; i <= stepfunRuns; i += 1) {
  stepfun.push(await runStepFun(i));
}

const sparkHealth = await probeSparkHealth();
const spark = [];
for (let i = 1; i <= sparkRuns; i += 1) {
  spark.push(await runSpark(i));
}

const report = summarize({
  schema: "lynn-cli-route-latency-smoke-v1",
  label,
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  stepfun,
  spark,
  sparkHealth,
  sparkBaseUrl,
  sparkModel,
});

fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
printSummary(report, reportPath);

if (report.summary.stepfun.successes === 0) process.exit(1);
if (requireSpark && report.summary.spark.successes === 0) process.exit(1);

async function runStepFun(index) {
  const started = Date.now();
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, "-p", "只回复 OK", "--json", "--reasoning", "high"], {
      cwd: repo,
      env: { ...process.env, LYNN_CLI_UPDATE_CHECK: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let buffer = "";
    let firstProviderMs = null;
    let firstAssistantMs = null;
    let activeProvider = null;
    let assistantText = "";
    let lastUsage = null;
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);

    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      stdout += text;
      buffer += text;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const event = parseJsonLine(line);
        if (!event) continue;
        const atMs = Date.now() - started;
        if (event.type === "provider" && firstProviderMs === null) {
          firstProviderMs = atMs;
          activeProvider = event.activeProvider || null;
        }
        if (event.type === "assistant.delta") {
          firstAssistantMs ??= atMs;
          assistantText += event.text || "";
        }
        if (event.type === "usage") lastUsage = event.usage || lastUsage;
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const wallMs = Date.now() - started;
      resolve({
        index,
        route: "stepfun-cli",
        ok: code === 0 && /\bOK\b/i.test(assistantText),
        code,
        signal,
        wallMs,
        firstProviderMs,
        ttftMs: firstAssistantMs,
        activeProvider,
        text: assistantText.trim(),
        cacheHitTokens: cacheHitTokens(lastUsage),
        promptTokens: lastUsage?.prompt_tokens ?? null,
        totalTokens: lastUsage?.total_tokens ?? null,
        error: stderr.trim().slice(-800) || null,
        stdoutTail: stdout.slice(-800),
      });
    });
  });
}

async function probeSparkHealth() {
  const healthUrl = sparkBaseUrl.replace(/\/v1$/, "") + "/health";
  const started = Date.now();
  try {
    const response = await fetchWithTimeout(healthUrl, { method: "GET" }, Math.min(timeoutMs, 5000));
    const body = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      wallMs: Date.now() - started,
      url: healthUrl,
      body: body.slice(0, 500),
    };
  } catch (error) {
    return {
      ok: false,
      wallMs: Date.now() - started,
      url: healthUrl,
      error: String(error?.message || error),
    };
  }
}

async function runSpark(index) {
  const started = Date.now();
  const endpoint = `${sparkBaseUrl}/chat/completions`;
  try {
    const response = await fetchWithTimeout(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: sparkModel,
        messages: [{ role: "user", content: "只回复 OK" }],
        stream: true,
        temperature: 0,
        max_tokens: 16,
      }),
    }, timeoutMs);
    if (!response.ok) {
      return {
        index,
        route: "spark-direct",
        ok: false,
        status: response.status,
        wallMs: Date.now() - started,
        ttftMs: null,
        text: "",
        error: (await response.text()).slice(0, 800),
      };
    }
    const { text, ttftMs } = await readSseText(response, started);
    return {
      index,
      route: "spark-direct",
      ok: /\bOK\b/i.test(text),
      status: response.status,
      wallMs: Date.now() - started,
      ttftMs,
      text: text.trim(),
      error: null,
    };
  } catch (error) {
    return {
      index,
      route: "spark-direct",
      ok: false,
      status: null,
      wallMs: Date.now() - started,
      ttftMs: null,
      text: "",
      error: String(error?.message || error),
    };
  }
}

async function readSseText(response, started) {
  const reader = response.body?.getReader();
  if (!reader) return { text: await response.text(), ttftMs: null };
  const decoder = new TextDecoder();
  let buffer = "";
  let result = "";
  let ttftMs = null;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const event = JSON.parse(data);
        const delta = event.choices?.[0]?.delta?.content || event.choices?.[0]?.message?.content || "";
        if (delta) {
          ttftMs ??= Date.now() - started;
          result += delta;
        }
      } catch {
        // Keep reading: some providers emit comments or non-JSON lines.
      }
    }
  }
  return { text: result, ttftMs };
}

async function fetchWithTimeout(url, init, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function summarize(report) {
  const summary = {
    stepfun: routeSummary(report.stepfun),
    spark: routeSummary(report.spark),
    recommendation: null,
  };
  if (summary.stepfun.successes > 0 && summary.spark.successes === 0) {
    summary.recommendation = "StepFun 3.7 Flash should remain the default critical path; Spark/A3B is opt-in/local fallback because it is not reachable in this run.";
  } else if (summary.stepfun.successes > 0 && summary.spark.successes > 0) {
    summary.recommendation = "Keep StepFun as default unless Spark is explicitly warm and materially better for this task class; local routes remain opt-in because they add an availability dependency.";
  } else {
    summary.recommendation = "StepFun default path failed in this run; investigate Brain/StepFun connectivity before release.";
  }
  return { ...report, summary };
}

function routeSummary(runs) {
  const successes = runs.filter((run) => run.ok);
  return {
    total: runs.length,
    successes: successes.length,
    successRate: runs.length ? successes.length / runs.length : null,
    p50WallMs: percentile(successes.map((run) => run.wallMs), 0.5),
    p90WallMs: percentile(successes.map((run) => run.wallMs), 0.9),
    p50TtftMs: percentile(successes.map((run) => run.ttftMs).filter((value) => typeof value === "number"), 0.5),
    p90TtftMs: percentile(successes.map((run) => run.ttftMs).filter((value) => typeof value === "number"), 0.9),
    p50CacheHitTokens: percentile(successes.map((run) => run.cacheHitTokens).filter((value) => typeof value === "number"), 0.5),
  };
}

function percentile(values, p) {
  const clean = values.filter((value) => typeof value === "number" && Number.isFinite(value)).sort((a, b) => a - b);
  if (!clean.length) return null;
  return clean[Math.min(clean.length - 1, Math.max(0, Math.ceil(clean.length * p) - 1))];
}

function cacheHitTokens(usage) {
  return usage?.prompt_tokens_details?.cached_tokens ?? usage?.cached_tokens ?? null;
}

function parseJsonLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function printSummary(report, file) {
  const step = report.summary.stepfun;
  const spark = report.summary.spark;
  console.log("Lynn Route Latency Smoke");
  console.log(`StepFun: ${step.successes}/${step.total} ok p50Wall=${formatMs(step.p50WallMs)} p50TTFT=${formatMs(step.p50TtftMs)} cacheHit=${step.p50CacheHitTokens ?? "--"}`);
  console.log(`Spark:   ${spark.successes}/${spark.total} ok p50Wall=${formatMs(spark.p50WallMs)} p50TTFT=${formatMs(spark.p50TtftMs)} health=${report.sparkHealth.ok ? "ok" : "failed"}`);
  if (!report.sparkHealth.ok) console.log(`Spark health error: ${report.sparkHealth.error || report.sparkHealth.body || report.sparkHealth.status}`);
  console.log(`Recommendation: ${report.summary.recommendation}`);
  console.log(`[cli-route-latency-smoke] wrote ${file}`);
}

function formatMs(value) {
  return typeof value === "number" && Number.isFinite(value) ? `${value}ms` : "--";
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = camel(arg.slice(2));
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      i += 1;
    }
  }
  return parsed;
}

function positiveInt(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function camel(value) {
  return value.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function printHelp() {
  console.log(`Usage: node scripts/cli-route-latency-smoke.mjs [options]

Measures the product default StepFun route through Lynn CLI and probes the local Spark endpoint.
Spark failures are recorded as availability evidence, not a script failure, unless --require-spark is set.

Options:
  --stepfun-runs N       StepFun CLI runs (default 5)
  --spark-runs N         Spark direct runs (default 3)
  --spark-base-url URL   Spark OpenAI-compatible base URL (default http://127.0.0.1:18098/v1)
  --spark-model ID       Spark model id (default qwen36-35b-a3b-apex-mtp)
  --timeout-ms N         Per-run timeout (default 30000)
  --out FILE             JSON report path
  --require-spark        Fail if Spark has no successful run
`);
}
