import { spawn } from "node:child_process";
import type { ClientToolResult, ToolRunContext } from "./types.js";

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
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.on("close", (code) => {
      resolve({
        ok: code === 0,
        tool: "bash",
        output: { command, exitCode: code ?? null, stdout, stderr },
      });
    });
  });
}
