#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CLI = resolve(ROOT, "cli/bin/lynn.mjs");

const PROMPTS = [
  ["simple", "你好，只回复 OK"],
  ["simple", "用一句话解释 ReAct"],
  ["simple", "2+2 等于几？只给答案"],
  ["simple", "把 hello world 翻译成中文"],
  ["simple", "用三条 bullet 解释什么是上下文窗口"],
  ["simple", "给我 3 条 git commit message 规范"],
  ["simple", "解释一下 React 的 state 和 props 区别"],
  ["simple", "写一个 JavaScript debounce 函数"],
  ["simple", "用 Markdown 表格比较 BFS 和 DFS"],
  ["simple", "给出一个 SQL users 表建表语句"],
  ["realtime", "昨晚世界杯最新的比赛结果"],
  ["realtime", "今晚世界杯有几场比赛"],
  ["realtime", "今天世界杯赛程发我一下"],
  ["realtime", "世界杯半决赛在哪一天？"],
  ["realtime", "2026世界杯已经出的赛事比分"],
  ["realtime", "NBA 总决赛打了几场，总比分如何？"],
  ["realtime", "今年 NBA 马刺夺冠了吗，还是尼克斯？"],
  ["realtime", "今日金价是多少？"],
  ["realtime", "英伟达股价最新是多少？"],
  ["realtime", "苹果公司 AAPL 最新股价是多少？"],
  ["realtime", "美元人民币汇率现在多少？"],
  ["realtime", "深圳明天下雨吗？"],
  ["realtime", "北京今天空气质量怎么样？"],
  ["realtime", "今天 A 股有什么异动？"],
  ["realtime", "中国主要私董会的人数和收费大概多少？"],
  ["search", "查一下 OpenAI 最近发布了什么新模型，给一句摘要"],
  ["search", "访问 example.com 并用一句话概括页面内容"],
  ["search", "查一下 2026 世界杯美国队上一场比分"],
  ["search", "查一下今晚英格兰与克罗地亚是否有比赛"],
  ["search", "查一下深圳今天有没有暴雨预警"],
  ["format", "把这个列表排序并去重：banana, apple, banana, pear"],
  ["format", "把“今天心情很好但是任务很多”改写得更正式一点"],
  ["format", "给我一个三列表格：任务、优先级、风险"],
  ["format", "写一个正则，匹配常见邮箱地址，并解释限制"],
  ["format", "用 LaTeX 写出二次方程求根公式"],
  ["code", "写一个 Python 函数读取 CSV 并按第一列分组计数"],
  ["code", "写一个 bash 命令统计当前目录下所有 .ts 文件行数"],
  ["code", "给一个 TypeScript discriminated union 的例子"],
  ["code", "解释 async/await 和 Promise.then 的区别"],
  ["code", "写一个 JSON schema，要求 name 字符串、age 正整数"],
  ["reasoning", "如果一个任务三次搜索都没结果，应该如何向用户解释？"],
  ["reasoning", "为什么模型工具成功但最后可能空答？给出两个原因"],
  ["reasoning", "给一个 UI 输入框在窄屏不溢出的设计检查清单"],
  ["reasoning", "如果复核模型和主模型结论冲突，产品上怎么展示比较好？"],
  ["reasoning", "设计一个 5 步门禁测试流程验证聊天工具链"],
  ["mixed", "查询今晚世界杯赛程，并最后用一个小表格输出"],
  ["mixed", "查询今日金价，如果没有确切数据请明确说不确定"],
  ["mixed", "查询英伟达股价，并说明数据时间"],
  ["mixed", "查深圳明天天气，并说明今天和明天的区别"],
  ["mixed", "查 NBA 总决赛结果，并给出一条可能的复核质疑点"],
  ["product", "DGX Spark 最新版出了吗？请优先用 NVIDIA 官方来源回答"],
  ["product", "NVIDIA DGX Spark 当前软件版本是什么？列出版本号和来源"],
  ["product", "RTX Spark Windows PC 和 DGX Spark 是同一个产品吗？"],
  ["product", "CUDA Toolkit 13 最新版是多少？给官方依据"],
  ["product", "Node.js 最新 LTS 版本是多少？"],
  ["product", "Python 3.13 最新维护版本是多少？"],
  ["product", "OpenAI 最近官方发布的新模型是什么？"],
  ["product", "Claude 最新公开模型是哪一代？"],
  ["product", "Kimi K2.7 Code 是不是已经公开发布了？"],
  ["product", "GLM 5.0 Turbo 当前是否可用？请说明依据不足时怎么说"],
  ["official", "查 Lynn v0.85.1 镜像站下载页现在显示的版本号"],
  ["official", "查 Gitee 上 Lynn 最新 release tag 是什么"],
  ["official", "download.merkyorlynn.com 的下载页能打开吗？只总结状态"],
  ["official", "查 NVIDIA DGX Spark marketplace 是否显示可购买"],
  ["official", "查 OpenAI API 文档里 Responses API 是否仍是推荐接口"],
  ["official", "查 Anthropic docs 是否提到 Claude Code"],
  ["official", "查 Apple 开发者文档里 notarization 的用途"],
  ["official", "查 Microsoft Windows on Arm 最新开发者页面一句摘要"],
  ["realtime", "今天上海天气如何？"],
  ["realtime", "广州明天会下雨吗？"],
  ["realtime", "杭州今天空气质量怎么样？"],
  ["realtime", "纳斯达克指数最新点位是多少？"],
  ["realtime", "比特币现在价格大概多少？"],
  ["realtime", "特斯拉 TSLA 最新股价是多少？"],
  ["realtime", "日元兑人民币现在大概多少？"],
  ["realtime", "今天科技新闻有什么重要更新？"],
  ["realtime", "今晚世界杯后续赛程有没有 23 点后的比赛？"],
  ["realtime", "你能预测今晚世界杯比分吗？请说明这是预测不是事实"],
  ["research", "比较 DGX Spark 和 Mac Studio 做本地 AI 的定位差异"],
  ["research", "给 Lynn Session Map 工作地图写 5 条验收标准"],
  ["research", "给长会话 7GB 卡死问题设计一个健康检查策略"],
  ["research", "怎么判断搜索结果是伪相关？给一个门禁规则"],
  ["research", "设计一个证据优先搜索 Agent 的失败策略"],
  ["research", "解释为什么不能把搜索摘要直接当事实"],
  ["research", "给 GUI 右侧工作台写一个信息架构草案"],
  ["research", "给 CLI 和 GUI 共用内核写一个回归测试矩阵"],
  ["ux", "把这个错误提示改得更像产品文案：internal auth error"],
  ["ux", "给 Session Map 的 Huge 节点写 3 个短状态文案"],
  ["ux", "给“从此分支”按钮写一条 tooltip"],
  ["ux", "左侧会话列表很多数字徽标时如何规整？"],
  ["ux", "右侧工作台显示当前会话 digest 时应该避免什么？"],
  ["ux", "把“资料不足时应继续补充来源再下结论”改写得更自然"],
  ["code", "写一个 TypeScript 函数判断字符串是否包含 URL"],
  ["code", "写一个 Node.js 脚本读取 JSON 并输出 keys 数量"],
  ["code", "解释 Vitest 的 beforeEach 用途"],
  ["code", "给一个 React useMemo 适合使用的例子"],
  ["code", "写一个 CSS grid 三栏布局，中间自适应"],
  ["code", "写一个 zod schema 校验 release manifest"],
  ["code", "给一个 Electron 主进程 IPC handler 的伪代码"],
  ["code", "解释为什么不要在前端组件里直接写复杂业务规则"],
];

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
  "<｜｜DSML｜｜",
  "DSML｜｜tool_calls",
  "根据本轮已执行工具返回的证据",
  "根据本轮已执行操作返回的可见结果",
  "先看一下当前代码仓库",
  "让我先看一下当前代码仓库",
  "find /Users/lynn/Downloads/Lynn",
  "工具已经返回内容",
  "没有提取到足够可靠的事实",
  "能先确认这些数字线索",
  "如果需要更精确的实时结论",
  "aborted",
  "request timeout",
  "模型请求超时",
  "模型请求超时，请重试",
  "请缩小问题范围后重试",
  "Lynn CLI 版本:",
  "Lynn CLI version:",
  "模型路由:StepFun",
  "Runtime route: StepFun",
  "运行时优化:",
  "Runtime optimizations:",
];

const BAD_ERROR_NEEDLES = [
  ...BAD_TEXT_NEEDLES,
  "Error:",
];

const CURRENT_YEAR = 2026;
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
    cli: process.env.LYNN_CLI_50_BIN || DEFAULT_CLI,
    timeoutMs: Number(process.env.LYNN_CLI_50_TIMEOUT_MS || "120000"),
    limit: PROMPTS.length,
    only: "",
    output: "",
    mode: process.env.LYNN_CLI_50_MODE || "brain",
    dataDir: process.env.LYNN_CLI_50_DATA_DIR || "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--cli") args.cli = next();
    else if (arg.startsWith("--cli=")) args.cli = arg.slice("--cli=".length);
    else if (arg === "--timeout-ms") args.timeoutMs = Number(next());
    else if (arg.startsWith("--timeout-ms=")) args.timeoutMs = Number(arg.slice("--timeout-ms=".length));
    else if (arg === "--limit") args.limit = Number(next());
    else if (arg.startsWith("--limit=")) args.limit = Number(arg.slice("--limit=".length));
    else if (arg === "--only") args.only = next();
    else if (arg.startsWith("--only=")) args.only = arg.slice("--only=".length);
    else if (arg === "--output") args.output = next();
    else if (arg.startsWith("--output=")) args.output = arg.slice("--output=".length);
    else if (arg === "--mode") args.mode = next();
    else if (arg.startsWith("--mode=")) args.mode = arg.slice("--mode=".length);
    else if (arg === "--data-dir") args.dataDir = next();
    else if (arg.startsWith("--data-dir=")) args.dataDir = arg.slice("--data-dir=".length);
    else if (arg === "--current-date") next();
    else if (arg.startsWith("--current-date=")) {
      // Parsed before parseArgs via resolveGateCurrentDate().
    }
    else if (arg === "--help" || arg === "-h") {
      console.log(`Usage:
  node scripts/cli-50-dialogue-runner.mjs

Options:
  --cli PATH       CLI entry, default: cli/bin/lynn.mjs
  --limit N        run first N prompts for quick checks
  --only LIST      run prompt indexes, e.g. 14,15 or 11-15
  --timeout-ms N   per-dialogue timeout, default 120000
  --output PATH    write JSON report to this path
  --mode MODE      brain (default) or ambient
  --data-dir PATH  CLI data dir; brain mode defaults to a temporary empty dir
  --current-date YYYY-MM-DD
                   gate date anchor for relative-date assertions`);
      process.exit(0);
    }
  }
  if (!["brain", "ambient"].includes(args.mode)) {
    throw new Error(`Unsupported --mode ${args.mode}; expected brain or ambient`);
  }
  if (args.mode === "brain" && !args.dataDir) {
    args.dataDir = mkdtempSync(resolve(os.tmpdir(), "lynn-cli-50-"));
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const outPath = resolve(args.output || `reports/cli-50-results-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
mkdirSync(dirname(outPath), { recursive: true });

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
  const limit = Math.max(0, Math.min(args.limit, PROMPTS.length));
  return all.slice(0, limit);
}

function classify(result) {
  const text = result.assistantText.trim();
  const joinedErrors = result.errors.join("\n");
  const bad = BAD_TEXT_NEEDLES.find((needle) => text.includes(needle))
    || BAD_ERROR_NEEDLES.find((needle) => joinedErrors.includes(needle));
  if (result.timedOut) return { status: "timeout", reason: "process timeout" };
  if (result.exitCode !== 0) return { status: "process_fail", reason: `exit ${result.exitCode}` };
  if (!text) return { status: "empty", reason: "no assistant text" };
  if (bad) return { status: "fallback_or_error_text", reason: bad };
  const qualityIssue = qualityReason(result.prompt, text, result);
  if (qualityIssue) return { status: "quality_fail", reason: qualityIssue };
  return { status: "ok", reason: "" };
}

function hasToolEvidence(result) {
  return Array.isArray(result.toolNames) && result.toolNames.length > 0;
}

function claimsFreshToolEvidence(text) {
  return /根据(?:最新|真实)?(?:查询结果|搜索结果|工具结果|检索结果|返回结果|工具返回)|实时(?:天气|行情|比分|赛程|数据)|查到|(?:本轮|当前|上述|这些|根据).{0,12}(?:搜索结果|工具结果)/.test(text);
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

function hasSplicedWorldCupScoreEvidence(text) {
  const normalized = String(text || "").replace(/\s+/g, "");
  const hasUsBosniaScore = /美国\s*(?:1|一)\s*[-–—:：比]\s*(?:1|一)\s*波黑/.test(normalized);
  const givesCanadaCreditForThatResult = /加拿大.{0,24}(?:世界杯历史第?1个积分|首个积分|拿到1[-–—:：比]1平局|首战波黑拿到1[-–—:：比]1)/.test(normalized);
  return hasUsBosniaScore && givesCanadaCreditForThatResult;
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
  return hasPredictionCue && hasScore;
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
    return /\bGPT\s*-?\s*5\.(?:3|4|5)\b/i.test(raw);
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

function qualityReason(prompt, text, result = {}) {
  if (/针对“[^”]+”，我能从工具证据中确认/.test(String(text || ""))) {
    return "tool-evidence-template-leaked";
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
    if (isStaleWorldCupAnswer(prompt, text)) {
      return "world-cup-stale-or-not-started-answer";
    }
    if (isWorldCupPredictionPrompt(prompt)) {
      if (!hasWorldCupPredictionAnswer(text)) return "world-cup-prediction-without-score-or-disclaimer";
      return "";
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
    if (
      /半决赛/.test(prompt)
      && /四分之一决赛|1\/4\s*决赛|quarter\s*-?\s*final/i.test(text)
      && !/四分之一决赛的?胜者|四分之一决赛第\s*\d+\s*场的?胜者|四分之一决赛结束后|1\/4\s*决赛的?胜者|1\/4\s*决赛第\s*\d+\s*场的?胜者|quarter\s*-?\s*final\s+\d+\s+(?:winner|胜者)|quarter\s*-?\s*final\s+winner/i.test(text)
    ) {
      return "world-cup-semifinal-answer-called-quarterfinal";
    }
    if (/半决赛/.test(prompt) && !hasSupportedWorldCupSemifinalDate(text) && !/semi/i.test(text)) {
      return "world-cup-semifinal-question-without-date";
    }
    if (/2026世界杯已经出的赛事比分|最新的比赛结果/.test(prompt) && hasSplicedWorldCupScoreEvidence(text)) {
      return "world-cup-spliced-score-evidence";
    }
  }
  return "";
}

function cliInvocation(cliPath) {
  const looksLikeNodeEntry =
    cliPath.endsWith(".mjs") ||
    cliPath.endsWith(".js") ||
    cliPath.startsWith(".") ||
    cliPath.startsWith("/");
  if (looksLikeNodeEntry) return { command: process.execPath, args: [cliPath] };
  return { command: cliPath, args: [] };
}

function runOne(index, category, prompt) {
  return new Promise((resolveOne) => {
    const startedAt = Date.now();
    const invocation = cliInvocation(args.cli);
    const cliArgs = [...invocation.args, "-p", prompt, "--json", "--no-ink", "--no-save-session"];
    const childEnv = {
      ...process.env,
      FORCE_COLOR: "0",
      LYNN_GATE_CURRENT_DATE: CURRENT_DATE,
      LYNN_CURRENT_DATE: CURRENT_DATE,
    };
    if (args.mode === "brain") {
      cliArgs.push("--data-dir", args.dataDir);
      childEnv.LYNN_CLI_DISABLE_BYOK_FALLBACK = "1";
      for (const key of [
        "LYNN_CLI_PRESET",
        "OPENAI_COMPATIBLE_PRESET",
        "LYNN_CLI_BASE_URL",
        "OPENAI_BASE_URL",
        "LYNN_CLI_MODEL",
        "LYNN_CLI_API_KEY",
        "LYNN_CLI_PROVIDER",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "DEEPSEEK_API_KEY",
        "ZHIPUAI_API_KEY",
        "DASHSCOPE_API_KEY",
      ]) {
        delete childEnv[key];
      }
    }
    const child = spawn(invocation.command, cliArgs, {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
    });
    const result = {
      index,
      category,
      prompt,
      exitCode: null,
      durationMs: 0,
      providerTrail: [],
      toolNames: [],
      assistantText: "",
      reasoningChars: 0,
      usage: null,
      errors: [],
      toolEvents: [],
      rawTail: "",
      timedOut: false,
    };
    let stdoutTail = "";
    let stderr = "";
    const timer = setTimeout(() => {
      result.timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1500).unref();
    }, args.timeoutMs);
    child.stdout.on("data", (buf) => {
      stdoutTail += buf.toString("utf8");
      const lines = stdoutTail.split(/\r?\n/);
      stdoutTail = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        result.rawTail = `${result.rawTail}\n${line}`.slice(-4000);
        try {
          const event = JSON.parse(line);
          if (event.type === "provider" && event.activeProvider) result.providerTrail.push(event.activeProvider);
          if (event.type === "tool.start") {
            const name = event.name || event.tool || "tool";
            result.toolNames.push(name);
            result.toolEvents.push({ event: "start", name });
          }
          if (event.type === "tool_progress") {
            const name = event.name || event.tool || "tool";
            result.toolEvents.push({ event: event.event || "", name, ok: event.ok ?? null });
            if ((event.event === "start" || event.event === "end") && !result.toolNames.includes(name)) {
              result.toolNames.push(name);
            }
          }
          if (event.type === "assistant.delta") result.assistantText += event.text || "";
          if (event.type === "reasoning.delta") result.reasoningChars += String(event.text || "").length;
          if (event.type === "usage") result.usage = event.usage || null;
          if (event.type === "error") result.errors.push(event.message || JSON.stringify(event));
        } catch {
          result.errors.push(`non-json: ${line.slice(0, 240)}`);
        }
      }
    });
    child.stderr.on("data", (buf) => {
      stderr += buf.toString("utf8");
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      result.exitCode = code;
      result.durationMs = Date.now() - startedAt;
      if (stderr.trim()) result.errors.push(stderr.trim().slice(-1000));
      Object.assign(result, classify(result));
      resolveOne(result);
    });
  });
}

const results = [];
const selected = selectedPromptItems(args);
for (const item of selected) {
  const { index, category, prompt } = item;
  console.log(`[${index}/${PROMPTS.length}] ${category}: ${prompt}`);
  const result = await runOne(index, category, prompt);
  results.push(result);
  console.log(`  -> ${result.status} ${result.durationMs}ms provider=${result.providerTrail.join(">") || "-"} tools=${result.toolNames.join(",") || "-"} text=${result.assistantText.trim().slice(0, 80).replace(/\s+/g, " ")}`);
  writeFileSync(outPath, JSON.stringify({ outPath, generatedAt: new Date().toISOString(), results }, null, 2));
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
const toolRuns = results.filter((item) => item.toolNames.length).length;
const stepExecuteRuns = results.filter((item) => item.toolNames.includes("step_execute")).length;
const avgMs = Math.round(results.reduce((sum, item) => sum + item.durationMs, 0) / Math.max(1, results.length));
const summary = { outPath, mode: args.mode, dataDir: args.mode === "brain" ? args.dataDir : "", gateCurrentDate: CURRENT_DATE, total: results.length, counts, providerCounts, toolRuns, stepExecuteRuns, avgMs };

writeFileSync(outPath, JSON.stringify({ ...summary, generatedAt: new Date().toISOString(), results }, null, 2));
console.log(`SUMMARY ${JSON.stringify(summary)}`);
if (Object.entries(counts).some(([status]) => status !== "ok")) process.exit(1);
