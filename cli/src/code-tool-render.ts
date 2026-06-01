import readline from "node:readline/promises";
import { t } from "./i18n.js";
import { renderPatchPreview } from "./diff-format.js";
import { CLIENT_TOOL_DEFINITIONS } from "./tools/registry.js";
import type { ClientToolName, ClientToolResult } from "./tools/types.js";
import type { CodeToolRequest } from "./code-tool-protocol.js";
import { bold, dim, green, supportsColor } from "./terminal-style.js";
import { renderCard } from "./terminal-spinner.js";

export interface ToolApprovalRequest {
  tool: ClientToolName;
  approval: "ask" | "on-failure" | "never" | "yolo";
  cwd: string;
  json: boolean;
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  preview?: string;
  session?: { approveAll: boolean };
}

export class ToolApprovalRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolApprovalRequiredError";
  }
}

export function isDangerousClientTool(tool: ClientToolName): boolean {
  return !!CLIENT_TOOL_DEFINITIONS.find((definition) => definition.name === tool)?.dangerous;
}

export function canPromptForDangerousTool(inputStream: Pick<NodeJS.ReadStream, "isTTY">, outputStream: Pick<NodeJS.WriteStream, "isTTY">, json: boolean): boolean {
  return !json && !!inputStream.isTTY && !!outputStream.isTTY;
}

export async function resolveToolApproval(request: ToolApprovalRequest): Promise<ToolApprovalRequest["approval"]> {
  if (!isDangerousClientTool(request.tool)) return request.approval;
  if (request.approval === "yolo" || request.approval === "on-failure" || request.session?.approveAll) return "yolo";
  if (request.approval === "never") {
    throw new Error(`${request.tool} requires approval; current mode is never`);
  }
  if (!canPromptForDangerousTool(request.input, request.output, request.json)) {
    throw new ToolApprovalRequiredError(`${request.tool} requires --approval yolo or an interactive confirmation`);
  }
  const rl = readline.createInterface({ input: request.input, output: request.output, terminal: true });
  try {
    if (request.preview) request.output.write(`${request.preview}\n`);
    const answer = (await rl.question(t("approval.prompt", { tool: request.tool, cwd: request.cwd }))).trim().toLowerCase();
    if (answer === "a" || answer === "always") {
      if (request.session) request.session.approveAll = true;
      return "yolo";
    }
    if (/^(y|yes)$/.test(answer)) return "yolo";
    throw new Error(`${request.tool} cancelled by user`);
  } finally {
    rl.close();
  }
}

export function redactToolArgs(request: CodeToolRequest): Record<string, unknown> {
  const args = { ...request.args } as Record<string, unknown>;
  for (const key of ["text", "command"]) {
    if (typeof args[key] === "string" && args[key].length > 500) {
      args[key] = `${args[key].slice(0, 500)}...`;
    }
  }
  return args;
}

export function renderClientToolStart(request: CodeToolRequest, stream: NodeJS.WriteStream = process.stderr): void {
  const color = supportsColor(stream);
  const target = request.args.path || request.args.query || request.args.pattern || request.args.command || "";
  const body = target ? [oneLine(target, 120)] : undefined;
  stream.write(`${renderCard({
    kind: "tool",
    title: `${clientToolIcon(request.tool)} ${request.tool} · running`,
    body,
  }, color)}\n`);
}

export function renderClientToolResult(result: ClientToolResult, stream: NodeJS.WriteStream = process.stderr): void {
  const color = supportsColor(stream);
  const detail = result.error || summarizeToolOutput(result.output);
  stream.write(`${renderCard({
    kind: result.ok ? "ok" : "error",
    title: `${clientToolIcon(result.tool)} ${result.tool} · ${result.ok ? "done" : "failed"}`,
    body: [oneLine(detail, 220)],
  }, color)}\n`);
}

export function formatDangerousToolPreview(tool: ClientToolName, args: { path?: string; text?: string; command?: string }, color: boolean): string {
  if (!isDangerousClientTool(tool)) return "";
  if (tool === "apply_patch") {
    const patch = args.text || "";
    if (!patch.trim()) return dim("(empty patch)", color);
    return renderPatchPreview(patch, color);
  }
  if (tool === "write_file") {
    return `${bold("write preview", color)} ${args.path || "(unknown path)"}\n${green(oneLine(args.text || "", 500), color)}`;
  }
  if (tool === "bash") {
    return `${bold("command", color)} ${args.command || "(empty command)"}`;
  }
  return "";
}

function summarizeToolOutput(output: unknown): string {
  const text = typeof output === "string" ? output : JSON.stringify(output);
  if (!text) return "(no output)";
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}

function clientToolIcon(tool: ClientToolName): string {
  if (tool === "read_file") return "📄";
  if (tool === "grep" || tool === "glob") return "🔎";
  if (tool === "apply_patch" || tool === "write_file") return "✎";
  if (tool === "bash") return "⌘";
  if (tool === "update_plan") return "☑";
  return "◇";
}

function oneLine(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}
