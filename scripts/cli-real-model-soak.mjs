#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(root, "cli", "bin", "lynn.mjs");
const timeoutMs = numberEnv("LYNN_CLI_REAL_TIMEOUT_MS", 60_000);
const serialTurns = numberEnv("LYNN_CLI_REAL_TURNS", 6);
const parallelTurns = numberEnv("LYNN_CLI_REAL_PARALLEL", 2, 0);
const runInteractive = process.env.LYNN_CLI_REAL_INTERACTIVE !== "0";
const brainUrl = argValue("--brain-url") || process.env.LYNN_CLI_REAL_BRAIN_URL || "";

await fs.access(cliEntry);

const report = {
  startedAt: new Date().toISOString(),
  cliEntry,
  brainUrl: brainUrl || "(cli default)",
  cases: [],
};

const baseEnv = {
  ...process.env,
  LYNN_CLI_UPDATE_CHECK: "0",
  LYNN_LANG: process.env.LYNN_LANG || "zh",
  // Do not force mock. This script is intentionally a real Brain/model gate.
};
if (brainUrl) baseEnv.LYNN_BRAIN_URL = brainUrl;

await runHeadlessCases();
if (runInteractive) await runInteractivePtyCase();

report.finishedAt = new Date().toISOString();
const outDir = path.join(root, "output");
await fs.mkdir(outDir, { recursive: true });
const reportPath = path.join(outDir, `cli-real-model-soak-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

console.log(`[cli-real-model-soak] passed ${report.cases.length} real-model cases; report=${reportPath}`);

async function runHeadlessCases() {
  const cases = [
    {
      name: "prompt-ok",
      args: ["-p", "只回复 OK", "--reasoning", "off"],
      expect: /OK/i,
    },
    {
      name: "prompt-arithmetic",
      args: ["-p", "计算 7+5, 只回复数字", "--reasoning", "off"],
      expect: /\b12\b/,
    },
    {
      name: "prompt-headless-doc",
      args: ["-p", "用一句话说明 Lynn CLI 的 -p 无交互模式", "--reasoning", "off"],
      expect: /(-p|无交互|非交互|print|headless)/i,
    },
    {
      name: "prompt-chain-arithmetic",
      args: ["-p", "AAPL 股价假设为 195.30 美元,请计算 100 股市值。只输出 19530 或 19,530。", "--reasoning", "off"],
      expect: /(19,?530|19530)/i,
    },
    {
      name: "prompt-chain-search-awareness",
      args: ["-p", "如果需要实时资料,请先使用工具结果,再用一句话回答: Lynn CLI 是什么?", "--reasoning", "off"],
      expect: /(Lynn|CLI|终端|command|terminal)/i,
    },
    {
      name: "code-headless-json",
      args: ["code", "-p", "不要改文件。只回复 READY", "--json", "--reasoning", "off"],
      expect: /READY/i,
      expectJsonish: true,
    },
  ];

  for (const testCase of cases.slice(0, Math.min(serialTurns, cases.length))) {
    await runCliCase(testCase);
  }

  const parallelCases = Array.from({ length: parallelTurns }, (_, index) => ({
    name: `parallel-ok-${index + 1}`,
    args: ["-p", `只回复 OK-${index + 1}`, "--reasoning", "off"],
    expect: new RegExp(`OK[- ]?${index + 1}`, "i"),
  }));
  await Promise.all(parallelCases.map((testCase) => runCliCase(testCase)));
}

async function runCliCase(testCase) {
  const started = Date.now();
  const result = await run(process.execPath, [cliEntry, ...testCase.args], { env: baseEnv, timeoutMs });
  const combined = `${result.stdout}\n${result.stderr}`;
  assertResultOk(testCase.name, result, combined);
  if (!testCase.expect.test(combined)) {
    throw new Error(`[cli-real-model-soak] ${testCase.name} did not match ${testCase.expect}\n${tail(combined)}`);
  }
  if (testCase.expectJsonish) {
    const trimmed = result.stdout.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
      throw new Error(`[cli-real-model-soak] ${testCase.name} expected JSON-ish stdout\n${tail(combined)}`);
    }
  }
  addCase(testCase.name, result, Date.now() - started);
}

async function runInteractivePtyCase() {
  const python = process.env.PYTHON || "python3";
  const prompt = "只回复 OK";
  const py = String.raw`
import os, pty, select, signal, subprocess, sys, time, re

node_bin, cli_entry, timeout_s, prompt = sys.argv[1], sys.argv[2], float(sys.argv[3]), sys.argv[4]
env = os.environ.copy()
env.update({
  "TERM": "xterm-256color",
  "TERM_PROGRAM": "Apple_Terminal",
  "LYNN_CLI_UPDATE_CHECK": "0",
  "LYNN_LANG": env.get("LYNN_LANG", "zh"),
})
master, slave = pty.openpty()
proc = subprocess.Popen([node_bin, cli_entry], stdin=slave, stdout=slave, stderr=slave, env=env, close_fds=True)
os.close(slave)
buf = b""
stage = 0
deadline = time.time() + timeout_s

def plain():
  text = buf.decode("utf-8", "replace")
  text = re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]", "", text)
  text = re.sub(r"\x1b\][^\x07]*(?:\x07|\x1b\\\\)", "", text)
  return text

try:
  while time.time() < deadline:
    if proc.poll() is not None:
      break
    readable, _, _ = select.select([master], [], [], 0.1)
    if master not in readable:
      continue
    try:
      chunk = os.read(master, 8192)
    except OSError:
      break
    if not chunk:
      continue
    buf += chunk
    text = plain()
    if stage == 0 and "›" in text:
      os.write(master, (prompt + "\r").encode("utf-8"))
      stage = 1
    elif stage == 1 and re.search(r"\bOK\b", text, re.I) and "›" in text:
      os.write(master, b"/version\r")
      stage = 2
    elif stage == 2 and ("Lynn CLI version" in text or "Lynn CLI 版本" in text) and "›" in text:
      os.write(master, b"/exit\r")
      stage = 3
  if proc.poll() is None:
    os.kill(proc.pid, signal.SIGTERM)
    try:
      proc.wait(timeout=2)
    except subprocess.TimeoutExpired:
      os.kill(proc.pid, signal.SIGKILL)
      proc.wait()
  text = plain()
  sys.stdout.write(text)
  if stage < 3:
    raise RuntimeError(f"interactive stage did not complete: stage={stage}")
  if proc.returncode not in (0, None):
    raise RuntimeError(f"Lynn exited {proc.returncode}")
except Exception as exc:
  text = plain()
  print(f"[cli-real-model-soak] interactive PTY failed: {exc}\n--- output tail ---\n" + "\n".join(text.splitlines()[-100:]), file=sys.stderr)
  sys.exit(1)
`;
  const started = Date.now();
  const result = await run(python, ["-c", py, process.execPath, cliEntry, String(timeoutMs / 1000), prompt], {
    env: baseEnv,
    timeoutMs: timeoutMs + 5_000,
  });
  const combined = `${result.stdout}\n${result.stderr}`;
  assertResultOk("interactive-pty-real", result, combined);
  if (!/\bOK\b/i.test(combined) || !/(Lynn CLI version|Lynn CLI 版本)/.test(combined)) {
    throw new Error(`[cli-real-model-soak] interactive-pty-real missing real reply/version\n${tail(combined)}`);
  }
  addCase("interactive-pty-real", result, Date.now() - started);
}

function assertResultOk(name, result, combined) {
  if (result.code !== 0) {
    throw new Error(`[cli-real-model-soak] ${name} exited ${result.code}\n${tail(combined)}`);
  }
  const bad = /(模拟回复|Mock Lynn response|mock Brain|Brain offline|all providers failed|fetch failed|ECONNREFUSED|Cannot find module|TypeError|ReferenceError)/i;
  if (bad.test(combined)) {
    throw new Error(`[cli-real-model-soak] ${name} hit mock/offline/crash output\n${tail(combined)}`);
  }
  if (!combined.trim()) {
    throw new Error(`[cli-real-model-soak] ${name} produced empty output`);
  }
}

function addCase(name, result, ms) {
  report.cases.push({
    name,
    ms,
    stdoutTail: tail(result.stdout, 2_000),
    stderrTail: tail(result.stderr, 2_000),
  });
  console.log(`[cli-real-model-soak] ok ${name} ${ms}ms`);
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
    }, options.timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: signal ? 128 : code ?? 0, signal, stdout, stderr });
    });
  });
}

function numberEnv(name, fallback, min = 1) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) && value >= min ? value : fallback;
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

function tail(value, max = 4_000) {
  const text = String(value || "");
  return text.length > max ? text.slice(-max) : text;
}
