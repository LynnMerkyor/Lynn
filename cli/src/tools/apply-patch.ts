import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
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
    throw new Error("apply_patch requires YOLO approval. Run /mode yolo in interactive code mode or pass --approval yolo.");
  }
  if (/^\s*\*\*\* Begin Patch/m.test(patch)) {
    return applyCodexPatch(ctx, patch);
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

interface CodexPatchFile {
  kind: "add" | "delete" | "update";
  file: string;
  moveTo?: string;
  lines: string[];
}

async function applyCodexPatch(ctx: ToolRunContext, patch: string): Promise<ClientToolResult> {
  const files = parseCodexPatch(patch);
  const changedFiles: string[] = [];
  for (const filePatch of files) {
    const target = await resolveInsideWorkspace(ctx.cwd, filePatch.file);
    if (filePatch.kind === "add") {
      const content = filePatch.lines.map((line) => stripPatchPrefix(line, "+")).join("\n");
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content.endsWith("\n") ? content : `${content}\n`, "utf8");
      changedFiles.push(filePatch.file);
    } else if (filePatch.kind === "delete") {
      await fs.unlink(target);
      changedFiles.push(filePatch.file);
    } else {
      const original = await fs.readFile(target, "utf8");
      const next = filePatch.lines.length ? applyCodexUpdate(original, filePatch.lines, filePatch.file) : original;
      if (filePatch.moveTo) {
        const movedTarget = await resolveInsideWorkspace(ctx.cwd, filePatch.moveTo);
        await fs.mkdir(path.dirname(movedTarget), { recursive: true });
        await fs.writeFile(movedTarget, next, "utf8");
        if (path.resolve(movedTarget) !== path.resolve(target)) await fs.unlink(target);
        changedFiles.push(filePatch.moveTo);
      } else {
        await fs.writeFile(target, next, "utf8");
        changedFiles.push(filePatch.file);
      }
    }
  }
  return {
    ok: true,
    tool: "apply_patch",
    output: {
      format: "codex-patch",
      files: changedFiles,
    },
  };
}

function parseCodexPatch(patch: string): CodexPatchFile[] {
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  const files: CodexPatchFile[] = [];
  let current: CodexPatchFile | null = null;
  for (const line of lines) {
    if (line === "*** Begin Patch" || line === "*** End Patch" || line === "") continue;
    const add = line.match(/^\*\*\* Add File: (.+)$/);
    const del = line.match(/^\*\*\* Delete File: (.+)$/);
    const update = line.match(/^\*\*\* Update File: (.+)$/);
    if (add || del || update) {
      current = {
        kind: add ? "add" : del ? "delete" : "update",
        file: String((add || del || update)?.[1] || "").trim(),
        lines: [],
      };
      if (!current.file) throw new Error("codex patch file header is missing a path");
      files.push(current);
      continue;
    }
    if (!current) continue;
    const move = line.match(/^\*\*\* Move to: (.+)$/);
    if (move) {
      if (current.kind !== "update") throw new Error("codex patch move operations require an update file header");
      current.moveTo = String(move[1] || "").trim();
      if (!current.moveTo) throw new Error("codex patch move target is missing a path");
      continue;
    }
    current.lines.push(line);
  }
  if (!files.length) throw new Error("codex patch did not contain any file operations");
  return files;
}

function applyCodexUpdate(original: string, patchLines: string[], file: string): string {
  const originalLines = original.split("\n");
  if (originalLines.at(-1) === "") originalLines.pop();
  let cursor = 0;
  let output = [...originalLines];
  for (const hunk of collectCodexHunks(patchLines)) {
    const oldLines = hunk.filter((line) => line.op !== "+").map((line) => line.text);
    const newLines = hunk.filter((line) => line.op !== "-").map((line) => line.text);
    const index = findSubsequence(output, oldLines, cursor);
    if (index < 0) {
      throw new Error(`codex patch context not found in ${file}: ${oldLines.slice(0, 3).join(" / ")}`);
    }
    output = [
      ...output.slice(0, index),
      ...newLines,
      ...output.slice(index + oldLines.length),
    ];
    cursor = index + newLines.length;
  }
  return `${output.join("\n")}\n`;
}

function collectCodexHunks(lines: string[]): Array<Array<{ op: " " | "-" | "+"; text: string }>> {
  const hunks: Array<Array<{ op: " " | "-" | "+"; text: string }>> = [];
  let current: Array<{ op: " " | "-" | "+"; text: string }> = [];
  const flush = () => {
    if (current.length) hunks.push(current);
    current = [];
  };
  for (const line of lines) {
    if (line.startsWith("@@")) {
      flush();
      continue;
    }
    const op = line[0];
    if (op === " " || op === "-" || op === "+") {
      current.push({ op, text: line.slice(1) });
    }
  }
  flush();
  if (!hunks.length) throw new Error("codex update patch did not contain any hunks");
  return hunks;
}

function findSubsequence(haystack: string[], needle: string[], start: number): number {
  if (!needle.length) return start;
  for (let i = Math.max(0, start); i <= haystack.length - needle.length; i += 1) {
    let ok = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

function stripPatchPrefix(line: string, expected: "+" | "-"): string {
  if (!line.startsWith(expected)) throw new Error(`expected ${expected} patch line, got: ${line}`);
  return line.slice(1);
}
