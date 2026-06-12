#!/usr/bin/env node
/**
 * Agent task matrix gate.
 *
 * Locks the class of regressions where a model answers "I cannot access local
 * files" or prints fake tool markup instead of using Lynn's real tool/runtime
 * path. The live GUI lane uses a temporary real directory, so the model must
 * answer from client-provided local evidence rather than guessing.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  ROUTE_INTENTS,
  classifyRouteIntent,
} from "../shared/task-route-intent.ts";
import {
  buildLocalWorkspaceContext,
  shouldAttachLocalWorkspaceContext,
} from "../server/chat/local-workspace-context.ts";
import { shouldUseLocalQwen35DirectBridge } from "../server/chat/local-qwen35-direct-policy.ts";
import { TOOL_USE_BEHAVIOR } from "../server/chat/tool-use-behavior.ts";
import {
  containsPseudoToolSimulation,
  stripPseudoToolCallMarkup,
} from "../shared/pseudo-tool-call.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = new Set(process.argv.slice(2));
const RUN_LIVE_GUI = argv.has("--live-gui") || argv.has("--live-all");
const RUN_LIVE_CLI = argv.has("--live-cli") || argv.has("--live-all");
const TIMEOUT_MS = Number(process.env.LYNN_AGENT_MATRIX_TIMEOUT_MS || "240000");

const failures = [];
let passed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? `: ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function excerpt(value, max = 360) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function runNode(args, { env = {}, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: { ...process.env, NO_COLOR: "1", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-agent-matrix-"));
  await fs.mkdir(path.join(root, "novel"), { recursive: true });
  await fs.mkdir(path.join(root, "notes"), { recursive: true });
  await fs.writeFile(
    path.join(root, "novel", "第一章-钢铁长城.md"),
    [
      "# 第一章 钢铁长城",
      "",
      "北门的烽火在雨里亮起。",
      "暗号：桐门已亮。",
      "主角确认城墙依然稳固，随后把铜钥匙交给巡夜人。",
    ].join("\n"),
    "utf8",
  );
  await fs.writeFile(
    path.join(root, "notes", "jian.md"),
    [
      "# 今日笺",
      "",
      "- [ ] 验证 GUI 本地文件读取",
      "- [ ] 验证 CLI 本地文件读取",
    ].join("\n"),
    "utf8",
  );
  return root;
}

async function runStaticMatrix(fixtureRoot) {
  console.log("[gate-agent-matrix] static route/tool/display checks");

  const localPrompt = `请阅读这个本地目录 ${fixtureRoot} 里的第一章小说文件，只回答里面的暗号四个字。`;
  const codingPrompt = "请修改 src/app.ts 的 bug 并运行测试。";
  const visionPrompt = "看一下这张截图里的按钮是否重叠。";
  const researchPrompt = "继续深入调研 vLLM 和 SGLang 的 NVFP4 并发 serving 路线。";

  check("本地小说/文件请求判为 utility", classifyRouteIntent(localPrompt) === ROUTE_INTENTS.UTILITY);
  check("代码请求判为 coding", classifyRouteIntent(codingPrompt) === ROUTE_INTENTS.CODING);
  check("图片请求判为 vision", classifyRouteIntent(visionPrompt, { imagesCount: 1 }) === ROUTE_INTENTS.VISION);
  check("长调研请求进入非 chat 路由", classifyRouteIntent(researchPrompt) !== ROUTE_INTENTS.CHAT);

  check("本地文件请求会附加真实 workspace context", shouldAttachLocalWorkspaceContext(localPrompt, ROUTE_INTENTS.UTILITY));
  const context = buildLocalWorkspaceContext({
    promptText: localPrompt,
    cwd: ROOT,
    maxEntries: 60,
    maxDocs: 6,
    maxDocChars: 1600,
  });
  check("workspace context 读取临时目录", context.includes(fixtureRoot), excerpt(context));
  check("workspace context 含第一章文件", context.includes("第一章-钢铁长城.md"), excerpt(context));
  check("workspace context 含暗号证据", context.includes("桐门已亮"), excerpt(context));

  check("本地 utility 不走无工具直连桥", !shouldUseLocalQwen35DirectBridge(localPrompt, {
    isLocalModel: true,
    toolBehavior: TOOL_USE_BEHAVIOR.RUN_LLM_AGAIN,
    routeIntent: ROUTE_INTENTS.UTILITY,
  }));
  check("coding 不走无工具直连桥", !shouldUseLocalQwen35DirectBridge(codingPrompt, {
    isLocalModel: true,
    toolBehavior: TOOL_USE_BEHAVIOR.RUN_LLM_AGAIN,
    routeIntent: ROUTE_INTENTS.CODING,
  }));

  const fakeTool = [
    "我来查找文件。",
    "<tool_call>",
    "<function=bash>",
    "<parameter=command>find /Users/lynn/Desktop -name 第一章</parameter>",
    "</function>",
    "</tool_call>",
    "桐门已亮",
  ].join("\n");
  const stripped = stripPseudoToolCallMarkup(fakeTool);
  check("伪工具 XML 会被识别", containsPseudoToolSimulation(fakeTool));
  check("伪工具 XML 会被剥离", !/<tool_call|<function=|find \/Users/u.test(stripped), excerpt(stripped));
  check("伪工具清理保留可见答案", stripped.includes("桐门已亮"), excerpt(stripped));
}

async function runLiveGui(fixtureRoot) {
  console.log("[gate-agent-matrix] live GUI local-file lane");
  const prompt = `请阅读这个本地目录 ${fixtureRoot} 里的第一章小说文件，只回答里面的暗号四个字。`;
  const result = await runNode(["scripts/gate-gui-task.mjs"], {
    env: {
      LYNN_GUI_GATE_PROMPT: prompt,
      LYNN_GUI_GATE_EXPECT: "桐门已亮",
      LYNN_GUI_GATE_TIMEOUT_MS: String(TIMEOUT_MS),
    },
    timeoutMs: TIMEOUT_MS + 30_000,
  });
  check("GUI 本地文件任务 exit=0", result.code === 0, `exit=${result.code} signal=${result.signal} stderr=${excerpt(result.stderr, 800)}`);
  check("GUI 本地文件任务看到暗号", /桐门已亮/.test(`${result.stdout}\n${result.stderr}`), excerpt(result.stdout, 800));
}

async function runLiveCli(fixtureRoot) {
  console.log("[gate-agent-matrix] live CLI local-file lane");
  const prompt = `请阅读这个本地目录 ${fixtureRoot} 里的第一章小说文件，只回答里面的暗号四个字。`;
  const result = await runNode(["cli/bin/lynn.mjs", "-p", prompt, "--fast"], {
    timeoutMs: TIMEOUT_MS,
  });
  const combined = `${result.stdout}\n${result.stderr}`;
  check("CLI 本地文件任务 exit=0", result.code === 0, `exit=${result.code} signal=${result.signal} stderr=${excerpt(result.stderr, 800)}`);
  check("CLI 本地文件任务看到暗号", /桐门已亮/.test(combined), excerpt(combined, 1000));
  check("CLI 本地文件任务未拒绝文件访问", !/(?:无法|不能|没有).{0,24}(?:本地|文件|文件系统|目录).{0,24}(?:访问|权限|读取)/.test(combined), excerpt(combined, 1000));
}

async function main() {
  const fixtureRoot = await createFixture();
  try {
    console.log(`[gate-agent-matrix] fixture=${fixtureRoot}`);
    await runStaticMatrix(fixtureRoot);
    if (RUN_LIVE_GUI) await runLiveGui(fixtureRoot);
    if (RUN_LIVE_CLI) await runLiveCli(fixtureRoot);
  } finally {
    await fs.rm(fixtureRoot, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\n[gate-agent-matrix] ${passed} 项通过,${failures.length} 项失败`);
  if (failures.length) {
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exit(1);
  }
  console.log("[gate-agent-matrix] PASS — Agent task matrix all green");
}

main().catch((error) => {
  console.error(`[gate-agent-matrix] ${error?.stack || error}`);
  process.exit(1);
});
