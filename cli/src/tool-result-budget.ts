/**
 * tool-result-budget.ts — keep one huge tool result from eating the context.
 *
 * Mirrors Claude Code's "spill to disk + preview + path" behaviour: the inline
 * result keeps enough for the model to decide what to do next, and the full text
 * stays readable with read_file at the given path.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ClientToolResult } from "./tools/types.js";

export interface ToolResultBudgetOptions {
  /** Run identifier; one directory per run keeps spills easy to clean. */
  runId: string;
  maxInlineChars?: number;
  maxPreviewChars?: number;
  /** Override for tests. Defaults to ~/.lynn/cli-spill. */
  spillRoot?: string;
}

export interface ToolResultBudgetOutcome {
  result: ClientToolResult;
  spilledPath?: string;
  originalChars: number;
}

const DEFAULT_MAX_INLINE = 20_000;
const DEFAULT_PREVIEW = 4_000;

export function defaultSpillRoot(): string {
  return process.env.LYNN_CLI_SPILL_DIR?.trim() || path.join(os.homedir(), ".lynn", "cli-spill");
}

/**
 * If the serialized result exceeds the inline budget, persist the full JSON and
 * return a compact stub. Output shape stays an object so renderers keep working.
 */
export async function applyToolResultBudget(
  result: ClientToolResult,
  options: ToolResultBudgetOptions,
): Promise<ToolResultBudgetOutcome> {
  const serialized = JSON.stringify(result);
  const originalChars = serialized.length;
  const maxInline = options.maxInlineChars ?? DEFAULT_MAX_INLINE;
  if (originalChars <= maxInline) return { result, originalChars };

  const previewChars = options.maxPreviewChars ?? DEFAULT_PREVIEW;
  const preview = serialized.slice(0, previewChars);
  let spilledPath: string | undefined;
  try {
    const dir = path.join(options.spillRoot || defaultSpillRoot(), safeSegment(options.runId));
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${result.tool}-${Date.now().toString(36)}.json`);
    await fs.writeFile(file, serialized, "utf8");
    spilledPath = file;
  } catch {
    // Spilling is an optimization; never fail the tool because the disk refused.
  }

  const note = spilledPath
    ? `This result was ${originalChars} chars, above the ${maxInline}-char inline budget. `
      + `The full JSON is saved at ${spilledPath} — read it with read_file if you need the rest.`
    : `This result was ${originalChars} chars and was truncated to ${previewChars} chars to protect the context.`

  return {
    result: {
      ...result,
      output: {
        ...(isPlainObject(result.output) ? result.output : { value: result.output }),
        truncated: true,
        originalChars,
        preview,
        ...(spilledPath ? { spilledPath } : {}),
        note,
      },
    },
    spilledPath,
    originalChars,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80);
  return cleaned || "run";
}
