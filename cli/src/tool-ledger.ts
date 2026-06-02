import type { ClientToolResult } from "./tools/types.js";

export interface ToolLedgerEntry {
  tool: string;
  ok: boolean;
  summary: string;
}

export function toolLedgerEntry(result: ClientToolResult): ToolLedgerEntry {
  return {
    tool: result.tool,
    ok: result.ok,
    summary: summarizeToolResult(result),
  };
}

export function renderToolLedger(entries: readonly ToolLedgerEntry[], step: number): string {
  const visible = entries.filter((entry) => entry.summary.trim());
  if (!visible.length) return "";
  return [
    `<lynn_tool_ledger step="${step + 1}">`,
    "Tool observations recorded during this step:",
    ...visible.map((entry, index) => `${index + 1}. ${entry.tool} ${entry.ok ? "ok" : "failed"}: ${entry.summary}`),
    "</lynn_tool_ledger>",
  ].join("\n");
}

function summarizeToolResult(result: ClientToolResult): string {
  if (!result.ok) {
    return compactInline(result.error || "unknown error", 600);
  }
  const output = result.output;
  if (isRecord(output)) {
    if (result.tool === "read_file") return summarizeReadFile(output);
    if (result.tool === "bash") return summarizeBash(output);
    if (result.tool === "grep" || result.tool === "glob") return compactInline(JSON.stringify(output), 900);
    if (result.tool === "apply_patch" || result.tool === "write_file") return compactInline(JSON.stringify(output), 700);
    if (result.tool === "update_plan") return compactInline(JSON.stringify(output), 700);
  }
  if (typeof output === "string") return compactInline(output, 900);
  return compactInline(JSON.stringify(output ?? null), 900);
}

function summarizeReadFile(output: Record<string, unknown>): string {
  const path = typeof output.path === "string" ? output.path : "(unknown path)";
  const offset = typeof output.offset === "number" ? ` offset=${output.offset}` : "";
  const nextOffset = typeof output.nextOffset === "number" ? ` nextOffset=${output.nextOffset}` : "";
  const truncated = output.truncated === true ? " truncated=true" : "";
  const text = typeof output.text === "string" ? output.text : "";
  const snippet = compactBlock(text, 600);
  return [`path=${path}${offset}${nextOffset}${truncated}`, snippet ? `text=${JSON.stringify(snippet)}` : ""]
    .filter(Boolean)
    .join("; ");
}

function summarizeBash(output: Record<string, unknown>): string {
  const command = typeof output.command === "string" ? output.command : "";
  const exitCode = typeof output.exitCode === "number" ? output.exitCode : output.exitCode === null ? "null" : "?";
  const timedOut = output.timedOut === true ? " timedOut=true" : "";
  const stdout = typeof output.stdout === "string" ? compactBlock(output.stdout, 500) : "";
  const stderr = typeof output.stderr === "string" ? compactBlock(output.stderr, 350) : "";
  return [
    command ? `command=${JSON.stringify(command)}` : "",
    `exit=${exitCode}${timedOut}`,
    stdout ? `stdout=${JSON.stringify(stdout)}` : "",
    stderr ? `stderr=${JSON.stringify(stderr)}` : "",
  ].filter(Boolean).join("; ");
}

function compactBlock(value: string, maxChars: number): string {
  return compactInline(value.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim(), maxChars);
}

function compactInline(value: string, maxChars: number): string {
  const normalized = value.replace(/[ \t]+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 24)).trimEnd()} ... [truncated]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
