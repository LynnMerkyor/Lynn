import { spawn } from "node:child_process";
import { resolveInsideWorkspace } from "./path.js";
import type { ClientToolResult, ToolRunContext } from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 200_000;

function appendLimited(current: string, next: string): string {
  const combined = current + next;
  if (Buffer.byteLength(combined, "utf8") <= MAX_OUTPUT_BYTES) return combined;
  return combined.slice(-MAX_OUTPUT_BYTES);
}

export async function applyPatchTool(ctx: ToolRunContext, patch: string): Promise<ClientToolResult> {
  if (!patch.trim()) throw new Error("--text or positional patch is required for apply_patch");
  if (ctx.approval !== "yolo") {
    throw new Error("apply_patch requires --approval yolo in the v0.80 scaffold");
  }
  const cwd = await resolveInsideWorkspace(ctx.cwd, ".");
  return new Promise((resolve) => {
    const child = spawn("git", ["apply", "--whitespace=nowarn", "-"], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
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
        tool: "apply_patch",
        output: { exitCode: code ?? null, timedOut, stdout, stderr },
      });
    });
    child.stdin.end(patch);
  });
}
