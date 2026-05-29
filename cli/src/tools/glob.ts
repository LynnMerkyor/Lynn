import fs from "node:fs/promises";
import path from "node:path";
import { displayPath, resolveInsideWorkspace } from "./path.js";
import type { ClientToolResult, ToolRunContext } from "./types.js";

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "dist-server", "desktop/dist-renderer"]);

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.split(path.sep).join("/");
  let out = "";
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i] || "";
    const next = normalized[i + 1] || "";
    if (char === "*" && next === "*") {
      out += ".*";
      i += 1;
    } else if (char === "*") {
      out += "[^/]*";
    } else {
      out += escapeRegex(char);
    }
  }
  return new RegExp(`^${out}$`);
}

async function walk(dir: string, root: string, out: string[], limit: number): Promise<void> {
  if (out.length >= limit) return;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (out.length >= limit) return;
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).split(path.sep).join("/");
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || SKIP_DIRS.has(rel)) continue;
      await walk(full, root, out, limit);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
}

export async function globTool(ctx: ToolRunContext, pattern: string, basePath = "."): Promise<ClientToolResult> {
  const root = await resolveInsideWorkspace(ctx.cwd, basePath);
  const files: string[] = [];
  await walk(root, root, files, 500);
  const regex = globToRegExp(pattern || "**");
  return {
    ok: true,
    tool: "glob",
    output: {
      root: displayPath(ctx.cwd, root),
      pattern,
      files: files.filter((file) => regex.test(file)).slice(0, 200),
    },
  };
}
