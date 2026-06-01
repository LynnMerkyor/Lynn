import readline from "node:readline/promises";
import { t } from "./i18n.js";
import { renderPatchPreview } from "./diff-format.js";
import { CLIENT_TOOL_DEFINITIONS } from "./tools/registry.js";
import type { ClientToolName, ClientToolResult } from "./tools/types.js";
import type { CodeToolRequest } from "./code-tool-protocol.js";
import { bold, dim, green, red, supportsColor } from "./terminal-style.js";
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
  const edit = editActivityForRequest(request);
  if (edit) {
    stream.write(`${renderCard({ kind: "run", title: editTitle("正在编辑", edit, color) }, color)}\n`);
    return;
  }
  const target = request.args.path || request.args.query || request.args.pattern || request.args.command || "";
  const body = target ? [oneLine(target, 120)] : undefined;
  stream.write(`${renderCard({
    kind: "tool",
    title: `${clientToolIcon(request.tool)} ${request.tool} · running`,
    body,
  }, color)}\n`);
}

export function renderClientToolResult(result: ClientToolResult, stream: NodeJS.WriteStream = process.stderr, request?: CodeToolRequest): void {
  const color = supportsColor(stream);
  const edit = request ? editActivityForRequest(request) : null;
  if (edit) {
    const state = result.ok ? "已编辑" : "编辑失败";
    const body = result.ok ? undefined : [oneLine(result.error || summarizeToolOutput(result.output), 220)];
    stream.write(`${renderCard({
      kind: result.ok ? "ok" : "error",
      title: editTitle(state, edit, color),
      body,
    }, color)}\n`);
    return;
  }
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

interface EditActivity {
  file: string;
  additions: number;
  deletions: number;
}

function editActivityForRequest(request: CodeToolRequest): EditActivity | null {
  if (request.tool === "write_file") {
    const file = oneLine(String(request.args.path || "(unknown file)"), 80);
    const text = typeof request.args.text === "string" ? request.args.text : "";
    return { file, additions: countLogicalLines(text), deletions: 0 };
  }
  if (request.tool !== "apply_patch") return null;
  const patch = typeof request.args.text === "string" ? request.args.text : "";
  if (!patch.trim()) return { file: "(empty patch)", additions: 0, deletions: 0 };
  return {
    file: summarizePatchFiles(patch),
    additions: countPatchLines(patch, "+"),
    deletions: countPatchLines(patch, "-"),
  };
}

function editTitle(prefix: string, edit: EditActivity, color: boolean): string {
  const plus = edit.additions > 0 ? ` ${green(`+${edit.additions}`, color)}` : "";
  const minus = edit.deletions > 0 ? ` ${red(`-${edit.deletions}`, color)}` : "";
  return `✎ ${prefix} ${edit.file}${plus}${minus}`;
}

function summarizePatchFiles(patch: string): string {
  const files = patchFiles(patch);
  if (!files.length) return "(patch)";
  if (files.length === 1) return oneLine(files[0], 80);
  return `${oneLine(files[0], 64)} +${files.length - 1}`;
}

function patchFiles(patch: string): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  const add = (file: string | undefined) => {
    const clean = (file || "").trim().replace(/^[ab]\//, "");
    if (!clean || clean === "/dev/null" || seen.has(clean)) return;
    seen.add(clean);
    files.push(clean);
  };
  for (const line of patch.replace(/\r\n/g, "\n").split("\n")) {
    const git = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (git) {
      add(git[2]);
      continue;
    }
    const codex = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/);
    if (codex) {
      add(codex[1]);
      continue;
    }
    const plus = line.match(/^\+\+\+ (?:b\/)?(.+)$/);
    if (plus) add(plus[1]);
  }
  return files;
}

function countPatchLines(patch: string, op: "+" | "-"): number {
  const ignored = op === "+" ? "+++" : "---";
  return patch.replace(/\r\n/g, "\n").split("\n").filter((line) => {
    return line.startsWith(op) && !line.startsWith(ignored);
  }).length;
}

function countLogicalLines(text: string): number {
  if (!text) return 0;
  const normalized = text.replace(/\r\n/g, "\n");
  return normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n").length : normalized.split("\n").length;
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
