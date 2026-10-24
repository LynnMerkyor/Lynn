import fs from "node:fs/promises";
import path from "node:path";
import { displayPath, resolveInsideWorkspace } from "./path.js";
import { isKnownUnchanged, recordFileRead, wasFileRead } from "./read-state.js";
import type { ClientToolResult, ToolRunContext } from "./types.js";

export async function writeFileTool(ctx: ToolRunContext, inputPath: string, text: string): Promise<ClientToolResult> {
  if (ctx.approval !== "yolo") {
    throw new Error("write_file requires approval. In interactive ask mode, approve the prompt; for headless/Fleet runs pass --approval yolo.");
  }
  const filePath = await resolveInsideWorkspace(ctx.cwd, inputPath);
  const existing = await fs.stat(filePath).catch(() => null);
  const warning = existing?.isFile() && !wasFileRead(filePath)
    ? `You overwrote ${inputPath} without reading it in this session. Prefer read_file then edit for existing files.`
    : existing?.isFile() && !isKnownUnchanged(filePath, existing)
      ? `${inputPath} changed on disk since you last read it; this write replaced it with your version.`
      : undefined;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
  const after = await fs.stat(filePath);
  recordFileRead(filePath, after, { offset: 0, nextOffset: after.size, truncated: false }, "write");
  return {
    ok: true,
    tool: "write_file",
    output: {
      path: displayPath(ctx.cwd, filePath),
      bytes: Buffer.byteLength(text, "utf8"),
      mtimeMs: after.mtimeMs,
      mtime: new Date(after.mtimeMs).toISOString(),
      ...(warning ? { warning } : {}),
    },
  };
}
