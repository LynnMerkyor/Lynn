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
import type { ClientToolName } from "../tools/types.js";

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

  let sawContent = false;
  const spinner = new TerminalSpinner(process.stderr, "Lynn is reviewing");
  if (!json) spinner.start();
  try {
    for await (const event of streamBrainChat({
      brainUrl,
      reasoning,
      messages: [
        {
          role: "system",
          content: [
            "You are Lynn CLI code mode.",
            "You help with repository-level coding tasks from the terminal.",
            "Be concise, name files precisely, and suggest exact commands.",
            "Do not claim you edited files unless a tool actually changed them.",
            "Never download models, datasets, training packs, BF16, or GGUF files to the local Mac.",
          ].join("\n"),
        },
        { role: "user", content: buildCodePrompt(task, context) },
      ],
    })) {
      const renderReasoning = shouldRenderReasoning(reasoning.display, json);
      if (event.type === "assistant.delta" || (event.type === "reasoning.delta" && renderReasoning)) {
        spinner.stop();
      }
      handleCodeBrainEvent(event, {
        json,
        renderReasoning,
      });
      if (event.type === "assistant.delta") sawContent = true;
    }
  } finally {
    spinner.stop();
  }
  if (json) writeJsonLine({ type: "code.task.finished", ts: nowIso(), ok: true, contentReturned: sawContent });
  else process.stdout.write("\n");
  return 0;
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
