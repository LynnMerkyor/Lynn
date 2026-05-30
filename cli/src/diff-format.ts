/**
 * diff-format.ts — colorize a unified diff / apply_patch body for the terminal.
 * Pure + testable (no streams). Mirrors the GUI's diff-line classifier so the CLI
 * and the GUI render diffs the same way. Handles both unified diffs and the
 * apply_patch envelope (`*** Begin Patch` / `*** Update File:` / `@@`).
 */
import { cyan, dim, green, red } from "./terminal-style.js";
import { visibleLength } from "./startup.js";

export type PatchLineKind = "add" | "del" | "hunk" | "meta" | "context";

export function classifyPatchLine(line: string): PatchLineKind {
  if (line.startsWith("@@")) return "hunk";
  if (
    line.startsWith("+++") ||
    line.startsWith("---") ||
    line.startsWith("*** ") ||
    line.startsWith("diff ") ||
    line.startsWith("index ")
  ) {
    return "meta";
  }
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "context";
}

/** Colorize a patch body, capping at `maxLines` with a "+N more" marker. */
export function colorizePatch(patch: string, color: boolean, maxLines = 60): string {
  const all = patch.split(/\r?\n/);
  const shown = all.slice(0, maxLines).map((line) => {
    switch (classifyPatchLine(line)) {
      case "add":
        return green(line, color);
      case "del":
        return red(line, color);
      case "hunk":
        return cyan(line, color);
      case "meta":
        return dim(line, color);
      default:
        return line;
    }
  });
  if (all.length > maxLines) {
    shown.push(dim(`… (+${all.length - maxLines} more lines)`, color));
  }
  return shown.join("\n");
}

export interface PatchSummary {
  files: string[];
  insertions: number;
  deletions: number;
}

export function summarizePatch(patch: string): PatchSummary {
  const files = new Set<string>();
  let insertions = 0;
  let deletions = 0;
  for (const line of patch.split(/\r?\n/)) {
    const file = parsePatchFile(line);
    if (file) files.add(file);
    if (line.startsWith("+") && !line.startsWith("+++") && !line.startsWith("*** ")) insertions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { files: [...files], insertions, deletions };
}

export function renderPatchPreview(patch: string, color: boolean, maxLines = 80): string {
  const summary = summarizePatch(patch);
  const filePart = summary.files.length
    ? summary.files.slice(0, 3).join(", ") + (summary.files.length > 3 ? ` +${summary.files.length - 3}` : "")
    : "patch";
  const stats = [
    summary.files.length ? `${summary.files.length} file${summary.files.length === 1 ? "" : "s"}` : null,
    summary.insertions ? green(`+${summary.insertions}`, color) : null,
    summary.deletions ? red(`-${summary.deletions}`, color) : null,
  ].filter(Boolean).join(" ");
  return [
    diffBoxHeader(`patch preview · ${filePart}${stats ? ` · ${stats}` : ""}`, color),
    colorizePatch(patch, color, maxLines),
  ].join("\n");
}

function parsePatchFile(line: string): string | null {
  if (line.startsWith("*** Update File: ")) return line.slice("*** Update File: ".length).trim();
  if (line.startsWith("*** Add File: ")) return line.slice("*** Add File: ".length).trim();
  if (line.startsWith("*** Delete File: ")) return line.slice("*** Delete File: ".length).trim();
  if (line.startsWith("diff --git ")) {
    const parts = line.split(/\s+/);
    return (parts[3] || parts[2] || "").replace(/^b\//, "").replace(/^a\//, "") || null;
  }
  return null;
}

function diffBoxHeader(title: string, color: boolean): string {
  const width = Math.max(42, Math.min(88, visibleLength(title) + 4));
  const line = "─".repeat(Math.max(0, width - visibleLength(title) - 3));
  return dim(`╭─ ${title} ${line}`, color);
}
