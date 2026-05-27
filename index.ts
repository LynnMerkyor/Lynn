import fs from "fs";
import readline from "readline";
import { HanaEngine } from "./core/engine.js";
import { ensureFirstRun } from "./core/first-run.js";
import { MoodParser } from "./core/events.js";

// ═══════════════════════════════════════
// Project Lynn — CLI Agent with Memory
// ═══════════════════════════════════════

import os from "os";
import path from "path";

const projectRoot = import.meta.dirname;
const productDir = projectRoot + "/lib";

type AnyRecord = Record<string, any>;
type CliEvent = AnyRecord & {
  type?: string;
  assistantMessageEvent?: AnyRecord & {
    type?: string;
    delta?: string;
    error?: unknown;
    toolCall?: AnyRecord;
  };
  toolCall?: AnyRecord;
  toolResults?: Array<AnyRecord>;
  output?: string;
};
type MoodEvent = {
  type: "text" | "mood_start" | "mood_text" | "mood_end";
  data?: string;
};

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err || "unknown error");
}

// 用户数据目录：优先 LYNN_HOME，兼容 HANA_HOME，默认 ~/.lynn
const lynnHome = process.env.LYNN_HOME
  ? path.resolve(process.env.LYNN_HOME.replace(/^~/, os.homedir()))
  : process.env.HANA_HOME
    ? path.resolve(process.env.HANA_HOME.replace(/^~/, os.homedir()))
    : path.join(os.homedir(), ".lynn");
process.env.LYNN_HOME = lynnHome;

// ── 首次运行播种 ──
ensureFirstRun(lynnHome, productDir);

// ── 初始化引擎 ──
const engine = new HanaEngine({ lynnHome, productDir }) as any;

try {
  await engine.init((msg: string) => console.log(msg));
} catch (err) {
  console.error("启动失败:", errMessage(err));
  console.error("\n可能的原因：");
  console.error(`  1. ${path.join(lynnHome, "models.json")} 格式不对`);
  console.error("  2. API key 不对");
  console.error("  3. 网络连不上模型服务");
  console.error("  4. 缺少依赖：npm install js-yaml");
  process.exit(1);
}

const { userName, agentName } = engine;
const available = engine.availableModels;
const memoryMdPath = engine.memoryMdPath;

// ── CLI 渲染器 ──
// Hana 文字色 #7D1C4A = RGB(125, 28, 74)
const hanaColor = `\x1b[38;2;125;28;74m`;
const resetColor = `\x1b[0m`;

// 思考动画
const thinkingHints = [
  `${agentName} 正在思考`,
  `${agentName} 正在想该怎么回答你`,
  `${agentName} 正在摸鱼`,
  `${agentName} 正在翻记忆`,
  `${agentName} 正在组织语言`,
  `${agentName} 正在认真想`,
  `${agentName} 脑子转啊转`,
];
let thinkingTimer: ReturnType<typeof setInterval> | null = null;
let thinkingFrame = 0;
let thinkingDots = 0;

function startThinkingAnim() {
  if (thinkingTimer) return;
  thinkingFrame = Math.floor(Math.random() * thinkingHints.length);
  thinkingDots = 0;
  const render = () => {
    const hint = thinkingHints[thinkingFrame % thinkingHints.length];
    const dots = ".".repeat((thinkingDots % 3) + 1);
    process.stdout.write(`\r\x1b[90m✿ ${hint}${dots}\x1b[0m\x1b[K`);
    thinkingDots++;
    if (thinkingDots % 4 === 0) thinkingFrame++;
  };
  render();
  thinkingTimer = setInterval(render, 500);
}

function stopThinkingAnim() {
  if (!thinkingTimer) return;
  clearInterval(thinkingTimer);
  thinkingTimer = null;
  process.stdout.write(`\r\x1b[K`);
}

// MOOD 解析器
const moodParser = new MoodParser();

// 订阅引擎事件 → CLI 渲染
engine.subscribe((event: CliEvent) => {
  if (event.type === "message_update") {
    const assistantEvent = event.assistantMessageEvent;
    const sub = assistantEvent?.type;
    if (sub === "text_delta") {
      stopThinkingAnim();
      const delta = assistantEvent?.delta || "";

      moodParser.feed(delta, (evt: MoodEvent) => {
        if (evt.type === "text") {
          process.stdout.write(`${hanaColor}${evt.data}${resetColor}`);
        } else if (evt.type === "mood_start") {
          process.stdout.write(`\x1b[90m<mood>\x1b[0m`);
        } else if (evt.type === "mood_text") {
          process.stdout.write(`\x1b[90m${evt.data}\x1b[0m`);
        } else if (evt.type === "mood_end") {
          process.stdout.write(`\x1b[90m</mood>\x1b[0m`);
        }
      });
    } else if (sub === "thinking_delta") {
      startThinkingAnim();
    } else if (sub === "toolcall_start") {
      stopThinkingAnim();
      process.stdout.write(`\n\x1b[36m⚙ 调用工具...\x1b[0m`);
    } else if (sub === "toolcall_end") {
      const tool = assistantEvent?.toolCall;
      const argKeys = tool?.input && typeof tool.input === "object" ? Object.keys(tool.input) : [];
      console.log(`\x1b[36m ✓ ${tool?.name || "unknown"}(${argKeys.length ? `keys=${argKeys.join(",")}` : ""})\x1b[0m`);
    } else if (sub === "error") {
      console.error("\n\x1b[31m[模型返回错误]\x1b[0m", assistantEvent?.error);
    }
  } else if (event.type === "tool_execution_start") {
    const name = event.toolCall?.name || "";
    process.stdout.write(`\x1b[33m⏳ 执行 ${name}...\x1b[0m`);
  } else if (event.type === "tool_execution_update") {
    if (event.output) {
      process.stdout.write(`\x1b[90m${event.output}\x1b[0m`);
    }
  } else if (event.type === "tool_execution_end") {
    const name = event.toolCall?.name || "";
    const ok = event.toolResults?.[0]?.isError ? "✗" : "✓";
    console.log(` \x1b[33m${ok} ${name} 完成\x1b[0m`);
  }
});

// ── 启动 session ──
let session = await engine.createSession();
console.log("✿ 记忆系统已激活\n");

// ── CLI 交互 ──
readline.emitKeypressEvents(process.stdin);
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

process.stdin.on("keypress", (_ch: string, key: readline.Key) => {
  if (key && key.name === "escape") {
    rl.write(null, { ctrl: true, name: "u" });
  }
});

function promptLine(text: string): Promise<string> {
  return new Promise((resolve) => rl.question(text, resolve));
}

const ask = () => {
  rl.question(`\n\x1b[38;2;126;172;181m${userName} > \x1b[0m`, async (input: string) => {
    const trimmed = input.trim();

    if (trimmed === "/quit" || trimmed === "/exit") {
      await engine.dispose();
      console.log(`\n✿ ${agentName} 去休息了，下次见～`);
      rl.close();
      process.exit(0);
    }

    if (trimmed === "/model") {
      console.log("\n可用模型：");
      available.forEach((m: AnyRecord, i: number) => {
        const cur = engine.currentModel;
        const current = (m.id === cur?.id && m.provider === cur?.provider) ? " ← 当前" : "";
        console.log(`  ${i + 1}. ${m.name} (${m.provider})${current}`);
      });
      rl.question("\n选择模型编号 > ", async (num: string) => {
        const idx = parseInt(num) - 1;
        if (idx >= 0 && idx < available.length) {
          await engine.setPendingModel(available[idx].id, available[idx].provider);
          console.log(`\n✿ 已切换到: ${available[idx].name}`);
        } else {
          console.log("\n取消切换");
        }
        ask();
      });
      return;
    }

    if (trimmed === "/think" || trimmed.startsWith("/think ")) {
      const arg = trimmed.slice(7).trim().toLowerCase();
      const current = engine.session?.thinkingLevel || "off";
      const isOn = current !== "off";

      if (arg === "on" || arg === "off") {
        engine.setThinkingLevel(arg === "on" ? "medium" : "off");
        console.log(`\n✿ 深度思考已${arg === "on" ? "开启" : "关闭"}`);
      } else if (!arg) {
        engine.setThinkingLevel(isOn ? "off" : "medium");
        console.log(`\n✿ 深度思考已${isOn ? "关闭" : "开启"}`);
      } else {
        console.log("\n用法: /think       — 切换开关");
        console.log("      /think on    — 开启深度思考");
        console.log("      /think off   — 关闭深度思考");
      }
      ask();
      return;
    }

    if (trimmed === "/memory") {
      try {
        const md = fs.readFileSync(memoryMdPath, "utf-8");
        console.log("\n\x1b[35m── 当前记忆（session 启动时的快照）──\x1b[0m");
        console.log(md);
      } catch {
        console.log("\n（还没有记忆）");
      }
      ask();
      return;
    }

    if (trimmed === "/session") {
      try {
        const sessions = await engine.listSessions();
        if (sessions.length === 0) {
          console.log("\n（没有历史 session）");
          ask();
          return;
        }

        console.log(`\n\x1b[35m── 历史 Session（${sessions.length} 个）──\x1b[0m`);
        const display = sessions.slice(0, 15);
        for (let i = 0; i < display.length; i++) {
          const s = display[i];
          const date = s.modified.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
          const preview = (s.firstMessage || "（空）").slice(0, 50).replace(/\n/g, " ");
          const msgs = s.messageCount || 0;
          console.log(`  \x1b[36m${i + 1}.\x1b[0m [${date}] ${preview}${preview.length >= 50 ? "…" : ""} \x1b[90m(${msgs} 条消息)\x1b[0m`);
        }
        console.log(`  \x1b[90m0. 取消\x1b[0m`);

        const choice = await promptLine("\n选择 session 编号 > ");
        const idx = parseInt(choice) - 1;

        if (idx >= 0 && idx < display.length) {
          const picked = display[idx];
          console.log(`\n✿ 正在加载 session...`);
          moodParser.reset();
          session = await engine.switchSession(picked.path);
          const msgCount = engine.messages?.length ?? 0;
          console.log(`✿ 已切换到历史 session（${msgCount} 条消息）`);
        } else {
          console.log("\n取消切换");
        }
      } catch (err) {
        console.error(`\n[session 列表出错] ${errMessage(err)}`);
      }
      ask();
      return;
    }

    if (trimmed === "/new") {
      console.log("\n✿ 开始新的对话...");
      moodParser.reset();
      session = await engine.createSession();
      console.log("✿ 新 session 已创建");
      ask();
      return;
    }

    if (trimmed === "/help") {
      console.log("\n\x1b[35m── 命令列表 ──\x1b[0m");
      console.log("  /session  — 查看并切换历史对话");
      console.log("  /new      — 开始新对话");
      console.log("  /memory   — 查看当前记忆");
      console.log("  /model    — 切换模型");
      console.log("  /think    — 切换深度思考开关（on/off）");
      console.log("  /quit     — 退出");
      ask();
      return;
    }

    if (!trimmed) {
      ask();
      return;
    }

    try {
      moodParser.reset();
      console.log(`\n\x1b[38;2;125;28;74m${agentName} >\x1b[0m `);
      await engine.prompt(trimmed);
      moodParser.flush((evt: MoodEvent) => {
        if (evt.type === "text") {
          process.stdout.write(`${hanaColor}${evt.data}${resetColor}`);
        } else if (evt.type === "mood_text") {
          process.stdout.write(`\x1b[90m${evt.data}\x1b[0m`);
        }
      });
      console.log("");
    } catch (err) {
      console.error("\n[出错了]", errMessage(err));
    }

    ask();
  });
};

console.log(`✿ ${agentName} 醒了！输入 /help 查看命令\n`);
ask();
