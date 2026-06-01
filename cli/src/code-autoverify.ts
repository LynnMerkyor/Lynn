import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// ============================================================================
// 自动验证回路(#1)—— 最大 ROI。把"我觉得改好了"换成"项目自己的 typecheck 绿了才算改好"。
//
// 放在收尾门:模型说"做完了"(无工具调用)时,若本会话动过文件,自动跑项目的确定性检查
// (优先用 package.json 的 typecheck 脚本,否则 tsc --noEmit),红了就把错误回喂、不许收尾。
// 弱模型也稳:对错由编译器判,不由模型的自信判。
//
// 默认:能检测到明确检查命令就开;LYNN_CLI_AUTOVERIFY=0 关,LYNN_CLI_AUTOVERIFY_CMD 自定义。
// ============================================================================

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 4_000;

export interface AutoVerifyPlan {
  enabled: boolean;
  command: string[];
  label: string;
  timeoutMs: number;
}

export interface AutoVerifyOutcome {
  ran: boolean;
  ok: boolean;
  label: string;
  output: string;
}

const DISABLED: AutoVerifyPlan = { enabled: false, command: [], label: "auto-verify", timeoutMs: DEFAULT_TIMEOUT_MS };

function tokenize(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}

function readPackageScripts(cwd: string): Record<string, string> | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    return pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : null;
  } catch {
    return null;
  }
}

/** Deterministically pick the workspace's own verification command (no model involved). */
export function resolveAutoVerifyPlan(cwd: string, env: NodeJS.ProcessEnv = process.env): AutoVerifyPlan {
  if (env.LYNN_CLI_AUTOVERIFY === "0") return DISABLED;
  const timeoutMs = Number.parseInt(env.LYNN_CLI_AUTOVERIFY_TIMEOUT_MS || "", 10) || DEFAULT_TIMEOUT_MS;
  const custom = env.LYNN_CLI_AUTOVERIFY_CMD?.trim();
  if (custom) {
    const command = tokenize(custom);
    return command.length ? { enabled: true, command, label: "auto-verify", timeoutMs } : DISABLED;
  }
  const scripts = readPackageScripts(cwd);
  if (scripts?.typecheck) return { enabled: true, command: ["npm", "run", "--silent", "typecheck"], label: "typecheck", timeoutMs };
  if (fs.existsSync(path.join(cwd, "tsconfig.json"))) return { enabled: true, command: ["npx", "--no-install", "tsc", "--noEmit"], label: "typecheck", timeoutMs };
  return DISABLED;
}

function tail(text: string): string {
  const trimmed = text.replace(/\s+$/, "");
  return trimmed.length > MAX_OUTPUT_CHARS ? `…\n${trimmed.slice(-MAX_OUTPUT_CHARS)}` : trimmed;
}

/** Run the verification command; deterministic pass/fail by exit code. */
export function runAutoVerify(plan: AutoVerifyPlan, cwd: string): Promise<AutoVerifyOutcome> {
  if (!plan.enabled || !plan.command.length) {
    return Promise.resolve({ ran: false, ok: true, label: plan.label, output: "" });
  }
  return new Promise((resolve) => {
    const [cmd, ...args] = plan.command;
    let buf = "";
    let settled = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
    } catch (error) {
      resolve({ ran: false, ok: true, label: plan.label, output: `auto-verify could not start: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    const finish = (outcome: AutoVerifyOutcome) => { if (!settled) { settled = true; clearTimeout(timer); resolve(outcome); } };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ ran: true, ok: false, label: plan.label, output: `${tail(buf)}\n[auto-verify timed out after ${plan.timeoutMs}ms]` });
    }, plan.timeoutMs);
    child.stdout?.on("data", (chunk) => { buf += String(chunk); });
    child.stderr?.on("data", (chunk) => { buf += String(chunk); });
    child.on("error", (error) => finish({ ran: false, ok: true, label: plan.label, output: `auto-verify error: ${error.message}` }));
    child.on("close", (code) => finish({ ran: true, ok: code === 0, label: plan.label, output: tail(buf) }));
  });
}

/** Feedback message injected into the loop when verification fails (null when it passed or did not run). */
export function formatAutoVerifyFeedback(outcome: AutoVerifyOutcome): string | null {
  if (!outcome.ran || outcome.ok) return null;
  return [
    `⚠ Auto-verification (${outcome.label}) FAILED — you are NOT done yet.`,
    "The workspace's own check reported errors after your edits:",
    "```",
    outcome.output || "(no output captured)",
    "```",
    "Fix every error above, then continue. Do not give a final answer until this check passes.",
  ].join("\n");
}
