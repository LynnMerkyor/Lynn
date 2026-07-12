#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { resolveBetterSqliteRuntime } from "./native-node-runtime.mjs";

import { DIALOGUE_PROMPTS } from "./dialogue-scenario-bank.mjs";
import { additionalDialogueQualityReason, claimsFreshToolEvidence, requiresFreshEvidenceForDialogue } from "./dialogue-quality-rules.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PROMPTS = DIALOGUE_PROMPTS;

const BAD_TEXT_NEEDLES = [
  "我已经拿到工具结果",
  "接管总结模型",
  "error.searchFollowupHint",
  "没有形成最终回复",
  "模型这次没有返回可见内容",
  "工具链已执行多轮",
  "工具已经完成执行",
  "模型没有生成最终总结",
  "可见工具证据摘要",
  "已执行 1 个操作",
  "已执行 2 个操作",
  "已执行 3 个操作",
  "已执行 4 个操作",
  "已执行 5 个操作",
  "且模型没有返回总结回复",
  "基于这些工具结果总结一下",
  "可以直接继续追问",
  "providerQuery is not defined",
  "Tool not found",
  "<reflect>",
  "</reflect>",
  "<position>",
  "<cancellation>",
  "<reviews>",
  "<｜｜DSML｜｜",
  "DSML｜｜tool_calls",
  "根据本轮已执行工具返回的证据",
  "根据本轮已执行操作返回的可见结果",
  "这轮操作已有可见结果",
  "先看一下当前代码仓库",
  "让我先看一下当前代码仓库",
  "find /Users/lynn/Downloads/Lynn",
  "工具已经返回内容",
  "工具执行包含",
  "请查看上方工具卡片",
  "抓取出错",
  "抓取失败",
  "HTTP 403",
  "没有提取到足够可靠的事实",
  "能先确认这些数字线索",
  "如果需要更精确的实时结论",
  "【研究资料】",
  "【补充搜索线索】",
  "最新 资料 数据 来源",
  "官方 公告 报告 文档",
  "分析 观点 对比 风险",
  "aborted",
  "request timeout",
  "模型请求超时",
  "模型请求超时，请重试",
  "请缩小问题范围后重试",
  "工具结果中未查到",
  "mimo 搜索",
];

const BAD_ERROR_NEEDLES = [
  ...BAD_TEXT_NEEDLES,
  "Error:",
];

const CURRENT_YEAR = 2026;
const TURN_SETTLE_MS = Math.max(0, Number(process.env.LYNN_GUI_GATE_TURN_SETTLE_MS || 2500));
const EMPTY_TIMEOUT_RETRY_MS = Math.max(0, Number(process.env.LYNN_GUI_GATE_EMPTY_TIMEOUT_RETRY_MS || 1500));
function beijingDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function readArgValue(argv, name) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === name) return argv[i + 1] || "";
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return "";
}

function resolveGateCurrentDate(argv = process.argv.slice(2)) {
  const explicit = readArgValue(argv, "--current-date") || process.env.LYNN_GATE_CURRENT_DATE || "";
  if (explicit) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(explicit)) {
      throw new Error(`Invalid --current-date ${explicit}; expected YYYY-MM-DD`);
    }
    return explicit;
  }
  return beijingDate();
}

const CURRENT_DATE = resolveGateCurrentDate();

function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00+08:00`);
  date.setUTCDate(date.getUTCDate() + days);
  return beijingDate(date);
}

function expectedDatesForRelativeLabel(label) {
  const dates = new Set();
  if (/(今天|今日)/.test(label)) dates.add(CURRENT_DATE);
  if (/(今晚|今夜)/.test(label)) {
    dates.add(CURRENT_DATE);
    dates.add(addDays(CURRENT_DATE, 1));
  }
  if (/(明天|明日)/.test(label)) dates.add(addDays(CURRENT_DATE, 1));
  if (/(昨晚|昨日|昨天)/.test(label)) {
    dates.add(addDays(CURRENT_DATE, -1));
    dates.add(CURRENT_DATE);
  }
  return dates;
}

function normalizeDateParts(year, month, day) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function dateYearForRelativeCheck() {
  return CURRENT_DATE.slice(0, 4);
}

function isDisallowedRelativeDate(label, year, month, day) {
  const allowed = expectedDatesForRelativeLabel(label);
  if (!allowed.size) return false;
  const date = normalizeDateParts(year || dateYearForRelativeCheck(), month, day);
  if (!date.startsWith(`${dateYearForRelativeCheck()}-`)) return false;
  return !allowed.has(date);
}

function gapContainsRelativeLabel(gap) {
  return /(今天|今日|今晚|今夜|明天|明日|昨晚|昨日|昨天)/.test(String(gap || ""));
}

function containsMislabeledRelativeDate(prompt, text) {
  if (!/(今天|今日|今晚|今夜|明天|明日|昨晚|昨日|昨天)/.test(prompt)) return false;
  const labelBeforeDate = /(今天|今日|今晚|今夜|明天|明日|昨晚|昨日|昨天)([^\n。；;，,]{0,32}?)(?:(?:(\d{4})年\s*)?(\d{1,2})月\s*(\d{1,2})日|(\d{4})-(\d{1,2})-(\d{1,2}))/g;
  const dateBeforeLabel = /(?:(?:(\d{4})年\s*)?(\d{1,2})月\s*(\d{1,2})日|(\d{4})-(\d{1,2})-(\d{1,2}))([^\n。；;，,]{0,32}?)(今天|今日|今晚|今夜|明天|明日|昨晚|昨日|昨天)/g;
  let match;
  while ((match = labelBeforeDate.exec(text))) {
    const label = match[1];
    if (gapContainsRelativeLabel(match[2])) continue;
    const year = match[3] || match[6] || dateYearForRelativeCheck();
    const month = match[4] || match[7];
    const day = match[5] || match[8];
    if (isDisallowedRelativeDate(label, year, month, day)) return true;
  }
  while ((match = dateBeforeLabel.exec(text))) {
    const year = match[1] || match[4] || dateYearForRelativeCheck();
    const month = match[2] || match[5];
    const day = match[3] || match[6];
    if (gapContainsRelativeLabel(match[7])) continue;
    const label = match[8];
    if (isDisallowedRelativeDate(label, year, month, day)) return true;
  }
  return false;
}

function parseArgs(argv) {
  const args = {
    lynnHome: process.env.LYNN_HOME || path.join(os.homedir(), ".lynn"),
    serverInfo: process.env.LYNN_GUI_50_SERVER_INFO || "",
    baseUrl: process.env.LYNN_GUI_50_BASE_URL || "",
    wsUrl: process.env.LYNN_GUI_50_WS_URL || "",
    token: process.env.LYNN_GUI_50_TOKEN || "",
    timeoutMs: Number(process.env.LYNN_GUI_50_TIMEOUT_MS || "120000"),
    output: "",
    limit: PROMPTS.length,
    only: "",
    spawnServer: process.env.LYNN_GUI_50_USE_EXISTING_SERVER !== "1",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--lynn-home") args.lynnHome = next();
    else if (arg.startsWith("--lynn-home=")) args.lynnHome = arg.slice("--lynn-home=".length);
    else if (arg === "--server-info") args.serverInfo = next();
    else if (arg.startsWith("--server-info=")) args.serverInfo = arg.slice("--server-info=".length);
    else if (arg === "--base-url") args.baseUrl = next();
    else if (arg.startsWith("--base-url=")) args.baseUrl = arg.slice("--base-url=".length);
    else if (arg === "--ws-url") args.wsUrl = next();
    else if (arg.startsWith("--ws-url=")) args.wsUrl = arg.slice("--ws-url=".length);
    else if (arg === "--token") args.token = next();
    else if (arg.startsWith("--token=")) args.token = arg.slice("--token=".length);
    else if (arg === "--timeout-ms") args.timeoutMs = Number(next());
    else if (arg.startsWith("--timeout-ms=")) args.timeoutMs = Number(arg.slice("--timeout-ms=".length));
    else if (arg === "--output") args.output = next();
    else if (arg.startsWith("--output=")) args.output = arg.slice("--output=".length);
    else if (arg === "--limit") args.limit = Number(next());
    else if (arg.startsWith("--limit=")) args.limit = Number(arg.slice("--limit=".length));
    else if (arg === "--only") args.only = next();
    else if (arg.startsWith("--only=")) args.only = arg.slice("--only=".length);
    else if (arg === "--spawn-server") args.spawnServer = true;
    else if (arg === "--use-existing-server" || arg === "--no-spawn-server") args.spawnServer = false;
    else if (arg === "--current-date") next();
    else if (arg.startsWith("--current-date=")) {
      // Parsed before parseArgs via resolveGateCurrentDate().
    }
    else if (arg === "--help" || arg === "-h") {
      console.log(`Usage:
  node scripts/gate-gui-50-dialogues.mjs

Options:
  --server-info PATH    default: ~/.lynn/server-info.json
  --base-url URL        override HTTP base URL
  --ws-url URL          override WebSocket URL
  --token TOKEN         override auth token
  --timeout-ms N        per-dialogue timeout, default 120000
  --limit N             run first N prompts for quick checks
  --only LIST           run prompt indexes, e.g. 14,15 or 11-15
  --output PATH         write JSON report to this path
  --use-existing-server read ~/.lynn/server-info.json instead of spawning an isolated test server`);
      process.exit(0);
    }
  }
  return args;
}

function parseOnlyIndexes(raw, total) {
  const text = String(raw || "").trim();
  if (!text) return null;
  const selected = new Set();
  for (const part of text.split(",")) {
    const piece = part.trim();
    if (!piece) continue;
    const range = piece.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      const lo = Math.min(start, end);
      const hi = Math.max(start, end);
      for (let idx = lo; idx <= hi; idx += 1) {
        if (idx >= 1 && idx <= total) selected.add(idx);
      }
      continue;
    }
    const idx = Number(piece);
    if (Number.isInteger(idx) && idx >= 1 && idx <= total) selected.add(idx);
  }
  if (!selected.size) throw new Error(`--only did not select any prompt: ${raw}`);
  return selected;
}

function selectedPromptItems(args) {
  const only = parseOnlyIndexes(args.only, PROMPTS.length);
  const all = PROMPTS.map(([category, prompt], index) => ({ index: index + 1, category, prompt }));
  if (only) return all.filter((item) => only.has(item.index));
  const limit = Math.max(1, Math.min(PROMPTS.length, Number(args.limit) || PROMPTS.length));
  return all.slice(0, limit);
}

function expandHome(input) {
  if (!input) return input;
  return input.startsWith("~") ? path.join(os.homedir(), input.slice(1)) : input;
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function shouldSpawnManagedServer(args) {
  if (!args.spawnServer) return false;
  if (args.baseUrl || args.wsUrl || args.token || args.serverInfo) return false;
  return true;
}

async function readJsonFile(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function startManagedServer() {
  const lynnHome = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-gui-gate-"));
  const infoPath = path.join(lynnHome, "server-info.json");
  const logs = [];
  const runtime = resolveBetterSqliteRuntime({ cwd: ROOT, env: process.env });
  const child = spawn(runtime.bin, [...runtime.argsPrefix, "--import", "tsx", "server/index.ts"], {
    cwd: ROOT,
    env: {
      ...runtime.env,
      LYNN_HOME: lynnHome,
      HANA_PORT: "0",
      STEP_TEXT_MODEL: process.env.STEP_TEXT_MODEL || "step-3.7-flash",
      LYNN_IMPORT_HANAKO_ON_FIRST_RUN: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  logs.push(`[gui-50] managed server runtime=${runtime.kind}`);
  const remember = (chunk) => {
    for (const line of String(chunk || "").split(/\r?\n/)) {
      if (!line.trim()) continue;
      logs.push(line);
      if (logs.length > 80) logs.shift();
    }
  };
  child.stdout?.on("data", remember);
  child.stderr?.on("data", remember);

  const startedAt = Date.now();
  while (Date.now() - startedAt < 60_000) {
    if (child.exitCode != null) {
      throw new Error(`[gui-50] managed server exited early (${child.exitCode})\n${logs.join("\n")}`);
    }
    if (await fileExists(infoPath)) {
      const info = await readJsonFile(infoPath);
      if (Number.isFinite(Number(info.port)) && info.token) {
        const baseUrl = `http://127.0.0.1:${Number(info.port)}`;
        const wsUrl = `ws://127.0.0.1:${Number(info.port)}/ws`;
        for (let attempt = 0; attempt < 60; attempt += 1) {
          try {
            await httpJson(baseUrl, info.token, "/api/health", { timeoutMs: 2000 });
            return {
              lynnHome,
              infoPath,
              child,
              logs,
              config: { baseUrl, wsUrl, token: info.token },
              async close() {
                try {
                  await httpJson(baseUrl, info.token, "/api/shutdown", { method: "POST", timeoutMs: 2000 });
                } catch {
                  // Fall through to process kill below.
                }
                await sleep(500);
                if (child.exitCode == null) child.kill("SIGTERM");
                await fs.rm(lynnHome, { recursive: true, force: true });
              },
            };
          } catch {
            await sleep(500);
          }
        }
      }
    }
    await sleep(250);
  }
  child.kill("SIGTERM");
  await fs.rm(lynnHome, { recursive: true, force: true });
  throw new Error(`[gui-50] managed server did not become ready\n${logs.join("\n")}`);
}

async function readServerConfig(args) {
  if (args.baseUrl && args.wsUrl && args.token) {
    return { baseUrl: args.baseUrl, wsUrl: args.wsUrl, token: args.token };
  }
  const infoPath = expandHome(args.serverInfo || path.join(args.lynnHome, "server-info.json"));
  const raw = await fs.readFile(infoPath, "utf8");
  const info = JSON.parse(raw);
  const port = Number(info.port);
  if (!Number.isFinite(port) || !info.token) {
    throw new Error(`[gui-50] invalid server-info at ${infoPath}`);
  }
  return {
    baseUrl: args.baseUrl || `http://127.0.0.1:${port}`,
    wsUrl: args.wsUrl || `ws://127.0.0.1:${port}/ws`,
    token: args.token || info.token,
  };
}

function assertLocalTestEndpoint(config) {
  const urls = [config.baseUrl, config.wsUrl].filter(Boolean);
  for (const raw of urls) {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();
    const isLocal = host === "127.0.0.1" || host === "localhost" || host === "::1";
    if (!isLocal) {
      throw new Error(`[gui-50] refused non-local endpoint ${raw}; GUI gate must not depend on browser login state or external accounts`);
    }
  }
}

async function httpJson(baseUrl, token, pathname, { method = "GET", body, timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}${pathname}`, {
      method,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    if (!res.ok) throw new Error(`[gui-50] ${method} ${pathname} -> ${res.status}: ${text}`);
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

function openWs(wsUrl, token) {
  return new Promise((resolve, reject) => {
    const protocols = token ? ["hana-v1", `token.${token}`] : ["hana-v1"];
    const ws = new WebSocket(wsUrl, protocols);
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch {}
      reject(new Error(`[gui-50] WebSocket timeout: ${wsUrl}`));
    }, 10000);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function classify(result) {
  const text = result.text.trim();
  const joinedErrors = result.errors.join("\n");
  const bad = BAD_TEXT_NEEDLES.find((needle) => text.includes(needle))
    || BAD_ERROR_NEEDLES.find((needle) => joinedErrors.includes(needle));
  if (result.timedOut) return { status: "timeout", reason: "turn timeout" };
  if (result.errors.length) return { status: "error", reason: joinedErrors.slice(0, 240) };
  if (!text) return { status: "empty", reason: "no assistant text" };
  if (bad) return { status: "fallback_or_error_text", reason: bad };
  const qualityIssue = qualityReason(result.prompt, text, result);
  if (qualityIssue) return { status: "quality_fail", reason: qualityIssue };
  return { status: "ok", reason: "" };
}

function isEmptyTransportTimeout(result) {
  return Boolean(result?.timedOut)
    && !String(result?.text || "").trim()
    && (!Array.isArray(result?.tools) || result.tools.length === 0)
    && (!Array.isArray(result?.errors) || result.errors.length === 0);
}

function hasToolEvidence(result) {
  return Array.isArray(result.tools) && result.tools.length > 0;
}

function buildReactReview(result) {
  const requiresFreshEvidence = requiresFreshEvidenceForDialogue({
    category: result.category,
    prompt: result.prompt,
  });
  const tools = Array.isArray(result.tools) ? result.tools : [];
  const toolEvents = Array.isArray(result.toolEvents) ? result.toolEvents : [];
  const providerTrail = Array.isArray(result.providerTrail) ? result.providerTrail : [];
  const status = result.status || "unknown";
  let nextAction = "none";
  if (status === "timeout") {
    nextAction = "inspect websocket/server/provider latency and tool long-tail; do not mask as acceptable";
  } else if (status === "empty") {
    nextAction = "fix GUI stream/finalizer path so the user sees a final answer";
  } else if (status === "fallback_or_error_text") {
    nextAction = "remove leaked fallback/error text at source and synthesize a human answer";
  } else if (status === "quality_fail") {
    nextAction = "repair route/tool/evidence behavior for this prompt; do not add broad keyword exceptions";
  } else if (status === "error") {
    nextAction = "inspect websocket/server errors and fix the runtime path";
  }
  return {
    task: {
      category: result.category,
      prompt: result.prompt,
      requiresFreshEvidence,
    },
    execute: {
      providerTrail,
      toolNames: tools.map((tool) => tool.name).filter(Boolean),
      toolEvents,
      hadTools: tools.length > 0,
    },
    observe: {
      status,
      reason: result.reason || "",
      textChars: String(result.text || "").trim().length,
      thinkingChars: result.thinkingChars || 0,
      errorCount: Array.isArray(result.errors) ? result.errors.length : 0,
      timedOut: Boolean(result.timedOut),
      elapsedMs: result.elapsedMs || 0,
    },
    review: {
      userExperience: status === "ok" ? "answer-visible-and-contract-held" : "needs-react-fix",
      nextAction,
    },
  };
}

function deniesAvailableToolCapability(text) {
  const normalized = String(text || "").replace(/\s+/g, "");
  return /(?:工具集|工具箱|工具列表|当前工具|可用工具|CLI工具|LynnCLI工具).{0,24}(?:没有|未包含|不包含|缺少|暂无|不支持).{0,24}(?:天气|搜索|查询|检索|行情|股价|金价|汇率|比分|赛程|网页|访问)/iu.test(normalized)
    || /(?:没有|未包含|不包含|缺少|暂无|不支持).{0,24}(?:天气|搜索|查询|检索|行情|股价|金价|汇率|比分|赛程|网页|访问).{0,24}(?:工具|功能|能力|接口)/iu.test(normalized)
    || /(?:无法|不能|没法|不支持).{0,24}(?:实时|在线|联网|访问网页|查询天气|查询股价|查询汇率|查询比分|查询赛程)/iu.test(normalized);
}

function isMetaToolOrSearchQuestion(prompt) {
  const p = String(prompt || "");
  return /(为什么|如何|怎么|原因|解释|原则|流程|设计|检查清单|门禁|复核|冲突|矩阵|回归|测试|信息架构|草案|工作台)/.test(p)
    && /(工具|搜索|检索|复核|模型|空答|门禁|流程|结论|结果|内核|矩阵|CLI|GUI|工作台|信息架构)/.test(p);
}

function dateSerial(year, month, day) {
  return Number(`${year}${String(month).padStart(2, "0")}${String(day).padStart(2, "0")}`);
}

function currentDateSerial() {
  return Number(CURRENT_DATE.replaceAll("-", ""));
}

function extractExplicitDateSerials(text) {
  const normalized = String(text || "");
  const out = [];
  const [currentYear] = CURRENT_DATE.split("-").map(Number);
  for (const match of normalized.matchAll(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/g)) {
    out.push(dateSerial(Number(match[1]), Number(match[2]), Number(match[3])));
  }
  for (const match of normalized.matchAll(/(\d{4})-(\d{1,2})-(\d{1,2})/g)) {
    out.push(dateSerial(Number(match[1]), Number(match[2]), Number(match[3])));
  }
  for (const match of normalized.matchAll(/(?<!\d)(\d{1,2})月\s*(\d{1,2})日/g)) {
    out.push(dateSerial(currentYear, Number(match[1]), Number(match[2])));
  }
  return out;
}

function containsPastDateFutureStartContradiction(text) {
  const normalized = String(text || "").replace(/\s+/g, "");
  const dates = extractExplicitDateSerials(normalized);
  if (!dates.some((date) => date <= currentDateSerial())) return false;
  const futureStart = /要到\d{4}年\d{1,2}月\d{1,2}日(?:[~～—–-]\d{1,2}月?\d{0,2}日?)?(?:才)?(?:正式)?(?:开赛|开始|开幕|开打|举行)|要到\d{1,2}月\d{1,2}日(?:[~～—–-]\d{1,2}月?\d{0,2}日?)?(?:才)?(?:正式)?(?:开赛|开始|开幕|开打|举行)|尚未开打|未开打|还没开赛|还未开赛|才开赛|才开始|才正式开打|正赛.*(?:还没|尚未|没有).*开打/.test(normalized);
  const noResult = /(?:没有|暂无|还没有|尚无|未有|并没有).{0,28}(?:正式比赛|正赛|比分|赛果|结果|赛事比分|数据|记录|信息)|(?:正式比赛|正赛|比分|赛果|结果|赛事比分|数据|记录|信息).{0,28}(?:没有|暂无|还没有|尚无|未有|并没有)|(?:尚未|未|还没|还未).{0,20}(?:开赛|开始|开幕|开打|举行|产生|公布)|目前并没有正在进行的世界杯/.test(normalized);
  return futureStart || noResult;
}

function isStaleWorldCupAnswer(prompt, text) {
  const hasConcreteUpcomingSchedule = /(?:\d+)\s*场/.test(text)
    && /(?:vs|对阵|西班牙|沙特|比利时|伊朗|乌拉圭|佛得角|新西兰|埃及|Spain|Saudi|Belgium|Iran|Uruguay|Cape Verde|New Zealand|Egypt)/i.test(text)
    && /(?:未开始|Scheduled|北京时间|\b0?[0369]:00\b|00:00|03:00|06:00|09:00)/i.test(text);
  if (/(今晚|今夜|赛程|有几场)/.test(prompt) && hasConcreteUpcomingSchedule) return false;
  if (containsPastDateFutureStartContradiction(text)) return true;
  if (/目前并没有正在进行的世界杯|还没有(?:任何)?正赛比分|没有(?:任何)?正赛比分|正赛.*(?:还没|尚未|没有).*开打|要到\s*2026年\s*6月\s*11日.*才开打|要到\s*2026年\s*6月(?:\d{1,2}日)?.{0,24}(?:才)?(?:开赛|开始).{0,48}(?:没有|暂无|还没有).{0,24}(?:正式比赛|正赛|比分|赛果)|尚未开打|未开打/.test(text)) {
    return true;
  }
  if (!/2022年卡塔尔世界杯/.test(text)) return false;
  const asksCurrentWorldCup = /2026|今年|本届|今晚|今夜|今天|今日|昨晚|昨天|赛程|比分|赛果|结果|几场|半决赛|世界杯/.test(prompt);
  const givesCurrentWorldCupAnswer = /2026|美加墨|本届|今年|北京时间|赛程|比分|小组赛|半决赛/.test(text);
  return asksCurrentWorldCup && !givesCurrentWorldCupAnswer;
}

function hasWrongWorldCupSemifinalDate(text) {
  const normalized = String(text || "").replace(/\s+/g, "");
  return /7月(?:10|11|12)日?|(?:2026[-/])?0?7[-/]?(?:10|11|12)\b|July(?:10|11|12)\b/i.test(normalized);
}

function hasSupportedWorldCupSemifinalDate(text) {
  const normalized = String(text || "").replace(/\s+/g, "");
  return /7月(?:14|15|16)日?|(?:2026[-/])?0?7[-/]?(?:14|15|16)\b|July(?:14|15)\b/i.test(normalized);
}

function hasGoldPrice(text) {
  return /\d{3,5}(?:\.\d+)?\s*元\/克|\d{3,5}(?:\.\d+)?\s*美元\/盎司|XAU\/USD[\s\S]{0,100}\d{3,5}(?:\.\d+)?/iu.test(String(text || ""));
}

function hasUsdCnyRate(text) {
  const raw = String(text || "");
  return /1\s*(?:USD|美元)\s*(?:=|≈|约|可兑换|兑换|兑)?\s*\d+(?:\.\d+)?\s*(?:CNY|人民币)|USD\/CNY[\s\S]{0,100}\d+(?:\.\d+)?|美元[兑对]人民币[\s\S]{0,100}\d+(?:\.\d+)?|1\s*(?:USD|美元)[\s\S]{0,16}\d+(?:\.\d+)?\s*(?:CNY|人民币)/iu.test(raw);
}

function hasJpyCnyRate(text) {
  const raw = String(text || "");
  const oneJpy = /1\s*(?:JPY|日元)[\s\S]{0,24}0\.0\d+\s*(?:CNY|人民币)?/iu;
  const hundredJpy = /100\s*(?:JPY|日元)[\s\S]{0,28}[3-9](?:\.\d+)?\s*(?:CNY|人民币)?/iu;
  const contextual = /日元[兑对]人民币[\s\S]{0,140}(?:1\s*日元[\s\S]{0,24}0\.0\d+|100\s*日元[\s\S]{0,28}[3-9](?:\.\d+)?)/iu;
  const wrongHundredUnit = /100\s*(?:JPY|日元)\s*(?:=|≈|约|可兑换|兑换|兑|约合)?\s*0\.0\d+\s*(?:CNY|人民币)?/iu;
  return (oneJpy.test(raw) || hundredJpy.test(raw) || contextual.test(raw)) && !wrongHundredUnit.test(raw);
}

function hasIndexPointOrHonestMiss(text) {
  const raw = String(text || "");
  const pointNumber = String.raw`(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d{4,6}(?:\.\d+)?)`;
  return new RegExp(String.raw`(纳斯达克指数|纳指|Nasdaq|NASDAQ)[\s\S]{0,120}${pointNumber}\s*点?`, "iu").test(raw)
    || /(没有拿到|未拿到|未检索到|没有检索到|无法确认)[\s\S]{0,80}(纳斯达克指数|纳指|点位)/iu.test(raw);
}

function hasValidZodSchemaAnswer(text) {
  const raw = String(text || "");
  const hasZObject = /\bz\.object\s*\(/.test(raw);
  const hasImport = /from\s+(['"])zod\1/.test(raw) || /require\s*\(\s*(['"])zod\1\s*\)/.test(raw);
  return hasZObject && hasImport;
}

function hasCryptoPrice(text) {
  const raw = String(text || "");
  const price = String.raw`(?:\$\s*)?(?:\d{1,3}(?:,\d{3})+|\d{4,})(?:\.\d+)?\s*(?:美元|USD|USDT|CNY|人民币|元)?`;
  return new RegExp(
    String.raw`(?:比特币|Bitcoin|BTC)[\s\S]{0,160}${price}|${price}\s*(?:美元|USD|USDT)?[\s\S]{0,80}(?:比特币|Bitcoin|BTC)`,
    "iu",
  ).test(raw);
}

function isWorldCupPredictionPrompt(prompt) {
  return /世界杯/.test(String(prompt || "")) && /预测|预估|猜|可能比分|比分预测/.test(String(prompt || ""));
}

function hasWorldCupPredictionAnswer(text) {
  const raw = String(text || "");
  const hasPredictionCue = /预测|猜测|不是事实|不代表实际|仅供参考|娱乐|不构成投注/i.test(raw);
  const hasScore = /\b\d{1,2}\s*[-–—:：比]\s*\d{1,2}\b|预测比分\s*\d{1,2}\s*[-–—:：比]\s*\d{1,2}/.test(raw);
  const honestNoFixtureBoundary = /(?:未返回|未拿到|没有拿到|无法确认).{0,60}(?:对阵|赛程)/.test(raw)
    && (/(?:不能|无法|不应|不要).{0,40}(?:编|预测|给出).{0,20}(?:比分|具体比分)/.test(raw)
      || /(?:编|预测|给出).{0,20}(?:比分|具体比分).{0,20}(?:没有依据|无依据|不可靠)/.test(raw));
  return hasPredictionCue && (hasScore || honestNoFixtureBoundary);
}

function hasPreviousYearLeakForRelativePrompt(prompt, text) {
  if (!/(今天|今日|今晚|今夜|明天|明日|昨晚|昨日|昨天)/.test(String(prompt || ""))) return false;
  const previousYear = CURRENT_YEAR - 1;
  const raw = String(text || "");
  if (new RegExp(`${previousYear}\\s*[-~—–]\\s*${CURRENT_YEAR}`).test(raw)) return false;
  return new RegExp(`${previousYear}年\\s*\\d{1,2}月\\s*\\d{1,2}日`).test(raw)
    || new RegExp(`${previousYear}-\\d{1,2}-\\d{1,2}`).test(raw);
}

function hasSyntheticOfficialModelLeak(prompt, text) {
  const p = String(prompt || "");
  const raw = String(text || "").replace(/[\u2010-\u2015\u2212]/g, "-");
  if (/(?:OpenAI|ChatGPT|GPT).{0,24}(?:最新|最近|新模型|官方|发布|model|release)/i.test(p)) {
    const hasOpenAIOfficialSource = /(?:https?:\/\/)?(?:platform\.openai\.com|openai\.com|help\.openai\.com)|Model Release Notes|OpenAI API models docs|官方页面正文抓取/i.test(raw);
    return /\bGPT\s*-?\s*5\.(?:3|4)\b/i.test(raw)
      || (/\bGPT\s*-?\s*5\.5\b/i.test(raw) && !hasOpenAIOfficialSource);
  }
  if (/(?:Claude|Anthropic).{0,24}(?:最新|最近|公开|模型|官方|发布|model|release)/i.test(p)) {
    return /Claude\s+Fable\s+5|Fable\s+5|Mythos\s+5|神话级|Mythos\s*级/i.test(raw);
  }
  return false;
}

function isDgxSparkPrompt(prompt) {
  return /DGX\s*Spark/i.test(String(prompt || ""));
}

function hasDgxSparkOfficialSignal(text) {
  const raw = String(text || "");
  return /DGX\s*Spark/i.test(raw)
    && (
      /docs\.nvidia\.com|marketplace\.nvidia\.com|nvidia\.com/i.test(raw)
      || /DGX\s*OS\s*\d|580\.159\.03|CUDA\s*Toolkit\s*13|June\s+2026|2026\s*年\s*6\s*月/i.test(raw)
    );
}

function hasDgxSparkPseudoEvidence(text) {
  return /(丽台|信弘|ZENTEK|广州力铭|万集光电|电子发烧友|装机|历史沿革|培训|Omniverse Enterprise|GPU资源分配)/i.test(String(text || ""));
}

function hasInternalToolLabelVisible(text) {
  const raw = String(text || "");
  return /数据来源\/判断依据/.test(raw)
    || /(?:^|\n)\s*-\s*工具：\s*(?:research_prefetch|stock_market|weather|sports_score|live_news|web_search|web_fetch|browser)\b/i.test(raw)
    || /工具：(?:research_prefetch|stock_market|weather|sports_score|live_news|web_search|web_fetch)/.test(raw);
}

function hasSportsContextCrosswire(prompt, text) {
  if (!/世界杯|World\s*Cup|FIFA/i.test(String(prompt || ""))) return false;
  return /总决赛已打场次|NBA\s*总决赛|马刺|尼克斯/i.test(String(text || ""));
}

function toolNamesOf(result = {}) {
  return Array.isArray(result.tools)
    ? result.tools.map((tool) => String(tool?.name || tool || "")).filter(Boolean)
    : [];
}

function allowsFileCreation(prompt) {
  return /(?:保存|写入|创建|生成|导出).{0,16}(?:文件|文档|md|markdown|docx|pdf|xlsx|表格|到书桌|到桌面)|(?:形成|输出).{0,16}(?:文件|文档|docx|pdf|xlsx)/iu.test(String(prompt || ""));
}

function usedUnrequestedFileCreation(prompt, result = {}) {
  if (allowsFileCreation(prompt)) return false;
  return toolNamesOf(result).some((name) => /^(?:write|present_files|edit|edit-diff|create_report|create_docx|create_xlsx)$/i.test(name));
}

function qualityReason(prompt, text, result = {}) {
  if (/针对“[^”]+”，我能从工具证据中确认/.test(String(text || ""))) {
    return "tool-evidence-template-leaked";
  }
  if (hasInternalToolLabelVisible(text)) {
    return "internal-tool-label-visible";
  }
  if (usedUnrequestedFileCreation(prompt, result)) {
    return "unrequested-file-creation-tool-used";
  }
  const sharedQualityIssue = additionalDialogueQualityReason({
    category: result.category,
    prompt,
    text,
    hasToolEvidence: hasToolEvidence(result),
  });
  if (sharedQualityIssue) return sharedQualityIssue;
  if (hasSportsContextCrosswire(prompt, text)) {
    return "sports-answer-crosswired-competition-context";
  }
  if (/file\s+HANDOFF-\d{4}-\d{2}-\d{2}/.test(String(text || ""))) {
    return "conceptual-question-used-local-file-list";
  }
  if (/CUDA\s*Toolkit\s*13/i.test(prompt) && !/CUDA\s*Toolkit\s*13\.3|13\.3/i.test(text)) {
    return "cuda-toolkit-13-question-without-version";
  }
  if (/Python\s*3\.13/i.test(prompt) && !/3\.13\.14|Python\s*3\.13\.14/i.test(text)) {
    return "python-313-question-without-maintenance-version";
  }
  if (/Kimi\s*K2\.7\s*Code/i.test(prompt) && !/(没有|未|暂无|不能确认|未确认).{0,40}(Kimi\s*K2\.7\s*Code|K2\.7)/i.test(text)) {
    return "kimi-k27-question-claimed-release-without-proof";
  }
  if (/GLM\s*5\.0\s*Turbo/i.test(prompt) && !/(没有|未|暂无|不能确认|未确认).{0,60}(GLM\s*5\.0\s*Turbo|当前可用性|可用)/i.test(text)) {
    return "glm-50-turbo-question-claimed-availability-without-proof";
  }
  if (/Anthropic\s+docs?.{0,24}Claude\s+Code|Claude\s+Code.{0,24}Anthropic\s+docs?/i.test(prompt)
    && (!/Claude\s+Code/i.test(text) || /未查到|未提到|没有(?:明确)?提到|没有找到|未找到/i.test(text))) {
    return "anthropic-claude-code-docs-answer-missed-official-page";
  }
  if (/Microsoft\s+Windows\s+on\s+Arm|Windows\s+on\s+Arm/i.test(prompt)
    && !/(developer\.microsoft\.com\/windows\/arm|Windows\s+on\s+Arm\s+开发者页面|Arm\s+设备上构建、测试和优化\s+Windows\s+应用)/i.test(text)) {
    return "windows-on-arm-answer-without-official-developer-page";
  }
  if (/Responses\s*API/i.test(prompt) && /根据本轮已执行工具返回|网页抓取|抓取出错|Skip to content/i.test(text)) {
    return "responses-api-answer-leaked-fetch-noise";
  }
  if (containsMislabeledRelativeDate(prompt, text)) {
    return "relative-date-answer-used-wrong-explicit-date";
  }
  if (hasPreviousYearLeakForRelativePrompt(prompt, text)) {
    return "relative-date-answer-used-previous-year";
  }
  if (hasSyntheticOfficialModelLeak(prompt, text)) {
    return "official-model-question-used-synthetic-model-name";
  }
  if (isDgxSparkPrompt(prompt)) {
    if (!hasDgxSparkOfficialSignal(text)) return "dgx-spark-question-without-official-product-evidence";
    if (hasDgxSparkPseudoEvidence(text)) return "dgx-spark-answer-used-pseudo-related-search-result";
  }
  if (/(?:深圳|北京|天气|暴雨|空气质量|今天|明天|昨晚|今晚)/.test(prompt)) {
    if (new RegExp(`${CURRENT_YEAR - 1}年`).test(text) && !new RegExp(`${CURRENT_YEAR - 1}\\s*[-~—–]\\s*${CURRENT_YEAR}`).test(text)) {
      return "relative-date-answer-used-previous-year";
    }
    if (/(人类活动史|建城史|生态环境局|工业和信息化局|机动车排放|高新技术企业|政府工作报告|百度百科)/.test(text)) {
      return "weather-answer-used-unrelated-search-result";
    }
  }
  if (/(金价|黄金|XAU|gold)/i.test(prompt) && !hasGoldPrice(text)) {
    return "gold-question-without-price";
  }
  if (/(汇率|美元人民币|美元兑人民币|USD\s*\/?\s*CNY)/i.test(prompt) && !hasUsdCnyRate(text)) {
    return "fx-question-without-rate";
  }
  if (/(日元|JPY).{0,12}(人民币|CNY)|(人民币|CNY).{0,12}(日元|JPY)/i.test(prompt) && !hasJpyCnyRate(text)) {
    return "jpy-cny-question-without-correct-unit";
  }
  if (/(纳斯达克指数|纳指).{0,12}(点位|多少|最新)/i.test(prompt)) {
    if (/AAPL|苹果公司|Apple\b/i.test(text)) return "index-question-leaked-default-stock-quote";
    if (!hasIndexPointOrHonestMiss(text)) return "index-question-without-index-point";
  }
  if (/(比特币|Bitcoin|BTC).{0,16}(价格|多少|现在|大概|最新)/i.test(prompt) && !hasCryptoPrice(text)) {
    return "crypto-question-without-price";
  }
  if (/zod\s+schema|schema\s+校验|校验\s+release\s+manifest/i.test(prompt) && !hasValidZodSchemaAnswer(text)) {
    return "zod-schema-answer-has-invalid-or-missing-import";
  }
  if (!isMetaToolOrSearchQuestion(prompt) && claimsFreshToolEvidence(text) && !hasToolEvidence(result)) {
    return "claims-fresh-tool-evidence-without-tool-event";
  }
  if (hasToolEvidence(result) && deniesAvailableToolCapability(text)) {
    return "denies-available-tool-after-tool-event";
  }
  if (/世界杯/.test(prompt)) {
    if (isWorldCupPredictionPrompt(prompt)) {
      if (!hasWorldCupPredictionAnswer(text)) return "world-cup-prediction-without-score-or-disclaimer";
      return "";
    }
    if (isStaleWorldCupAnswer(prompt, text)) {
      return "world-cup-stale-or-not-started-answer";
    }
    const scorePattern = /\d+\s*[\u00a0\u202f ]*(?:[-–—:：比])[\u00a0\u202f ]*\d+/;
    if (/已经出的赛事比分|最新的比赛结果|上一场比分/.test(prompt) && !scorePattern.test(text)) {
      return "world-cup-score-question-without-score";
    }
    if (/今晚|今天|赛程|有几场/.test(prompt) && !/(?:\d+)\s*场|北京时间|赛程/.test(text)) {
      return "world-cup-schedule-question-without-schedule";
    }
    if (/半决赛/.test(prompt) && hasWrongWorldCupSemifinalDate(text)) {
      return "world-cup-semifinal-wrong-date";
    }
    if (/半决赛/.test(prompt) && !hasSupportedWorldCupSemifinalDate(text) && !/semi/i.test(text)) {
      return "world-cup-semifinal-question-without-date";
    }
  }
  return "";
}

function createActive(index, category, prompt) {
  return {
    index,
    category,
    prompt,
    startedAt: Date.now(),
    elapsedMs: 0,
    text: "",
    textChars: 0,
    thinkingChars: 0,
    providerTrail: [],
    tools: [],
    toolEvents: [],
    errors: [],
    events: 0,
    timedOut: false,
    finishedNormally: false,
    rawTail: "",
  };
}

function consumeMessage(active, msg) {
  active.events += 1;
  active.rawTail = `${active.rawTail}\n${JSON.stringify(msg).slice(0, 1000)}`.slice(-4000);
  if (msg.type === "text_delta") {
    active.text += msg.delta || "";
    active.textChars += String(msg.delta || "").length;
  } else if (msg.type === "thinking_delta") {
    active.thinkingChars += String(msg.delta || "").length;
  } else if (msg.type === "provider" && msg.activeProvider) {
    active.providerTrail.push(String(msg.activeProvider));
  } else if (msg.type === "provider_meta") {
    const activeProvider = msg.activeProvider || msg.meta?.activeProvider || msg.provider || msg.meta?.provider;
    if (activeProvider) active.providerTrail.push(String(activeProvider));
  } else if (msg.type === "tool_start" || msg.type === "tool_execution_start") {
    active.tools.push({
      id: msg.toolCallId || msg.id || "",
      name: msg.name || msg.toolName || "tool",
      success: null,
    });
    active.toolEvents.push({ event: "start", name: msg.name || msg.toolName || "tool" });
  } else if (msg.type === "tool_end" || msg.type === "tool_execution_end") {
    const id = msg.toolCallId || msg.id || "";
    const name = msg.name || msg.toolName || "";
    const found = active.tools.find((tool) => (id && tool.id === id) || (name && tool.name === name && tool.success === null));
    if (found) found.success = msg.success ?? !msg.isError;
    active.toolEvents.push({ event: "end", name: name || found?.name || "tool", ok: msg.success ?? !msg.isError });
  } else if (msg.type === "tool_progress") {
    const name = msg.name || msg.toolName || "tool";
    const event = msg.event || "";
    active.toolEvents.push({ event, name, ok: msg.ok ?? null });
    if (event === "start") {
      active.tools.push({
        id: msg.toolCallId || msg.id || "",
        name,
        success: null,
        source: "tool_progress",
      });
    } else if (event === "end") {
      const id = msg.toolCallId || msg.id || "";
      const found = active.tools.find((tool) => (id && tool.id === id) || (name && tool.name === name && tool.success === null));
      if (found) {
        found.success = msg.ok ?? true;
      } else {
        active.tools.push({
          id,
          name,
          success: msg.ok ?? true,
          source: "tool_progress",
        });
      }
    }
  } else if (msg.type === "error") {
    active.errors.push(msg.message || JSON.stringify(msg));
  } else if (msg.type === "turn_end") {
    active.finishedNormally = true;
    active.elapsedMs = Date.now() - active.startedAt;
  }
}

async function runPrompt(config, ws, index, category, prompt, timeoutMs) {
  const active = createActive(index, category, prompt);
  const session = await httpJson(config.baseUrl, config.token, "/api/sessions/new", {
    method: "POST",
    body: { cwd: ROOT, memoryEnabled: false },
    timeoutMs: 15000,
  }).catch(() => null);
  const sessionPath = session?.path || null;
  await new Promise((resolve) => {
    let quietTimer = null;
    const cleanup = () => {
      clearTimeout(timer);
      if (quietTimer) clearTimeout(quietTimer);
      ws.off("message", onMessage);
      ws.off("error", onError);
      ws.off("close", onClose);
    };
    const finishSoon = () => {
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => {
        active.elapsedMs = Date.now() - active.startedAt;
        cleanup();
        resolve();
      }, 750);
    };
    const timer = setTimeout(() => {
      active.timedOut = true;
      active.elapsedMs = Date.now() - active.startedAt;
      if (sessionPath && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "abort", sessionPath }));
      }
      cleanup();
      resolve();
    }, timeoutMs);
    const onError = (error) => {
      active.errors.push(`ws:${error.message}`);
      cleanup();
      resolve();
    };
    const onClose = () => {
      if (!active.finishedNormally) active.errors.push("ws:closed");
      cleanup();
      resolve();
    };
    const onMessage = (raw) => {
      let msg = null;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (sessionPath && msg?.sessionPath && msg.sessionPath !== sessionPath) {
        return;
      }
      consumeMessage(active, msg);
      if (active.finishedNormally) finishSoon();
    };
    ws.on("message", onMessage);
    ws.on("error", onError);
    ws.on("close", onClose);
    if (ws.readyState !== WebSocket.OPEN) {
      active.errors.push("ws:not_open");
      cleanup();
      resolve();
      return;
    }
    try {
      ws.send(JSON.stringify({
        type: "prompt",
        text: prompt,
        ...(sessionPath ? { sessionPath } : {}),
        clientMessageId: `gui-50-${index}-${Date.now()}`,
      }));
    } catch (error) {
      active.errors.push(`ws:send_failed:${error?.message || error}`);
      cleanup();
      resolve();
    }
  });
  Object.assign(active, classify(active));
  active.reactReview = buildReactReview(active);
  return active;
}

async function runPromptWithFreshWs(config, index, category, prompt, timeoutMs) {
  const ws = await openWs(config.wsUrl, config.token);
  try {
    return await runPrompt(config, ws, index, category, prompt, timeoutMs);
  } finally {
    try { ws.close(); } catch {}
  }
}

const args = parseArgs(process.argv.slice(2));
const outputPath = path.resolve(args.output || path.join(ROOT, "reports", `gui-50-results-${nowStamp()}.json`));
await fs.mkdir(path.dirname(outputPath), { recursive: true });
let managedServer = null;
try {
  if (shouldSpawnManagedServer(args)) {
    managedServer = await startManagedServer();
    console.log(`[gui-50] managed server: ${managedServer.config.baseUrl} home=${managedServer.lynnHome}`);
  }
  const config = managedServer?.config || await readServerConfig(args);
  assertLocalTestEndpoint(config);
  await httpJson(config.baseUrl, config.token, "/api/health", { timeoutMs: 10000 });

  const selectedPrompts = selectedPromptItems(args);
  const results = [];
  for (const item of selectedPrompts) {
    const { index, category, prompt } = item;
    console.log(`[${index}/${PROMPTS.length}] ${category}: ${prompt}`);
    let result = await runPromptWithFreshWs(config, index, category, prompt, args.timeoutMs);
    if (isEmptyTransportTimeout(result)) {
      const firstAttempt = result;
      console.log(`  -> retry empty transport timeout after ${EMPTY_TIMEOUT_RETRY_MS}ms`);
      await new Promise((resolve) => setTimeout(resolve, EMPTY_TIMEOUT_RETRY_MS));
      const retry = await runPromptWithFreshWs(config, index, category, prompt, args.timeoutMs);
      // The first user-visible turn remains the gate result. Retrying records
      // diagnostics, but cannot turn an empty timeout into a green case.
      result = {
        ...firstAttempt,
        retriedAfterEmptyTimeout: true,
        retryOutcome: { status: retry.status, reason: retry.reason, elapsedMs: retry.elapsedMs },
      };
    }
    results.push(result);
    await fs.writeFile(outputPath, JSON.stringify({ outputPath, generatedAt: new Date().toISOString(), results }, null, 2), "utf8");
    const preview = result.text.trim().replace(/\s+/g, " ").slice(0, 100);
    console.log(`  -> ${result.status} ${result.elapsedMs}ms provider=${result.providerTrail.join(">") || "-"} tools=${result.tools.map((tool) => tool.name).join(",") || "-"} text=${preview}`);
    if (result.timedOut) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    if (TURN_SETTLE_MS > 0) {
      await new Promise((resolve) => setTimeout(resolve, TURN_SETTLE_MS));
    }
  }

  const counts = results.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] || 0) + 1;
    return acc;
  }, {});
  const providerCounts = results.reduce((acc, item) => {
    const last = item.providerTrail.at(-1) || "unknown";
    acc[last] = (acc[last] || 0) + 1;
    return acc;
  }, {});
  const toolRuns = results.filter((item) => item.tools.length > 0).length;
  const stepExecuteRuns = results.filter((item) => item.tools.some((tool) => tool.name === "step_execute")).length;
  const emptyTimeoutRetries = results.filter((item) => item.retriedAfterEmptyTimeout).length;
  const avgMs = Math.round(results.reduce((sum, item) => sum + item.elapsedMs, 0) / Math.max(1, results.length));
  const failures = results.filter((item) => item.status !== "ok");
  const summary = {
    outputPath,
    gateCurrentDate: CURRENT_DATE,
    total: results.length,
    counts,
    providerCounts,
    toolRuns,
    stepExecuteRuns,
    emptyTimeoutRetries,
    avgMs,
    failures: failures.map((item) => ({
      index: item.index,
      category: item.category,
      prompt: item.prompt,
      status: item.status,
      reason: item.reason,
      errors: item.errors,
      textPreview: item.text.trim().replace(/\s+/g, " ").slice(0, 240),
    })),
  };
  await fs.writeFile(outputPath, JSON.stringify({ ...summary, generatedAt: new Date().toISOString(), results }, null, 2), "utf8");
  console.log(`SUMMARY ${JSON.stringify(summary)}`);
  if (failures.length > 0) process.exitCode = 1;
} finally {
  if (managedServer) await managedServer.close();
}
if (process.exitCode) process.exit(process.exitCode);
