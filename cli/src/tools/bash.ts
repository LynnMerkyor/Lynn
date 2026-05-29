import { spawn } from "node:child_process";
import type { ClientToolResult, ToolRunContext } from "./types.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_STREAM_BYTES = 1_000_000;

function appendLimited(current: string, next: string): string {
  const combined = current + next;
  if (Buffer.byteLength(combined, "utf8") <= MAX_STREAM_BYTES) return combined;
  return combined.slice(-MAX_STREAM_BYTES);
}

export async function bashTool(ctx: ToolRunContext, command: string): Promise<ClientToolResult> {
  if (!command) throw new Error("--command is required for bash");
  if (ctx.approval !== "yolo") {
    throw new Error("bash requires --approval yolo in the v0.80 scaffold");
  }
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
