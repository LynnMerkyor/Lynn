import fs from "node:fs/promises";
import path from "node:path";
import { resolveInsideWorkspace } from "./path.js";
import type { ClientToolResult, ToolRunContext } from "./types.js";

const SKIP = new Set([".git", "node_modules", "dist", "dist-server", "desktop/dist-renderer"]);

async function collectFiles(dir: string, root: string, out: string[], limit: number): Promise<void> {
  if (out.length >= limit) return;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (out.length >= limit) return;
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).split(path.sep).join("/");
    if (entry.isDirectory()) {
      if (SKIP.has(entry.name) || SKIP.has(rel)) continue;
      await collectFiles(full, root, out, limit);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
}

export async function grepTool(ctx: ToolRunContext, query: string, basePath = "."): Promise<ClientToolResult> {
  if (!query) throw new Error("--query is required for grep");
  const root = await resolveInsideWorkspace(ctx.cwd, basePath);
  const stat = await fs.stat(root);
  const files: string[] = [];
  if (stat.isFile()) files.push(root);
  else await collectFiles(root, root, files, 1000);

  const matches: Array<{ path: string; line: number; text: string }> = [];
  for (const file of files) {
    if (matches.length >= 100) break;
    let text = "";
    try {
      text = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i]?.includes(query)) {
        matches.push({
          path: path.relative(ctx.cwd, file).split(path.sep).join("/"),
          line: i + 1,
          text: lines[i] || "",
        });
      }
      if (matches.length >= 100) break;
    }
  }

  return { ok: true, tool: "grep", output: { query, matches } };
}
