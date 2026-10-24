import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ClientToolResult, ToolRunContext } from "./types.js";
import { isSafeReadOnlyShellCommand } from "../local-command.js";
import { adoptBackgroundChild, backgroundLogPath, newBackgroundJobId, startBackgroundJob } from "../background-jobs.js";
import { wrapBashCommand } from "../os-sandbox.js";
import { stopProcessTree } from "../process-tree.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_STREAM_BYTES = 1_000_000;
const WORKSPACE_BASH_ALLOWED = /^(npm|pnpm|yarn|bun|node|python3?|pytest|deno|cargo|rustc|go|git|rg|grep|find|ls|pwd|cat|sed|awk|wc|head|tail|sort|uniq|diff)\b/;
const WORKSPACE_BASH_FORBIDDEN = [
  /[;&|`]/,
  /\$\(/,
  /\bsudo\b/,
  /\bcurl\b/,
  /\bwget\b/,
  /\bscp\b/,
  /\brsync\b/,
  /\bssh\b/,
  /\bchmod\b/,
  /\bchown\b/,
  /\bdd\b/,
  /\bmkfs\b/,
  /\brm\s+-[^;&|]*r[^;&|]*\s+\//,
  /(^|[\s"'`=])\.\.(\/|$)/,
  /(^|[\s"'`=])~(\/|$)/,
  /(^|[\s"'`=])\/(Users|private|tmp|var|etc|opt|System|Library)\b/,
  />\s*\//,
  // Allowlisted binaries (find / git) that can still destroy the tree.
  /\bfind\b[^;&|]*\s-delete\b/,
  /\bfind\b[^;&|]*-exec\b[^;&|]*\brm\b/,
  /\bgit\s+clean\b/,
];
const FULL_DISK_FIND = /^\s*find\s+\/(?:\s|$)/;

function appendLimited(current: string, next: string): string {
  const combined = current + next;
  if (Buffer.byteLength(combined, "utf8") <= MAX_STREAM_BYTES) return combined;
  return combined.slice(-MAX_STREAM_BYTES);
}

/** Best-effort append to ~/.lynn/bash-audit.log so executed shell is auditable. */
export function redactBashAuditCommand(command: string): string {
  return String(command || "")
    .replace(/https?:\/\/[^:@\s/]+:[^@\s/]+@/gi, (match) => `${match.match(/^https?:\/\//i)?.[0] || "https://"}***@`)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|tp|ak)-[A-Za-z0-9_=-]{8,}\b/g, "[REDACTED_API_KEY]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{12,}|hf_[A-Za-z0-9]{12,}|ms-[A-Za-z0-9-]{12,})\b/g, "[REDACTED_TOKEN]")
    .replace(/\b(api[_-]?key|token|secret|password|passwd|authorization)\s*[:=]\s*(['"]?)[^\s'";]+\2/gi, "$1=[REDACTED]");
}

export function auditBash(command: string, cwd: string): void {
  try {
    const file = path.join(process.env.LYNN_DATA_DIR?.trim() || process.env.LYNN_HOME?.trim() || path.join(os.homedir(), ".lynn"), "bash-audit.log");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${new Date().toISOString()}\t${cwd}\t${redactBashAuditCommand(command)}\n`);
  } catch {
    /* auditing is non-critical */
  }
}

export function assertWorkspaceBashAllowed(command: string, sandbox: ToolRunContext["sandbox"]): void {
  const trimmed = command.trim();
  if (FULL_DISK_FIND.test(trimmed) && process.env.LYNN_CLI_ALLOW_FULL_DISK_FIND !== "1") {
    throw new Error("full-disk `find / ...` is disabled inside Lynn CLI because it can hang the interactive session. Search from the current workspace instead, e.g. `find . -name <file>` or set --cwd to the project. To run a whole-machine search, use your shell outside Lynn, or set LYNN_CLI_ALLOW_FULL_DISK_FIND=1 explicitly.");
  }
  if (sandbox === "danger-full-access") return;
  if (!WORKSPACE_BASH_ALLOWED.test(trimmed)) {
    throw new Error("bash command is not allowed in workspace-write sandbox; use /yolo for danger-full-access shell access, or run headless/Fleet with --approval yolo --sandbox danger-full-access");
  }
  const hit = WORKSPACE_BASH_FORBIDDEN.find((pattern) => pattern.test(trimmed));
  if (hit) {
    throw new Error("bash command may escape the workspace; use /yolo if you trust this command, or run headless/Fleet with --approval yolo --sandbox danger-full-access");
  }
}

export async function bashTool(ctx: ToolRunContext, command: string, options: { background?: boolean } = {}): Promise<ClientToolResult> {
  if (!command) throw new Error("--command is required for bash");
  if (ctx.signal?.aborted) return { ok: false, tool: "bash", output: { command, aborted: true } };
  assertWorkspaceBashAllowed(command, ctx.sandbox || "workspace-write");
  if (ctx.approval !== "yolo" && !isSafeReadOnlyShellCommand(command)) {
    throw new Error("bash requires approval except for safe read-only pwd/ls shortcuts. In interactive ask mode, approve the prompt; for headless/Fleet runs pass --approval yolo.");
  }
  auditBash(command, ctx.cwd);
  const sandboxed = wrapBashCommand(command, ctx);
  if (options.background) {
    const job = startBackgroundJob({ command, cwd: ctx.cwd, runId: ctx.runId, ...(sandboxed ? { argv: sandboxed } : {}) });
    return {
      ok: true,
      tool: "bash",
      output: {
        command,
        backgroundTaskId: job.id,
        logPath: job.logPath,
        startedAt: new Date(job.startedAt).toISOString(),
        note: "Command started in the background. Do not poll it: a <task-notification> with the exit code and log tail will arrive on a later step.",
      },
    };
  }
  const backgroundOnTimeout = process.env.LYNN_CLI_BACKGROUND_ON_TIMEOUT !== "0";
  return new Promise((resolve) => {
    const child = sandboxed
      ? spawn(sandboxed.file, sandboxed.args, {
        cwd: ctx.cwd,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      })
      : spawn(command, {
        cwd: ctx.cwd,
        shell: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let backgrounded: { id: string; logPath: string } | null = null;
    const appendToLog = (chunk: string): void => {
      if (!backgrounded) return;
      try {
        fs.appendFileSync(backgrounded.logPath, chunk);
      } catch {
        // The job keeps running even if the log becomes unwritable.
      }
    };
    const onAbort = () => {
      aborted = true;
      stopProcessTree(child);
    };
    if (ctx.signal?.aborted) onAbort();
    else ctx.signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      if (!backgroundOnTimeout) {
        stopProcessTree(child);
        return;
      }
      // Recoverability: a long command keeps running with its own log instead of
      // being killed. The loop reports it on a later step as a task notification.
      const id = newBackgroundJobId();
      const logPath = backgroundLogPath(id, ctx.runId);
      try {
        fs.appendFileSync(logPath, stdout + (stderr ? `\n[stderr]\n${stderr}` : ""));
      } catch {
        // Best effort: the in-memory prefix is still reported below.
      }
      backgrounded = { id, logPath };
      adoptBackgroundChild({ id, command, cwd: ctx.cwd, logPath, child });
      settled = true;
      resolve({
        ok: true,
        tool: "bash",
        output: {
          command,
          backgroundTaskId: id,
          logPath,
          backgrounded: true,
          timedOutAfterMs: ctx.timeoutMs || DEFAULT_TIMEOUT_MS,
          outputSoFar: stdout.slice(-2_000),
          note: "Command exceeded the foreground timeout and continues in the background. Do not poll it: a <task-notification> with the exit code and log tail will arrive on a later step.",
        },
      });
    }, ctx.timeoutMs || DEFAULT_TIMEOUT_MS);
    child.stdout?.on("data", (chunk) => {
      const text = String(chunk);
      if (backgrounded) appendToLog(text);
      else stdout = appendLimited(stdout, text);
    });
    child.stderr?.on("data", (chunk) => {
      const text = String(chunk);
      if (backgrounded) appendToLog(text);
      else stderr = appendLimited(stderr, text);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      ctx.signal?.removeEventListener("abort", onAbort);
      resolve({ ok: false, tool: "bash", output: { command, aborted, stdout, stderr, error: error.message } });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      ctx.signal?.removeEventListener("abort", onAbort);
      if (settled || backgrounded) return;
      settled = true;
      resolve({
        ok: code === 0 && !timedOut && !aborted,
        tool: "bash",
        output: { command, exitCode: code ?? null, timedOut, aborted, stdout, stderr },
      });
    });
  });
}
