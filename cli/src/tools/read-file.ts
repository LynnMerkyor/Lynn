import fs from "node:fs/promises";
import { displayPath, resolveInsideWorkspace } from "./path.js";
import type { ClientToolResult, ToolRunContext } from "./types.js";

export async function readFileTool(ctx: ToolRunContext, inputPath: string, maxBytes = 200_000, offset = 0): Promise<ClientToolResult> {
  const filePath = await resolveInsideWorkspace(ctx.cwd, inputPath);
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error(`not a file: ${inputPath}`);
  const start = normalizeOffset(offset);
  const limit = Math.max(0, Math.floor(maxBytes || 0));
  const handle = await fs.open(filePath, "r");
  try {
    const length = Math.min(Math.max(0, stat.size - start), limit);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    const nextOffset = start + bytesRead;
    return {
      ok: true,
      tool: "read_file",
      output: {
        path: displayPath(ctx.cwd, filePath),
        offset: start,
        nextOffset,
        truncated: nextOffset < stat.size,
        bytes: bytesRead,
        text: buffer.subarray(0, bytesRead).toString("utf8"),
      },
    };
  } finally {
    await handle.close();
  }
}

function normalizeOffset(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}
