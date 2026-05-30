import fs from "node:fs/promises";
import path from "node:path";
import { displayPath, resolveInsideWorkspace } from "./path.js";
import type { ClientToolResult, ToolRunContext } from "./types.js";

export async function writeFileTool(ctx: ToolRunContext, inputPath: string, text: string): Promise<ClientToolResult> {
  if (ctx.approval !== "yolo") {
    throw new Error("write_file requires YOLO approval. Run /mode yolo in interactive code mode or pass --approval yolo.");
  }
  const filePath = await resolveInsideWorkspace(ctx.cwd, inputPath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
  return {
    ok: true,
    tool: "write_file",
    output: {
      path: displayPath(ctx.cwd, filePath),
      bytes: Buffer.byteLength(text, "utf8"),
    },
  };
}
