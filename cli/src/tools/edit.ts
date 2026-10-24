/**
 * tools/edit.ts — exact-string replacement, the edit primitive agents use most.
 *
 * Why a dedicated tool instead of apply_patch: local models reliably produce
 * "replace this exact block" but often mangle unified-diff line counts. Requiring
 * a unique old_string gives the model a precise, self-verifying operation and
 * gives us a hard failure with a useful message when the context does not match.
 */
import fs from "node:fs/promises";
import { displayPath, resolveInsideWorkspace } from "./path.js";
import { isKnownUnchanged, recordFileRead, wasFileRead } from "./read-state.js";
import type { ClientToolResult, ToolRunContext } from "./types.js";

export interface EditFileInput {
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

const PREVIEW_LIMIT = 2_000;

export async function editFileTool(ctx: ToolRunContext, input: EditFileInput): Promise<ClientToolResult> {
  if (ctx.approval !== "yolo") {
    throw new Error("edit requires approval. In interactive ask mode, approve the prompt; for headless/Fleet runs pass --approval yolo.");
  }
  if (!input.path) throw new Error("path is required for edit");
  if (!input.old_string) throw new Error("old_string is required for edit (use write_file to create a new file)");
  if (input.old_string === input.new_string) throw new Error("old_string and new_string are identical; nothing to change");

  const filePath = await resolveInsideWorkspace(ctx.cwd, input.path);
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat || !stat.isFile()) throw new Error(`file does not exist: ${input.path}`);

  if (process.env.LYNN_CLI_SKIP_READ_GATE !== "1") {
    if (!wasFileRead(filePath)) {
      throw new Error(`read ${input.path} with read_file before editing it — Lynn does not let the model edit a file it has not seen.`);
    }
    if (!isKnownUnchanged(filePath, stat)) {
      throw new Error(`${input.path} changed on disk since you read it. Read it again, then retry the edit.`);
    }
  }

  const original = await fs.readFile(filePath, "utf8");
  const crlf = original.includes("\r\n");
  const working = crlf ? original.replace(/\r\n/g, "\n") : original;
  const index = working.indexOf(input.old_string);
  if (index < 0) throw new Error(buildNotFoundMessage(working, input.old_string, input.path));

  const occurrences = countOccurrences(working, input.old_string);
  if (occurrences > 1 && !input.replace_all) {
    throw new Error(`old_string appears ${occurrences} times in ${input.path}. Add more surrounding context to make it unique, or pass replace_all=true.`);
  }

  const replaced = input.replace_all
    ? working.split(input.old_string).join(input.new_string)
    : `${working.slice(0, index)}${input.new_string}${working.slice(index + input.old_string.length)}`;
  const next = crlf ? replaced.replace(/\n/g, "\r\n") : replaced;

  await fs.writeFile(filePath, next, "utf8");
  const after = await fs.stat(filePath);
  recordFileRead(filePath, after, { offset: 0, nextOffset: after.size, truncated: false }, "write");

  return {
    ok: true,
    tool: "edit",
    output: {
      path: displayPath(ctx.cwd, filePath),
      replacements: input.replace_all ? occurrences : 1,
      line: lineNumberAt(working, index),
      bytesBefore: Buffer.byteLength(original, "utf8"),
      bytesAfter: Buffer.byteLength(next, "utf8"),
      mtimeMs: after.mtimeMs,
      mtime: new Date(after.mtimeMs).toISOString(),
      preview: buildEditPreview(working, index, input.old_string, input.new_string),
    },
  };
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let cursor = 0;
  while (true) {
    const found = haystack.indexOf(needle, cursor);
    if (found < 0) return count;
    count += 1;
    cursor = found + needle.length;
  }
}

function lineNumberAt(text: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (text[cursor] === "\n") line += 1;
  }
  return line;
}

function buildNotFoundMessage(text: string, needle: string, file: string): string {
  const firstLine = needle.split("\n")[0]?.trim();
  if (firstLine && text.includes(firstLine)) {
    return `The first line of old_string exists in ${file}; the rest does not match. Re-read the file and copy the exact whitespace/indentation.`;
  }
  return `old_string does not appear in ${file}. Re-read the file to get the current text.`;
}

/** A compact `-`/`+` window around the edit, capped for the transcript. */
export function buildEditPreview(before: string, index: number, oldString: string, newString: string): string {
  const lines = before.split("\n");
  const startLine = lineNumberAt(before, index) - 1;
  const oldCount = oldString.split("\n").length;
  const removed = oldString.split("\n");
  const added = newString.split("\n");
  const contextBefore = lines.slice(Math.max(0, startLine - 2), startLine);
  const contextAfter = lines.slice(startLine + oldCount, startLine + oldCount + 2);
  const preview = [
    `@@ -${startLine + 1},${startLine + oldCount} +${startLine + 1},${startLine + added.length} @@`,
    ...contextBefore.map((line) => `  ${line}`),
    ...removed.map((line) => `- ${line}`),
    ...added.map((line) => `+ ${line}`),
    ...contextAfter.map((line) => `  ${line}`),
  ].join("\n");
  return preview.length > PREVIEW_LIMIT ? `${preview.slice(0, PREVIEW_LIMIT)}\n…` : preview;
}
