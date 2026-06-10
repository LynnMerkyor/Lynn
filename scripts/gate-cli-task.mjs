#!/usr/bin/env node
/**
 * gate-cli-task.mjs — CLI 真任务执行门禁(issue #72 第三类故障的回归网)
 *
 * 针对 v0.82 issue #72 用户追评的「经常思考完没有任何文字回馈 / 说完要做什么但没有行动」:
 * 用真实 Brain 路由跑三条用户态 `-p` 任务(每条输入 >10 个汉字),断言每一条都给出
 * **可见答案/可验证产物**(reasoning-only = FAIL)。这不是输入法/PTY 崩溃冒烟,而是
 * 真实任务能否完成的发布底线。
 * 同时回归锁住 v0.83 的 CLI 输出契约:usage 不再逐帧刷屏(人类模式只允许最后一行)。
 *
 * 要求 Brain 在线(默认路由 StepFun 3.7 Flash)。离线 = 门禁失败 —— 不能在路由不可用时放行发布。
 *
 * 用法: node scripts/gate-cli-task.mjs [--brain-url URL] [--timeout-ms 120000]
 */

import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_BIN = path.join(ROOT, "cli", "bin", "lynn.mjs");

const argv = process.argv.slice(2);
function argValue(flag, fallback) {
  const idx = argv.indexOf(flag);
  return idx >= 0 && argv[idx + 1] ? argv[idx + 1] : fallback;
}
const BRAIN_URL = argValue("--brain-url", process.env.LYNN_GATE_BRAIN_URL || "");
const TIMEOUT_MS = Number(argValue("--timeout-ms", "180000"));

function runCli(args, { stdinLines = [], env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      cwd: ROOT,
      env: { ...process.env, NO_COLOR: "1", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* noop */ }
    }, TIMEOUT_MS);
    child.stdout.on("data", (c) => { stdout += String(c); });
    child.stderr.on("data", (c) => { stderr += String(c); });
    for (const line of stdinLines) child.stdin.write(`${line}\n`);
    child.stdin.end();
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function brainArgs() {
  return BRAIN_URL ? ["--brain-url", BRAIN_URL] : [];
}

function usageLineCount(stderr) {
  return (stderr.match(/^usage: /gm) || []).length;
}

function parseJsonl(stdout) {
  return stdout
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

const failures = [];
let passed = 0;

function check(taskName, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${taskName}`);
  } else {
    failures.push(`${taskName}: ${detail}`);
    console.log(`  ✗ ${taskName} — ${detail}`);
  }
}

function excerpt(text, max = 400) {
  const s = String(text || "").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function visibleChineseChars(text) {
  return Array.from(String(text || "")).filter((ch) => /\p{Script=Han}/u.test(ch)).length;
}

function assertRealTaskPrompt(label, prompt) {
  const chars = visibleChineseChars(prompt);
  check(`${label} 输入超过 10 个汉字`, chars > 10, `prompt="${prompt}" 汉字数=${chars}`);
}

async function main() {
  console.log("[gate-cli-task] CLI 真任务执行门禁(live Brain route)");
  console.log(`[gate-cli-task] bin=${path.relative(ROOT, CLI_BIN)} brain=${BRAIN_URL || "(CLI default)"}`);
  console.log("[gate-cli-task] 真实任务组:4 条 >10 字输入,验证默认模型/可见答案/代码产物/空答恢复");

  // ── T0 默认模型叙事(人类模式)──────────────────────────────────────────
  // 锁住 v0.84 口径:普通 GUI/CLI 默认只展示 StepFun 3.7 Flash;本地 manager
  // 是显式实验路径,不能在默认模型回答里伪装成主链路。
  {
    const prompt = "用一句话说明 Lynn CLI v0.84 的默认模型是什么。";
    console.log("\n[T0] 默认模型叙事(必须是 StepFun,不能回退旧链路)");
    assertRealTaskPrompt("T0", prompt);
    const r = await runCli(["-p", prompt, "--fast", ...brainArgs()]);
    const combined = `${r.stdout}\n${r.stderr}`;
    check("T0 exit=0", r.code === 0, `exit=${r.code} stderr=${excerpt(r.stderr)}`);
    check("T0 回答包含 StepFun 3.7 Flash", /StepFun\s*3\.7\s*Flash/i.test(r.stdout), `stdout=${excerpt(r.stdout, 200)}`);
    check("T0 默认回答不含 Spark/DS 链路", !/Spark|DS-V4|DeepSeek/i.test(combined), `combined=${excerpt(combined, 240)}`);
  }

  // ── T1 可见答案 + 输出契约(人类模式)────────────────────────────────────
  // #72 class-3 锁:必须有非空可见正文;usage 只允许最后一行(不允许逐帧刷屏)。
  {
    const prompt = "用一句话解释什么是前缀缓存,并说明它为什么能减少等待。";
    console.log("\n[T1] 简单问答(人类模式,可见答案 + 单行 usage)");
    assertRealTaskPrompt("T1", prompt);
    const r = await runCli(["-p", prompt, ...brainArgs()]);
    check("T1 exit=0", r.code === 0, `exit=${r.code} stderr=${excerpt(r.stderr)}`);
    check("T1 可见答案非空", r.stdout.trim().length >= 8, `stdout=${excerpt(r.stdout, 160)}`);
    check("T1 无 reasoning 泄漏", !/^<think|<\/think>/m.test(r.stdout), "stdout 出现 think 标签");
    const usageLines = usageLineCount(r.stderr);
    check("T1 usage 只打最后一行", usageLines <= 1, `stderr 出现 ${usageLines} 行 usage(逐帧刷屏回归)`);
    check("T1 route 卡片在", /route:/.test(r.stderr), "stderr 缺少 route 行");
  }

  // ── T2 代码生成(真执行力)────────────────────────────────────────────────
  {
    const prompt = "用 Python 的 turtle 标准库写一个最小的弹跳小球程序,只输出一段完整可运行的代码。";
    console.log("\n[T2] 代码任务(turtle 弹跳球,验证执行头真产码)");
    assertRealTaskPrompt("T2", prompt);
    const r = await runCli(["-p", prompt, ...brainArgs()]);
    check("T2 exit=0", r.code === 0, `exit=${r.code} stderr=${excerpt(r.stderr)}`);
    check("T2 产出 turtle 代码", /import\s+turtle/.test(r.stdout), `stdout=${excerpt(r.stdout, 200)}`);
    const usageLines = usageLineCount(r.stderr);
    check("T2 usage 只打最后一行", usageLines <= 1, `stderr 出现 ${usageLines} 行 usage`);
  }

  // ── T3 思考不说话防线(JSON 模式,对抗性)─────────────────────────────────
  // 诱导 reasoning-only;CLI 的 visible-answer retry 必须最终给出可见 assistant 文本。
  {
    const prompt = "请深入思考这个问题但只给出极简结论:42 是不是 2 的幂?";
    console.log("\n[T3] reasoning-only 对抗(必须有可见 assistant 文本)");
    assertRealTaskPrompt("T3", prompt);
    const r = await runCli(["-p", prompt, "--json", ...brainArgs()]);
    const events = parseJsonl(r.stdout);
    const finished = events.filter((e) => e.type === "run.finished").pop();
    const visible = events
      .filter((e) => e.type === "assistant.delta" && typeof e.text === "string")
      .map((e) => e.text)
      .join("");
    check("T3 exit=0", r.code === 0, `exit=${r.code}`);
    check("T3 run.finished ok", !!finished && finished.ok === true, `finished=${JSON.stringify(finished || null)}`);
    check(
      "T3 可见 assistant 文本非空(#72 思考不说话)",
      visible.trim().length > 0,
      `visible="" events=${events.map((e) => e.type).join(",").slice(0, 200)}`,
    );
    check("T3 不允许 empty_visible_answer", !(finished && finished.code === "empty_visible_answer"), "命中 #72 第三类故障");
  }

  // ── T4 /fast 实权(JSON 模式)──────────────────────────────────────────────
  {
    console.log("\n[T4] --fast 低延迟档(low + 8K cap 生效)");
    const r = await runCli(["-p", "1+1 等于几?只回答数字。", "--fast", "--json", ...brainArgs()]);
    const events = parseJsonl(r.stdout);
    const started = events.find((e) => e.type === "run.started");
    const visible = events
      .filter((e) => e.type === "assistant.delta" && typeof e.text === "string")
      .map((e) => e.text)
      .join("");
    check("T4 exit=0", r.code === 0, `exit=${r.code}`);
    check(
      "T4 reasoning=low + maxTokens=8192",
      !!started && started.reasoning && started.reasoning.effort === "low" && started.reasoning.maxTokens === 8192,
      `run.started.reasoning=${JSON.stringify(started?.reasoning || null)}`,
    );
    check("T4 可见答案非空", visible.trim().length > 0, "fast 档无可见答案");
  }

  console.log(`\n[gate-cli-task] ${passed} 项通过,${failures.length} 项失败`);
  if (failures.length) {
    console.log("[gate-cli-task] FAIL:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log("[gate-cli-task] PASS — CLI 真任务执行门禁全绿");
}

main().catch((err) => {
  console.error(`[gate-cli-task] 异常:${err?.stack || err}`);
  process.exit(1);
});
