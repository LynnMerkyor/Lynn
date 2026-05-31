#!/usr/bin/env node

import { spawn } from "node:child_process";
import process from "node:process";

const total = Number(process.env.LYNN_CLI_STRESS_N || process.env.N || 30);
const concurrency = Number(process.env.LYNN_CLI_STRESS_C || process.env.C || 5);
const prompt = process.env.LYNN_CLI_STRESS_PROMPT || "只回复 OK";
const cliArgs = [
  "cli/bin/lynn.mjs",
  "-p",
  prompt,
  "--reasoning",
  "off",
  "--json",
];

if (!Number.isFinite(total) || total < 1) throw new Error("LYNN_CLI_STRESS_N must be a positive number");
if (!Number.isFinite(concurrency) || concurrency < 1) throw new Error("LYNN_CLI_STRESS_C must be a positive number");

let next = 0;
let failed = 0;
const results = [];

function runOne(index) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, cliArgs, {
      cwd: process.cwd(),
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
    child.on("close", (code) => {
      const checked = validateJsonlRun(stdout, code ?? 1);
      const ok = checked.ok;
      if (!ok) failed += 1;
      results.push({
        index,
        ok,
        code: code ?? 1,
        ms: Date.now() - startedAt,
        ...checked,
        stderr: stderr.trim(),
        tail: stdout.split(/\r?\n/).slice(-6).join("\n"),
      });
      resolve();
    });
  });
}

function validateJsonlRun(stdout, code) {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  let hasVisibleDelta = false;
  let finishedOk = false;
  let jsonClean = true;
  let hiddenReasoningOnlyFailure = false;
  const parseErrors = [];

  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event.type === "assistant.delta" && String(event.text || "").trim()) hasVisibleDelta = true;
      if (event.type === "run.finished" && event.ok === true) finishedOk = true;
      if (event.type === "run.finished" && event.ok === false && event.code === "empty_visible_answer") {
        hiddenReasoningOnlyFailure = true;
      }
    } catch (error) {
      jsonClean = false;
      parseErrors.push(error instanceof Error ? error.message : String(error));
    }
  }

  const leakedTui = /Lynn CLI|╭|╰|›/.test(stdout);
  const ok = code === 0 && jsonClean && hasVisibleDelta && finishedOk && !hiddenReasoningOnlyFailure && !leakedTui;
  return {
    ok,
    jsonClean,
    hasVisibleDelta,
    finishedOk,
    hiddenReasoningOnlyFailure,
    leakedTui,
    parseErrors,
  };
}

async function worker() {
  while (next < total) {
    const index = ++next;
    await runOne(index);
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));

for (const result of results.sort((a, b) => a.index - b.index)) {
  process.stdout.write(`${result.ok ? "OK" : "FAIL"} #${result.index} ${result.ms}ms code=${result.code}\n`);
}

if (failed > 0) {
  process.stderr.write(`${JSON.stringify(results.filter((result) => !result.ok), null, 2)}\n`);
  process.exit(1);
}

process.stdout.write(`[cli-p-stress] passed ${total} runs, concurrency=${concurrency}\n`);
