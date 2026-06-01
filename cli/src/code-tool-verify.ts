import fs from "node:fs";
import path from "node:path";
import type { CodeToolRequest } from "./code-tool-protocol.js";
import type { ClientToolResult } from "./tools/types.js";

// ============================================================================
// 工具后置条件 + 富失败上下文 —— 把"工具到底做没做成"从模型的自信里挪到确定性检查里。
//
// #2 后置条件:成功的工具调用后,确定性复核它真的生效(写文件落盘了吗?patch 的目标文件
//    还在吗?search 是不是空结果)。不依赖模型,也不依赖工具 output 的具体形状(读盘复核)。
// #7 富失败上下文:失败的工具调用,回喂模型确定性的"地面真相"(patch 失败 → 把目标文件
//    当前内容贴回去让它照这个重写;路径找不到 → 列同目录文件),让弱模型也能重新对准。
// ============================================================================

const MAX_CONTEXT_LINES = 60;
const MAX_SIBLINGS = 40;

export interface ToolPostcondition {
  severity: "ok" | "warn" | "fail";
  note: string | null;
}

function safeRead(abs: string): string | null {
  try {
    if (!fs.statSync(abs).isFile()) return null;
    return fs.readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

function safeList(dir: string): string | null {
  try {
    const entries = fs.readdirSync(dir).slice(0, MAX_SIBLINGS);
    return entries.length ? entries.join(", ") : "(empty)";
  } catch {
    return null;
  }
}

function resolveIn(cwd: string, p: string): string {
  return path.resolve(cwd, p);
}

function outputFiles(output: unknown): string[] | null {
  if (output && typeof output === "object") {
    const files = (output as { files?: unknown }).files;
    if (Array.isArray(files) && files.every((f) => typeof f === "string")) return files as string[];
  }
  return null;
}

/** Parse the target file paths a patch touches (git unified diff + codex `*** … File:` format). */
export function patchTargetFiles(patchText: string): string[] {
  const files = new Set<string>();
  for (const line of patchText.replace(/\r\n/g, "\n").split("\n")) {
    const plus = line.match(/^\+\+\+ (?:[ab]\/)?(.+)$/);
    if (plus && plus[1].trim() !== "/dev/null") { files.add(plus[1].trim()); continue; }
    const codex = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/);
    if (codex) { files.add(codex[1].trim()); continue; }
    const move = line.match(/^\*\*\* Move to: (.+)$/);
    if (move) files.add(move[1].trim());
  }
  return [...files];
}

function isDeletedByPatch(patchText: string, file: string): boolean {
  const esc = file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`^\\*\\*\\* Delete File: ${esc}\\s*$`, "m").test(patchText)) return true;
  return new RegExp(`^--- (?:[ab]/)?${esc}\\s*$`, "m").test(patchText) && /^\+\+\+ \/dev\/null\s*$/m.test(patchText);
}

function searchResultIsEmpty(tool: "grep" | "glob", output: unknown): boolean {
  if (!output || typeof output !== "object") return false;
  const o = output as Record<string, unknown>;
  const list = tool === "grep" ? o.matches : (o.files ?? o.matches ?? o.entries);
  return Array.isArray(list) && list.length === 0;
}

/** #2 Postcondition: deterministically confirm a SUCCESSFUL tool actually did what it claimed. */
export function checkToolPostcondition(request: CodeToolRequest, result: ClientToolResult, cwd: string): ToolPostcondition {
  if (!result.ok) return { severity: "ok", note: null }; // failures go through describeToolFailureContext

  if (request.tool === "write_file" && typeof request.args.path === "string" && request.args.path) {
    const onDisk = safeRead(resolveIn(cwd, request.args.path));
    if (onDisk === null) {
      return { severity: "fail", note: `⚠ POSTCONDITION FAILED: write_file reported success but ${request.args.path} is not readable on disk — the write did not take effect. Do not assume it succeeded.` };
    }
    if (typeof request.args.text === "string" && onDisk !== request.args.text) {
      return { severity: "warn", note: `⚠ POSTCONDITION: ${request.args.path} on disk does not byte-match the text you sent (disk ${onDisk.length} chars vs sent ${request.args.text.length}). Re-read it before relying on the contents.` };
    }
    return { severity: "ok", note: null };
  }

  if (request.tool === "apply_patch" && typeof request.args.text === "string") {
    const targets = outputFiles(result.output) ?? patchTargetFiles(request.args.text);
    const missing = targets.filter((file) => !isDeletedByPatch(request.args.text as string, file) && safeRead(resolveIn(cwd, file)) === null);
    if (missing.length) {
      return { severity: "fail", note: `⚠ POSTCONDITION FAILED: apply_patch reported success but these target file(s) are not readable: ${missing.join(", ")}. Re-read them — the change may not have landed.` };
    }
    return { severity: "ok", note: null };
  }

  if (request.tool === "grep" || request.tool === "glob") {
    if (searchResultIsEmpty(request.tool, result.output)) {
      return { severity: "warn", note: `Note: ${request.tool} returned no results. "Nothing found" is not proof something doesn't exist — widen the pattern/path or try another search before concluding.` };
    }
  }

  return { severity: "ok", note: null };
}

/** #7 Richer failure context: when a tool FAILS, give deterministic ground truth so the model can re-aim. */
export function describeToolFailureContext(request: CodeToolRequest, result: ClientToolResult, cwd: string): string | null {
  if (result.ok) return null;

  if (request.tool === "apply_patch" && typeof request.args.text === "string") {
    const targets = patchTargetFiles(request.args.text);
    for (const file of targets) {
      const content = safeRead(resolveIn(cwd, file));
      if (content !== null) {
        const lines = content.split("\n");
        const shown = lines.slice(0, MAX_CONTEXT_LINES).join("\n");
        const more = lines.length > MAX_CONTEXT_LINES ? `\n… (${lines.length - MAX_CONTEXT_LINES} more lines)` : "";
        return `↪ Re-aim hint: the patch failed because the surrounding lines did not match. Current content of ${file} (lines 1-${Math.min(MAX_CONTEXT_LINES, lines.length)}):\n${shown}${more}\nRebuild the patch against THIS exact text.`;
      }
    }
    return `↪ Re-aim hint: patch target file(s) ${targets.join(", ") || "(unparsed)"} could not be read. Verify the path with glob/read_file first.`;
  }

  if ((request.tool === "read_file" || request.tool === "write_file") && typeof request.args.path === "string" && request.args.path) {
    const error = (result.error || "").toLowerCase();
    if (error.includes("enoent") || error.includes("no such file") || error.includes("not found")) {
      const dir = path.dirname(resolveIn(cwd, request.args.path));
      const siblings = safeList(dir);
      if (siblings) return `↪ Re-aim hint: ${request.args.path} not found. Entries in ${path.relative(cwd, dir) || "."}: ${siblings}`;
    }
  }

  return null;
}

/** Combine the base tool-result feedback with deterministic postcondition / failure context for the loop. */
export function augmentToolResultSection(request: CodeToolRequest, result: ClientToolResult, cwd: string, baseSection: string): string {
  if (!result.ok) {
    const ctx = describeToolFailureContext(request, result, cwd);
    return ctx ? `${baseSection}\n${ctx}` : baseSection;
  }
  const post = checkToolPostcondition(request, result, cwd);
  return post.note ? `${baseSection}\n${post.note}` : baseSection;
}
