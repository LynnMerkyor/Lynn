#!/usr/bin/env node
/**
 * gate-startup-recovery.mjs — 冷启动三矩阵门禁(issue #72 第一、二类故障的回归网)
 *
 * v0.82 issue #72:用户 Mac 上 Lynn「打不开」——FactStore 读到旧/损坏 facts.db 抛 SQLITE_ERROR,
 * 启动中断;且旧版曾把 ~/.hanako 整目录改名迁走,殃及 OpenHanako。修复后必须永远锁住:
 *
 *   A fresh     全新空 profile         → server 必须 boot 到就绪(写出 server-info.json)
 *   B corrupt   预置损坏的 facts.db    → 必须就绪 + 自动备份重建(bak 文件或恢复日志)
 *   C hanako    HOME 下有 .hanako 哨兵 → 必须就绪 + .hanako 一个字节都不许动
 *   D polluted  ~/.lynn 里有旧 MiMo 引用 → 必须自愈到 Brain 默认路由
 *
 * ★ HEADLESS:#72 是纯 server 启动故障(FactStore/better-sqlite3),本门禁只 boot
 *   dist-server-bundle/index.js,**绝不起 Electron、不开任何窗口**。早期版本起整个桌面 app
 *   会往用户屏幕弹 raw-i18n 的吓人窗口(2026-06-10 教训),且那窗口与 #72 无关。
 *
 * 依赖:npm run build:server(dist-server-bundle)。无需 Electron / renderer。
 * 用法:node scripts/gate-startup-recovery.mjs [--ready-timeout-ms 90000] [--only A|B|C|D]
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import YAML from "js-yaml";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
function argValue(flag, fallback) {
  const idx = argv.indexOf(flag);
  return idx >= 0 && argv[idx + 1] ? argv[idx + 1] : fallback;
}
const READY_TIMEOUT_MS = Number(argValue("--ready-timeout-ms", "90000"));
const ONLY = (argValue("--only", "") || "").toUpperCase();

// 就绪标志:主要靠 server-info.json 落盘(headless 文件信号);日志只作冗余。
const READY_PATTERNS = [/background startup initialized/, /server-info\.json/, /listening/i];
// 致命标志:#72 的原始崩溃形态 + 通用启动中断。恢复路径的 warning 不算
//([FactStore] facts.db unusable ... rebuilt 是预期的恢复日志)。
const FATAL_PATTERNS = [
  /SQLITE_ERROR/,
  /_prepareStatements/,
  /uncaughtException/i,
  /Cannot find module/,
  /FATAL/,
];
const RECOVERY_PATTERN = /\[FactStore\] facts\.db unusable/;

async function sha256(file) {
  const buf = await fs.readFile(file);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

async function snapshotDir(dir) {
  const out = new Map();
  async function walk(d) {
    let entries = [];
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else out.set(path.relative(dir, p), await sha256(p));
    }
  }
  await walk(dir);
  return out;
}

function diffSnapshots(before, after) {
  const problems = [];
  for (const [rel, hash] of before) {
    if (!after.has(rel)) problems.push(`missing: ${rel}`);
    else if (after.get(rel) !== hash) problems.push(`modified: ${rel}`);
  }
  for (const rel of after.keys()) {
    if (!before.has(rel)) problems.push(`added: ${rel}`);
  }
  return problems;
}

async function findFiles(dir, predicate) {
  const hits = [];
  async function walk(d) {
    let entries = [];
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (predicate(e.name)) hits.push(p);
    }
  }
  await walk(dir);
  return hits;
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", "utf-8");
}

async function writeYaml(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, YAML.dump(value, {
    indent: 2,
    lineWidth: -1,
    sortKeys: false,
    noRefs: true,
  }), "utf-8");
}

async function readYamlObject(file) {
  try {
    return YAML.load(await fs.readFile(file, "utf-8")) || {};
  } catch {
    return {};
  }
}

function terminate(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    const killTimer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* noop */ }
      resolve();
    }, 8000);
    child.once("close", () => { clearTimeout(killTimer); resolve(); });
    try { child.kill("SIGTERM"); } catch { clearTimeout(killTimer); resolve(); }
  });
}

// HEADLESS:issue #72 是 *server* 启动崩溃(FactStore → better-sqlite3 dlopen),纯服务端故障面。
// 因此本门禁只 boot server bundle 本体,**不起 Electron、不开任何窗口**(2026-06-10 教训:
// 起整个桌面 app 会往用户屏幕弹 raw-i18n 的吓人窗口,且与 #72 无关)。
// 用跑门禁的这个 Node 直接跑 dist-server-bundle/index.js —— ABI 与 node_modules 自洽。
// 就绪硬信号 = server 在 LYNN_HOME 写出 server-info.json(server/index.ts);崩溃 = 进程早退/致命日志。
async function launchAndWaitReady({ name, env }) {
  const serverEntry = path.join(ROOT, "dist-server-bundle", "index.js");
  const lynnHome = env.LYNN_HOME;
  const serverInfoPath = lynnHome ? path.join(lynnHome, "server-info.json") : null;
  const child = spawn(process.execPath, [serverEntry], {
    cwd: ROOT,
    env: {
      ...process.env,
      HANA_PORT: "0", // OS 分配,门禁不关心端口,只等 server-info.json
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  const onData = (c) => { logs += String(c); };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);

  const fileReady = async () => {
    if (!serverInfoPath) return false;
    try { await fs.access(serverInfoPath); return true; } catch { return false; }
  };

  const startedAt = Date.now();
  let ready = false;
  let fatal = null;
  while (Date.now() - startedAt < READY_TIMEOUT_MS) {
    if (await fileReady() || READY_PATTERNS.some((re) => re.test(logs))) { ready = true; break; }
    const fatalHit = FATAL_PATTERNS.find((re) => re.test(logs));
    if (fatalHit) { fatal = fatalHit; break; }
    if (child.exitCode !== null) { fatal = new RegExp(`server process exited early (code=${child.exitCode})`); break; }
    await new Promise((r) => setTimeout(r, 300));
  }
  // 就绪后再留 1.5s 让恢复/迁移类副作用落盘,再判定后置条件。
  if (ready) await new Promise((r) => setTimeout(r, 1500));
  await terminate(child);
  return { name, ready, fatal, logs };
}

function tail(logs, lines = 30) {
  return logs.split(/\n/).filter(Boolean).slice(-lines).join("\n");
}

const failures = [];
function check(name, condition, detail) {
  if (condition) console.log(`  ✓ ${name}`);
  else { failures.push(`${name}: ${detail}`); console.log(`  ✗ ${name} — ${detail}`); }
}

async function main() {
  // 前置:server bundle 必须已构建(headless 门禁直接跑它,不碰 Electron/renderer)。
  try {
    await fs.access(path.join(ROOT, "dist-server-bundle", "index.js"));
  } catch {
    throw new Error("dist-server-bundle/index.js missing — run `npm run build:server` first");
  }

  // 前置:原生模块 ABI/架构自检(fail-fast)。曾经 build/Release 残留 x86_64 的
  // better_sqlite3.node(arm64 机器)导致 server boot 崩溃 —— 在这里 1 行报错替代。
  await new Promise((resolve, reject) => {
    const probe = spawn(process.execPath, ["-e", `
      const p = require('path').join(${JSON.stringify(ROOT)}, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node');
      const m = { exports: {} };
      process.dlopen(m, p);
    `], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    probe.stderr.on("data", (c) => { err += String(c); });
    probe.on("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error(
        "原生模块自检失败:better_sqlite3.node 与本机 Node 不匹配(架构或 ABI)。\n"
        + "修复:npm rebuild better-sqlite3\n"
        + `详情:${err.split("\n").find((l) => l.includes("dlopen") || l.includes("Error")) || err.slice(0, 200)}`,
      ));
    });
  });

  const stamp = `${process.pid}-${Date.now()}`;

  // ── Matrix A:全新 profile 必须能开 ────────────────────────────────────────
  if (!ONLY || ONLY === "A") {
    console.log("\n[A fresh] 全新空 LYNN_HOME 冷启动");
    const home = path.join(os.tmpdir(), `lynn-gate-fresh-${stamp}`);
    await fs.mkdir(home, { recursive: true });
    const r = await launchAndWaitReady({ name: "fresh", env: { LYNN_HOME: home } });
    check("A 到达 Server 就绪", r.ready, `ready=false fatal=${r.fatal} tail:\n${tail(r.logs)}`);
    check("A 无致命启动错误", !r.fatal, `fatal=${r.fatal}`);
  }

  // ── Matrix B:损坏 facts.db 必须自动备份重建,不许启动中断(#72 第一类)──────
  if (!ONLY || ONLY === "B") {
    console.log("\n[B corrupt-db] 预置损坏 facts.db 冷启动(SQLITE_ERROR 回归网)");
    const home = path.join(os.tmpdir(), `lynn-gate-corrupt-${stamp}`);
    // 同时埋两个常见 agent 目录,覆盖默认 agent 解析差异。
    for (const agent of ["hanako", "lynn"]) {
      const memDir = path.join(home, "agents", agent, "memory");
      await fs.mkdir(memDir, { recursive: true });
      await fs.writeFile(path.join(memDir, "facts.db"), "THIS-IS-NOT-A-SQLITE-DATABASE\n");
    }
    const r = await launchAndWaitReady({ name: "corrupt-db", env: { LYNN_HOME: home } });
    check("B 到达 Server 就绪(不许像 #72 那样启动中断)", r.ready, `ready=false fatal=${r.fatal} tail:\n${tail(r.logs)}`);
    const baks = await findFiles(home, (n) => n.startsWith("facts.db.bak-"));
    const recovered = RECOVERY_PATTERN.test(r.logs) || baks.length > 0;
    check("B 损坏库已备份重建(bak 文件或恢复日志)", recovered, `bak=${baks.length} recovery-log=${RECOVERY_PATTERN.test(r.logs)}`);
    check("B 无未处理 SQLITE_ERROR", !/SQLITE_ERROR/.test(r.logs) || recovered, `tail:\n${tail(r.logs)}`);
  }

  // ── Matrix C:.hanako 哨兵一个字节都不许动(#72 第二类,OpenHanako 保护)────
  if (!ONLY || ONLY === "C") {
    console.log("\n[C hanako] HOME 下 .hanako 哨兵冷启动(目录迁移回归网)");
    const fakeHome = path.join(os.tmpdir(), `lynn-gate-hanako-${stamp}`);
    const hanakoDir = path.join(fakeHome, ".hanako");
    await fs.mkdir(path.join(hanakoDir, "agents", "hanako", "memory"), { recursive: true });
    await fs.writeFile(path.join(hanakoDir, "SENTINEL.txt"), "openhanako-data-do-not-touch\n");
    await fs.writeFile(path.join(hanakoDir, "agents", "hanako", "memory", "facts.db"), "openhanako-fake-db\n");
    const before = await snapshotDir(hanakoDir);
    const r = await launchAndWaitReady({
      name: "hanako",
      // macOS 下 os.homedir() 读 HOME env —— 把整个 home 沙箱化,让任何「迁移 ~/.hanako」
      // 的回归代码打到哨兵上而不是真用户目录。
      env: { HOME: fakeHome, LYNN_HOME: path.join(fakeHome, ".lynn") },
    });
    check("C 到达 Server 就绪", r.ready, `ready=false fatal=${r.fatal} tail:\n${tail(r.logs)}`);
    const stillThere = await fs.stat(hanakoDir).then(() => true).catch(() => false);
    check("C .hanako 目录仍在(不许改名迁移)", stillThere, ".hanako 目录消失 — OpenHanako 迁移回归!");
    if (stillThere) {
      const after = await snapshotDir(hanakoDir);
      const problems = diffSnapshots(before, after);
      check("C .hanako 内容逐字节未动", problems.length === 0, problems.join("; "));
    }
    const copiedSentinel = await fs.stat(path.join(fakeHome, ".lynn", "SENTINEL.txt")).then(() => true).catch(() => false);
    check("C .lynn 不复制 OpenHanako 哨兵", !copiedSentinel, "Lynn 默认读取/复制了 ~/.hanako，可能导致跳过引导和旧模型状态污染");
  }

  // ── Matrix D:旧版已污染 ~/.lynn 必须自愈到 Brain 默认路由(#74)────────────
  if (!ONLY || ONLY === "D") {
    console.log("\n[D polluted-models] 预置 OpenHanako 旧模型引用冷启动(#74 自愈网)");
    const home = path.join(os.tmpdir(), `lynn-gate-polluted-${stamp}`);
    const agentDir = path.join(home, "agents", "lynn");
    await writeYaml(path.join(agentDir, "config.yaml"), {
      agent: { name: "Lynn", yuan: "lynn" },
      api: { provider: "mimo" },
      models: {
        chat: { id: "mimo-v2.5-pro", provider: "mimo" },
        utility: "token-plan-cn",
      },
    });
    await writeYaml(path.join(home, "added-models.yaml"), {
      _migrated: true,
      providers: {
        mimo: {
          api_key: "sk-test",
          base_url: "https://token-plan-cn.xiaomimimo.com/v1",
          api: "openai-completions",
          models: ["mimo-v2.5-pro", "still-valid-model"],
        },
      },
    });
    await writeJson(path.join(home, "user", "preferences.json"), {
      utility_model: { id: "mimo-v2.5-pro", provider: "mimo" },
    });
    await writeJson(path.join(agentDir, "sessions", "session-meta.json"), {
      "old.jsonl": {
        model: { id: "mimo-v2.5-pro", provider: "mimo" },
      },
    });

    const r = await launchAndWaitReady({ name: "polluted-models", env: { LYNN_HOME: home } });
    check("D 到达 Server 就绪", r.ready, `ready=false fatal=${r.fatal} tail:\n${tail(r.logs)}`);
    const cfg = await readYamlObject(path.join(agentDir, "config.yaml"));
    const added = await readYamlObject(path.join(home, "added-models.yaml"));
    const prefs = JSON.parse(await fs.readFile(path.join(home, "user", "preferences.json"), "utf-8"));
    const meta = JSON.parse(await fs.readFile(path.join(agentDir, "sessions", "session-meta.json"), "utf-8"));
    check("D agent chat 已回到 Brain 默认", cfg?.models?.chat?.provider === "brain" && cfg?.models?.chat?.id === "lynn-brain-router", JSON.stringify(cfg?.models?.chat));
    check("D shared utility 已回到 Brain 默认", prefs?.utility_model?.provider === "brain" && prefs?.utility_model?.id === "lynn-brain-router", JSON.stringify(prefs?.utility_model));
    check("D provider 凭证保留但坏模型移除", added?.providers?.mimo?.api_key && !JSON.stringify(added?.providers?.mimo?.models || []).includes("mimo-v2.5-pro"), JSON.stringify(added?.providers?.mimo));
    check("D session meta 已回到 Brain 默认", meta?.["old.jsonl"]?.model?.provider === "brain" && meta?.["old.jsonl"]?.model?.id === "lynn-brain-router", JSON.stringify(meta?.["old.jsonl"]));
  }

  console.log(`\n[gate-startup] ${failures.length === 0 ? "PASS — 冷启动/恢复矩阵全绿" : `FAIL — ${failures.length} 项失败`}`);
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[gate-startup] 异常:${err?.stack || err}`);
  process.exit(1);
});
