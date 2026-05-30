import { spawn } from "node:child_process";
import type { ClientToolResult, ToolRunContext } from "./types.js";

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
];

function appendLimited(current: string, next: string): string {
  const combined = current + next;
  if (Buffer.byteLength(combined, "utf8") <= MAX_STREAM_BYTES) return combined;
  return combined.slice(-MAX_STREAM_BYTES);
}

export function assertWorkspaceBashAllowed(command: string, sandbox: ToolRunContext["sandbox"]): void {
  if (sandbox === "danger-full-access") return;
  const trimmed = command.trim();
  if (!WORKSPACE_BASH_ALLOWED.test(trimmed)) {
    throw new Error("bash command is not allowed in workspace-write sandbox; use /mode yolo for danger-full-access shell access");
  }
  const hit = WORKSPACE_BASH_FORBIDDEN.find((pattern) => pattern.test(trimmed));
  if (hit) {
    throw new Error("bash command may escape the workspace; use /mode yolo only if you trust this command");
  }
}

export async function bashTool(ctx: ToolRunContext, command: string): Promise<ClientToolResult> {
  if (!command) throw new Error("--command is required for bash");
  if (ctx.approval !== "yolo") {
    throw new Error("bash requires YOLO approval. Run /mode yolo in interactive code mode or pass --approval yolo.");
  }
  assertWorkspaceBashAllowed(command, ctx.sandbox || "workspace-write");
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: ctx.cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, ctx.timeoutMs || DEFAULT_TIMEOUT_MS);
    child.stdout?.on("data", (chunk) => { stdout = appendLimited(stdout, String(chunk)); });
    child.stderr?.on("data", (chunk) => { stderr = appendLimited(stderr, String(chunk)); });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({
        ok: code === 0 && !timedOut,
        tool: "bash",
        output: { command, exitCode: code ?? null, timedOut, stdout, stderr },
      });
    });
  });
}
