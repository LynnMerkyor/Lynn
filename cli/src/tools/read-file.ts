import fs from "node:fs/promises";
import { displayPath, resolveInsideWorkspace } from "./path.js";
import type { ClientToolResult, ToolRunContext } from "./types.js";

export async function readFileTool(ctx: ToolRunContext, inputPath: string, maxBytes = 200_000): Promise<ClientToolResult> {
  const filePath = await resolveInsideWorkspace(ctx.cwd, inputPath);
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error(`not a file: ${inputPath}`);
  const handle = await fs.open(filePath, "r");
  try {
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    return {
      ok: true,
      tool: "read_file",
      output: {
        path: displayPath(ctx.cwd, filePath),
        truncated: stat.size > maxBytes,
        bytes: length,
        text: buffer.toString("utf8"),
      },
    };
  } finally {
    await handle.close();
  }
}
