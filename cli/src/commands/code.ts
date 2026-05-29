import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import readline from "node:readline/promises";
import { stdin as input, stderr as errorOutput } from "node:process";
import { getStringFlag, hasFlag, type ParsedArgs } from "../args.js";
import { streamBrainChat, type BrainStreamEvent } from "../brain-client.js";
import { nowIso, writeJsonLine } from "../jsonl.js";
import { parseReasoningOptions, shouldRenderReasoning } from "../reasoning.js";
import { TerminalSpinner } from "../terminal-spinner.js";
import { CLIENT_TOOL_DEFINITIONS, runClientTool } from "../tools/registry.js";
import type { ClientToolName, ClientToolResult, ToolRunContext } from "../tools/types.js";

const pExecFile = promisify(execFile);

function approval(args: ParsedArgs): "ask" | "on-failure" | "never" | "yolo" {
  const value = getStringFlag(args.flags, "approval");
  if (value === "ask" || value === "on-failure" || value === "never" || value === "yolo") return value;
  return "ask";
}

function cwd(args: ParsedArgs): string {
  return getStringFlag(args.flags, "cwd") || process.cwd();
}

function timeoutMs(args: ParsedArgs): number | undefined {
  const raw = getStringFlag(args.flags, "timeout-ms", "timeout");
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("--timeout-ms must be a positive integer");
  return parsed;
}

function maxSteps(args: ParsedArgs): number {
  const raw = getStringFlag(args.flags, "max-steps", "steps");
  if (!raw) return 8;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 20) throw new Error("--max-steps must be an integer from 1 to 20");
  return parsed;
}

export async function runCode(args: ParsedArgs): Promise<number> {
  const json = hasFlag(args.flags, "json", "jsonl");
  if (hasFlag(args.flags, "list-tools")) {
    const payload = { type: "code.tools", ts: nowIso(), tools: CLIENT_TOOL_DEFINITIONS };
    if (json) writeJsonLine(payload);
    else process.stdout.write(`${CLIENT_TOOL_DEFINITIONS.map((tool) => `${tool.name}${tool.dangerous ? " (approval required)" : ""}: ${tool.description}`).join("\n")}\n`);
    return 0;
  }

  const tool = getStringFlag(args.flags, "tool") as ClientToolName | null;
  if (!tool) {
    const task = args.positionals.join(" ").trim();
    if (task) return runCodeTask(args, task, json);
    const message = "code mode ready; pass a task, --list-tools, or --tool <name>";
    if (json) writeJsonLine({ type: "code.ready", ts: nowIso(), message, cwd: cwd(args) });
    else process.stdout.write(`${message}\n`);
    return 0;
  }

  const toolCwd = cwd(args);
  const toolApproval = await resolveToolApproval({
    tool,
    approval: approval(args),
    cwd: toolCwd,
    json,
    input,
    output: errorOutput,
  });
  const result = await runClientTool(
    { cwd: toolCwd, approval: toolApproval, timeoutMs: timeoutMs(args) },
    {
      name: tool,
      path: getStringFlag(args.flags, "path") || undefined,
      text: getStringFlag(args.flags, "text", "content") || args.positionals.join(" ") || undefined,
      query: getStringFlag(args.flags, "query") || undefined,
      pattern: getStringFlag(args.flags, "pattern") || undefined,
      command: getStringFlag(args.flags, "command") || args.positionals.join(" ") || undefined,
      maxBytes: Number(getStringFlag(args.flags, "max-bytes") || 0) || undefined,
    },
  );
  if (json) writeJsonLine({ type: "code.tool.result", ts: nowIso(), ...result });
  else process.stdout.write(`${JSON.stringify(result.output, null, 2)}\n`);
  return result.ok ? 0 : 1;
}

interface ToolApprovalRequest {
  tool: ClientToolName;
  approval: "ask" | "on-failure" | "never" | "yolo";
  cwd: string;
  json: boolean;
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
}

export function isDangerousClientTool(tool: ClientToolName): boolean {
  return !!CLIENT_TOOL_DEFINITIONS.find((definition) => definition.name === tool)?.dangerous;
}

export function canPromptForDangerousTool(inputStream: Pick<NodeJS.ReadStream, "isTTY">, outputStream: Pick<NodeJS.WriteStream, "isTTY">, json: boolean): boolean {
  return !json && !!inputStream.isTTY && !!outputStream.isTTY;
}

async function resolveToolApproval(request: ToolApprovalRequest): Promise<ToolApprovalRequest["approval"]> {
  if (!isDangerousClientTool(request.tool)) return request.approval;
  if (request.approval === "yolo") return "yolo";
  if (request.approval === "never") {
    throw new Error(`${request.tool} requires approval; current mode is never`);
  }
  if (!canPromptForDangerousTool(request.input, request.output, request.json)) {
    throw new Error(`${request.tool} requires --approval yolo or an interactive confirmation`);
  }
  const rl = readline.createInterface({ input: request.input, output: request.output, terminal: true });
  try {
    const answer = await rl.question(`Allow ${request.tool} in ${request.cwd}? [y/N] `);
    if (/^(y|yes)$/i.test(answer.trim())) return "yolo";
    throw new Error(`${request.tool} cancelled by user`);
  } finally {
    rl.close();
  }
}

interface CodeContext {
  cwd: string;
  gitStatus: string;
  gitDiffStat: string;
  topFiles: string[];
  packageScripts: Record<string, string>;
}

async function runCodeTask(args: ParsedArgs, task: string, json: boolean): Promise<number> {
  const context = await collectCodeContext(cwd(args));
  const reasoning = parseReasoningOptions(args);
  const brainUrl = getStringFlag(args.flags, "brain-url") || process.env.LYNN_BRAIN_URL || "http://127.0.0.1:8790";
  const mockBrain = hasFlag(args.flags, "mock-brain", "mock");
  if (json) writeJsonLine({ type: "code.task.started", ts: nowIso(), task, context });

  if (mockBrain) {
    const text = renderMockCodeTask(task, context);
    if (json) {
      writeJsonLine({ type: "assistant.delta", ts: nowIso(), text });
      writeJsonLine({ type: "code.task.finished", ts: nowIso(), ok: true });
    } else {
      process.stdout.write(`${text}\n`);
    }
    return 0;
  }

  const toolCtx: ToolRunContext = {
    cwd: cwd(args),
    approval: approval(args),
    timeoutMs: timeoutMs(args),
  };
  const final = await runCodeAgentLoop({
    task,
    context,
    brainUrl,
    reasoning,
    json,
    maxSteps: maxSteps(args),
    toolCtx,
    input,
    output: errorOutput,
  });
  if (json) {
    if (final.trim()) writeJsonLine({ type: "assistant.delta", ts: nowIso(), text: final });
    writeJsonLine({ type: "code.task.finished", ts: nowIso(), ok: true, contentReturned: !!final.trim() });
  } else {
    process.stdout.write(final.trim() ? `${final}\n` : "\n");
  }
  return 0;
}

interface CodeAgentLoopInput {
  task: string;
  context: CodeContext;
  brainUrl: string;
  reasoning: ReturnType<typeof parseReasoningOptions>;
  json: boolean;
  maxSteps: number;
  toolCtx: ToolRunContext;
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
}

interface CodeToolRequest {
  tool: ClientToolName;
  args: {
    path?: string;
    text?: string;
    query?: string;
    pattern?: string;
    command?: string;
    maxBytes?: number;
  };
}

async function runCodeAgentLoop(inputData: CodeAgentLoopInput): Promise<string> {
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    {
      role: "system",
      content: [
        "You are Lynn CLI code mode.",
        "You help with repository-level coding tasks from the terminal.",
        "You may request local tools using exactly one JSON object and no prose:",
        '{"tool":"read_file|grep|glob|apply_patch|bash|write_file","args":{...}}',
        "Prefer read_file, grep, and glob before editing. Use apply_patch for edits when possible.",
        "When you are done, answer normally with a concise summary and tests run.",
        "Do not claim you edited files unless a tool actually changed them.",
        "Never download models, datasets, training packs, BF16, or GGUF files to the local Mac.",
      ].join("\n"),
    },
    { role: "user", content: buildCodePrompt(inputData.task, inputData.context) },
  ];
  let finalText = "";
  for (let step = 0; step < inputData.maxSteps; step += 1) {
    const assistantText = await collectBrainText({
      brainUrl: inputData.brainUrl,
      messages,
      reasoning: inputData.reasoning,
      json: inputData.json,
      label: step === 0 ? "Lynn is coding" : "Lynn is reviewing tool output",
    });
    messages.push({ role: "assistant", content: assistantText });
    const toolRequest = parseCodeToolRequest(assistantText);
    if (!toolRequest) {
      finalText = assistantText;
      break;
    }
    if (inputData.json) writeJsonLine({ type: "code.tool.requested", ts: nowIso(), tool: toolRequest.tool, args: redactToolArgs(toolRequest) });
    else process.stderr.write(`\nTool: ${toolRequest.tool}\n`);
    let toolResult: ClientToolResult;
    try {
      const effectiveApproval = await resolveToolApproval({
        tool: toolRequest.tool,
        approval: inputData.toolCtx.approval,
        cwd: inputData.toolCtx.cwd,
        json: inputData.json,
        input: inputData.input,
        output: inputData.output,
      });
      toolResult = await runClientTool({ ...inputData.toolCtx, approval: effectiveApproval }, {
        name: toolRequest.tool,
        ...toolRequest.args,
      });
    } catch (error) {
      toolResult = {
        ok: false,
        tool: toolRequest.tool,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (inputData.json) writeJsonLine({ type: "code.tool.result", ts: nowIso(), ...toolResult });
    else process.stderr.write(`${toolResult.ok ? "ok" : "failed"}: ${toolResult.error || summarizeToolOutput(toolResult.output)}\n`);
    messages.push({ role: "user", content: `Tool result for ${toolRequest.tool}:\n${JSON.stringify(toolResult, null, 2)}\nContinue. If no more tools are needed, give the final answer.` });
  }
  if (!finalText) {
    finalText = "Stopped after the maximum tool steps. Review the emitted tool results before continuing.";
  }
  return finalText;
}

async function collectBrainText(inputData: {
  brainUrl: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  reasoning: ReturnType<typeof parseReasoningOptions>;
  json: boolean;
  label: string;
}): Promise<string> {
  let text = "";
  const spinner = new TerminalSpinner(process.stderr, inputData.label);
  if (!inputData.json) spinner.start();
  try {
    for await (const event of streamBrainChat({
      brainUrl: inputData.brainUrl,
      reasoning: inputData.reasoning,
      messages: inputData.messages,
    })) {
      const renderReasoning = shouldRenderReasoning(inputData.reasoning.display, inputData.json);
      if (event.type === "assistant.delta" || (event.type === "reasoning.delta" && renderReasoning)) {
        spinner.stop();
      }
      if (event.type === "reasoning.delta" && renderReasoning) process.stderr.write(event.text);
      if (event.type === "assistant.delta") text += event.text;
    }
  } finally {
    spinner.stop();
  }
  return text;
}

export function parseCodeToolRequest(text: string): CodeToolRequest | null {
  for (const candidate of extractJsonCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate) as { tool?: unknown; args?: unknown };
      if (typeof parsed.tool !== "string") continue;
      if (!CLIENT_TOOL_DEFINITIONS.some((definition) => definition.name === parsed.tool)) continue;
      const args = parsed.args && typeof parsed.args === "object" && !Array.isArray(parsed.args)
        ? parsed.args as Record<string, unknown>
        : {};
      return {
        tool: parsed.tool as ClientToolName,
        args: {
          path: stringArg(args.path),
          text: stringArg(args.text ?? args.content ?? args.patch),
          query: stringArg(args.query),
          pattern: stringArg(args.pattern),
          command: stringArg(args.command),
          maxBytes: numberArg(args.maxBytes ?? args.max_bytes),
        },
      };
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function extractJsonCandidates(text: string): string[] {
  const out: string[] = [];
  const fence = text.match(/```(?:json|lynn-tool|tool)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) out.push(fence[1].trim());
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) out.push(trimmed);
  const start = text.indexOf("{");
  if (start >= 0) {
    let depth = 0;
    for (let i = start; i < text.length; i += 1) {
      const char = text[i];
      if (char === "{") depth += 1;
      if (char === "}") depth -= 1;
      if (depth === 0) {
        out.push(text.slice(start, i + 1));
        break;
      }
    }
  }
  return [...new Set(out)];
}

function stringArg(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberArg(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function redactToolArgs(request: CodeToolRequest): Record<string, unknown> {
  const args = { ...request.args } as Record<string, unknown>;
  for (const key of ["text", "command"]) {
    if (typeof args[key] === "string" && args[key].length > 500) {
      args[key] = `${args[key].slice(0, 500)}...`;
    }
  }
  return args;
}

function summarizeToolOutput(output: unknown): string {
  const text = typeof output === "string" ? output : JSON.stringify(output);
  if (!text) return "(no output)";
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}

async function collectCodeContext(repoCwd: string): Promise<CodeContext> {
  const [gitStatus, gitDiffStat, topFiles, packageScripts] = await Promise.all([
    runGit(["status", "--short"], repoCwd),
    runGit(["diff", "--stat"], repoCwd),
    listTopFiles(repoCwd),
    readPackageScripts(repoCwd),
  ]);
  return { cwd: repoCwd, gitStatus, gitDiffStat, topFiles, packageScripts };
}

async function runGit(args: string[], repoCwd: string): Promise<string> {
  try {
    const { stdout } = await pExecFile("git", args, { cwd: repoCwd, maxBuffer: 256 * 1024 });
    return stdout.trim();
  } catch {
    return "";
  }
}

async function listTopFiles(repoCwd: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(repoCwd, { withFileTypes: true });
    return entries
      .filter((entry) => !entry.name.startsWith(".") && !["node_modules", "dist", "dist-renderer", "dist-server-bundle"].includes(entry.name))
      .slice(0, 80)
      .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`);
  } catch {
    return [];
  }
}

async function readPackageScripts(repoCwd: string): Promise<Record<string, string>> {
  try {
    const text = await fs.readFile(path.join(repoCwd, "package.json"), "utf8");
    const parsed = JSON.parse(text) as { scripts?: Record<string, string> };
    return parsed.scripts || {};
  } catch {
    return {};
  }
}

function buildCodePrompt(task: string, context: CodeContext): string {
  const scripts = Object.entries(context.packageScripts)
    .slice(0, 20)
    .map(([name, command]) => `- ${name}: ${command}`)
    .join("\n") || "(none)";
  return [
    `Task: ${task}`,
    "",
    `CWD: ${context.cwd}`,
    "",
    "Git status:",
    context.gitStatus || "(clean)",
    "",
    "Git diff stat:",
    context.gitDiffStat || "(none)",
    "",
    "Top-level files:",
    context.topFiles.join("\n") || "(unavailable)",
    "",
    "Package scripts:",
    scripts,
  ].join("\n");
}

function renderMockCodeTask(task: string, context: CodeContext): string {
  return [
    `Mock Lynn code task: ${task}`,
    `CWD: ${context.cwd}`,
    `Git: ${context.gitStatus ? "dirty" : "clean"}`,
    `Files: ${context.topFiles.slice(0, 8).join(", ") || "(none)"}`,
  ].join("\n");
}

function handleCodeBrainEvent(event: BrainStreamEvent, opts: { json: boolean; renderReasoning: boolean }): void {
  if (opts.json) {
    if (event.type === "assistant.delta" || event.type === "reasoning.delta") {
      writeJsonLine({ ...event, ts: nowIso() });
    } else if (event.type === "usage") {
      writeJsonLine({ type: "usage", ts: nowIso(), usage: event.usage });
    }
    return;
  }

  if (event.type === "assistant.delta") {
    process.stdout.write(event.text);
  } else if (event.type === "reasoning.delta" && opts.renderReasoning) {
    process.stderr.write(event.text);
  }
}
