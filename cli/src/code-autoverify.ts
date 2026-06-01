import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

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

/** CI-consumable payload for the auto-verify finish gate (emitted to headless JSON + onEvent). */
export interface AutoVerifyEvent {
  label: string;
  ok: boolean;
  ran: boolean;
  /** The exact deterministic command that judged correctness, e.g. "npm run --silent typecheck". */
  command: string;
  /** 1-based re-verification attempt within this task. */
  attempt: number;
  /** True when a failed check blocked the model from finishing (the loop was forced to continue). */
  blockedFinish: boolean;
  /** Failing output (errors) — present only on failure so success events stay clean. */
  output?: string;
}

const DISABLED: AutoVerifyPlan = { enabled: false, command: [], label: "auto-verify", timeoutMs: DEFAULT_TIMEOUT_MS };
const VERIFY_COMMAND_RE = /\b(typecheck|tsc\b|vitest\b|jest\b|mocha\b|ava\b|pytest\b|cargo\s+test|go\s+test|deno\s+(?:test|check)|npm\s+(?:run\s+)?(?:test|typecheck)|pnpm\s+(?:run\s+)?(?:test|typecheck)|yarn\s+(?:run\s+)?(?:test|typecheck)|bun\s+(?:test|run\s+typecheck))\b/i;

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

/**
 * Build the CI-consumable event payload from an auto-verify outcome.
 * Pure (no I/O) so it is unit-testable; the loop just spreads the result into
 * its headless `code.auto.verify` JSONL line and the in-process `auto.verify` event.
 */
export function buildAutoVerifyEvent(outcome: AutoVerifyOutcome, plan: AutoVerifyPlan, attempt: number): AutoVerifyEvent {
  const event: AutoVerifyEvent = {
    label: outcome.label,
    ok: outcome.ok,
    ran: outcome.ran,
    command: plan.command.join(" "),
    attempt,
    blockedFinish: outcome.ran && !outcome.ok,
  };
  if (!outcome.ok && outcome.output) event.output = outcome.output;
  return event;
}

export function isLikelyVerificationCommand(command: unknown): boolean {
  return typeof command === "string" && VERIFY_COMMAND_RE.test(command.trim());
}

export function formatAutoVerifyObservation(outcome: AutoVerifyOutcome, plan: AutoVerifyPlan): string {
  if (!outcome.ran) {
    return `[Lynn auto-verify did not run: ${outcome.output || "no verification command available"}]`;
  }
  const lines = [
    `[Lynn auto-verify observation]`,
    `command: ${plan.command.join(" ")}`,
    `status: ${outcome.ok ? "passed" : "failed"}`,
  ];
  if (outcome.output) {
    lines.push("output:", outcome.output);
  }
  return lines.join("\n");
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
