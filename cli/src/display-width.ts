/**
 * display-width.ts — terminal column helpers that are correct for CJK/emoji.
 *
 * `String.prototype.length` counts code units; a Chinese character is 2 cells and
 * an emoji is 2 cells. Pad/truncate/slice by `.length` therefore misaligns borders
 * and cursor positions on every CJK string. Everything the CLI pads or cuts for
 * display should go through this module.
 */
import stringWidth from "string-width";

/** Visual width of a string in terminal cells (ANSI escapes count as 0). */
export function displayWidth(text: string): number {
  return stringWidth(text);
}

/** Truncate to at most `maxColumns` cells, appending `ellipsis` when cut. */
export function truncateDisplay(text: string, maxColumns: number, ellipsis = "…"): string {
  if (maxColumns <= 0) return "";
  if (displayWidth(text) <= maxColumns) return text;
  const budget = Math.max(0, maxColumns - displayWidth(ellipsis));
  let width = 0;
  let out = "";
  for (const char of text) {
    const next = width + displayWidth(char);
    if (next > budget) break;
    out += char;
    width = next;
  }
  return `${out}${ellipsis}`;
}

/** Pad on the right to an exact number of cells (no-op if already wider). */
export function padEndDisplay(text: string, columns: number, pad = " "): string {
  const deficit = columns - displayWidth(text);
  if (deficit <= 0) return text;
  const padWidth = Math.max(1, displayWidth(pad));
  return text + pad.repeat(Math.ceil(deficit / padWidth)).slice(0, deficit);
}

/** Pad on the left to an exact number of cells (no-op if already wider). */
export function padStartDisplay(text: string, columns: number, pad = " "): string {
  const deficit = columns - displayWidth(text);
  if (deficit <= 0) return text;
  const padWidth = Math.max(1, displayWidth(pad));
  return pad.repeat(Math.ceil(deficit / padWidth)).slice(0, deficit) + text;
}

/**
 * Slice by cells instead of code units, e.g. to fit a long path into a status bar.
 * Never splits a wide character: a partial cell is dropped.
 */
export function sliceDisplay(text: string, startColumn: number, endColumn: number): string {
  if (endColumn <= startColumn) return "";
  let column = 0;
  let out = "";
  for (const char of text) {
    const width = displayWidth(char);
    const next = column + width;
    if (next <= startColumn) {
      column = next;
      continue;
    }
    if (column < startColumn) {
      column = next;
      continue;
    }
    if (next > endColumn) break;
    out += char;
    column = next;
  }
  return out;
}

/** Shorten the middle of a path so the tail (filename) survives. */
export function middleEllipsis(text: string, maxColumns: number): string {
  if (maxColumns <= 1 || displayWidth(text) <= maxColumns) return text;
  const tailBudget = Math.max(1, Math.floor(maxColumns * 0.6));
  const headBudget = Math.max(1, maxColumns - tailBudget - 1);
  const chars = Array.from(text);
  let head = "";
  let width = 0;
  for (const char of chars) {
    const next = width + displayWidth(char);
    if (next > headBudget) break;
    head += char;
    width = next;
  }
  let tail = "";
  width = 0;
  for (let index = chars.length - 1; index >= 0; index -= 1) {
    const char = chars[index]!;
    const next = width + displayWidth(char);
    if (next > tailBudget) break;
    tail = char + tail;
    width = next;
  }
  return `${head}…${tail}`;
}
