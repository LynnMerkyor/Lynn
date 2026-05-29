import fs from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  FLEET_EVENT_SCHEMA_VERSION,
  type FleetChangedFile,
  type FleetVisualBox,
  type FleetWorkerEvent,
  parseFleetJsonLine,
  validateFleetWorkerEvent,
} from "../../../shared/fleet-events.js";
import { getStringFlag, hasFlag, type ParsedArgs } from "../args.js";
import { streamBrainChat } from "../brain-client.js";
import { buildImageContentParts } from "../media.js";
import { parseReasoningOptions } from "../reasoning.js";
import { runCode } from "./code.js";
import { buildVisionPrompt, type VisionCommand } from "./vision.js";
import { nowIso, writeJsonLine } from "../jsonl.js";
import { resolveCliProviderProfile } from "../provider-profile.js";

export interface WorkerBrief {
  title: string;
  objective: string;
  owned: string[];
  forbidden: string[];
  tests: string[];
  taskType: "code" | VisionCommand;
  image?: string;
  resumePath?: string;
}

export function extractGroundingBoxes(text: string): FleetVisualBox[] {
  const candidates = [
    ...Array.from(text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi), (match) => match[1] || ""),
    text,
  ];
  for (const candidate of candidates) {
    const raw = firstJsonObject(candidate);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const x = asNumber(parsed.x);
      const y = asNumber(parsed.y);
      if (x === null || y === null) continue;
      const width = asNumber(parsed.width ?? parsed.w);
      const height = asNumber(parsed.height ?? parsed.h);
      const confidence = asNumber(parsed.confidence ?? parsed.conf);
      return [{
        label: typeof parsed.label === "string" ? parsed.label : typeof parsed.reason === "string" ? parsed.reason : "target",
        x: clamp01(x),
        y: clamp01(y),
        ...(width === null ? {} : { width: clamp01(width) }),
        ...(height === null ? {} : { height: clamp01(height) }),
        ...(confidence === null ? {} : { confidence: clamp01(confidence) }),
      }];
    } catch {
      // Try the next candidate.
    }
  }
  return [];
}

function firstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function asNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export interface WorkerDiffSummary {
  files: number;
  insertions: number;
  deletions: number;
  changedFiles: FleetChangedFile[];
}

const execFileAsync = promisify(execFile);

function sectionLines(markdown: string, title: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `## ${title}`.toLowerCase());
  if (start < 0) return [];
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] || "";
    if (/^##\s+/.test(line)) break;
    out.push(line);
  }
  return out;
}

function bulletValues(lines: readonly string[]): string[] {
  return lines
    .map((line) => line.trim().match(/^[-*]\s+(.*)$/)?.[1]?.trim() || "")
    .filter(Boolean);
}

function firstSectionValue(markdown: string, title: string): string {
  return sectionLines(markdown, title)
    .map((line) => line.trim().replace(/^[-*]\s+/, ""))
    .filter(Boolean)[0] || "";
}

function normalizeTaskType(raw: string): WorkerBrief["taskType"] {
  const value = raw.trim().toLowerCase();
  if (value === "see" || value === "ground" || value === "ui2code") return value;
  return "code";
}

export function parseWorkerBrief(markdown: string): WorkerBrief {
  const title = markdown.split(/\r?\n/).find((line) => line.startsWith("# "))?.slice(2).trim() || "Untitled worker task";
  const objective = sectionLines(markdown, "Objective").join("\n").trim();
  const owned = bulletValues(sectionLines(markdown, "Owned files"));
  const forbidden = bulletValues(sectionLines(markdown, "Forbidden files"));
  const tests = bulletValues(sectionLines(markdown, "Test commands"));
  const taskType = normalizeTaskType(firstSectionValue(markdown, "Task Type") || firstSectionValue(markdown, "Type"));
  const image = firstSectionValue(markdown, "Image") || firstSectionValue(markdown, "Screenshot") || undefined;
  const resumePath = firstSectionValue(markdown, "Resume") || firstSectionValue(markdown, "Session") || undefined;
  return { title, objective, owned, forbidden, tests, taskType, image, resumePath };
}

function emit(event: FleetWorkerEvent): void {
  const enriched = { schemaVersion: FLEET_EVENT_SCHEMA_VERSION, ts: nowIso(), ...event } as FleetWorkerEvent;
  const validation = validateFleetWorkerEvent(enriched);
  if (!validation.ok) {
    throw new Error(validation.errors.join("; "));
  }
  writeJsonLine(enriched);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

const WORKER_GUARDRAIL = [
  "You are running as a Lynn Fleet worker.",
  "Follow the task brief exactly and keep all edits inside the assigned worktree and owned files.",
  "Do not download model weights, BF16/GGUF files, datasets, training packages, or large binary artifacts to this Mac.",
  "Report progress concisely; Lynn will inspect git diff, tests, and scope after you finish.",
].join("\n");

export function buildWorkerPrompt(taskText: string): string {
  return `${WORKER_GUARDRAIL}\n\n${taskText}`;
}

export function buildDefaultAgentCommand(agent: string, briefPath: string, worktree: string, taskText: string): string | null {
  const prompt = buildWorkerPrompt(taskText);
  switch (agent) {
    case "claude-internal":
      return [
        "claude-internal",
        "-p",
        shellQuote(prompt),
        "--add-dir",
        shellQuote(worktree),
        "--output-format stream-json",
        "--include-partial-messages",
        "--permission-mode bypassPermissions",
      ].join(" ");
    case "claude-code":
      return [
        "claude",
        "-p",
        shellQuote(prompt),
        "--add-dir",
        shellQuote(worktree),
        "--output-format stream-json",
        "--verbose",
        "--include-partial-messages",
        "--dangerously-skip-permissions",
      ].join(" ");
    case "codex-cli":
      return [
        "codex exec",
        "--cd",
        shellQuote(worktree),
        "--json",
        "--dangerously-bypass-approvals-and-sandbox",
        shellQuote(prompt),
      ].join(" ");
    case "opencode":
    case "opencode-cli":
    case "open-code":
      return `opencode run --format json --cwd ${shellQuote(worktree)} ${shellQuote(prompt)}`;
    case "qwen-cli":
      return [
        "qwen",
        "-p",
        shellQuote(prompt),
        "--add-dir",
        shellQuote(worktree),
        "--output-format stream-json",
        "--include-partial-messages",
        "--approval-mode yolo",
        "--yolo",
      ].join(" ");
    case "kimi-cli":
      return [
        "kimi",
        "--work-dir",
        shellQuote(worktree),
        "--print",
        "--output-format stream-json",
        "--yolo",
        "--afk",
        "-p",
        shellQuote(prompt),
      ].join(" ");
    default:
      return null;
  }
}

function mergeEventDefaults(event: FleetWorkerEvent, workerId: string, agent: string): FleetWorkerEvent {
  return { workerId, agent, ...event } as FleetWorkerEvent;
}

function actionFromStatus(code: string): FleetChangedFile["action"] {
  if (code.includes("R")) return "rename";
  if (code.includes("D")) return "delete";
  if (code.includes("A") || code.includes("?")) return "add";
  return "edit";
}

function parseStatusPath(raw: string): string {
  const pathPart = raw.slice(3).trim();
  const renameTarget = pathPart.split(" -> ").pop();
  return renameTarget || pathPart;
}

function parseNumstat(raw: string): Map<string, { insertions: number; deletions: number }> {
  const out = new Map<string, { insertions: number; deletions: number }>();
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [insertionsRaw, deletionsRaw, ...pathParts] = line.split(/\t/);
    const filePath = pathParts.join("\t").trim();
    if (!filePath) continue;
    const insertions = Number.parseInt(insertionsRaw || "0", 10);
    const deletions = Number.parseInt(deletionsRaw || "0", 10);
    out.set(filePath, {
      insertions: Number.isFinite(insertions) ? insertions : 0,
      deletions: Number.isFinite(deletions) ? deletions : 0,
    });
  }
  return out;
}

async function gitOutput(worktree: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", worktree, ...args], { maxBuffer: 10 * 1024 * 1024 });
  return String(stdout);
}

export async function collectGitDiff(worktree: string): Promise<WorkerDiffSummary> {
  const [statusRaw, unstagedNumstatRaw, stagedNumstatRaw] = await Promise.all([
    gitOutput(worktree, ["status", "--porcelain=v1"]),
    gitOutput(worktree, ["diff", "--numstat"]),
    gitOutput(worktree, ["diff", "--cached", "--numstat"]),
  ]);
  const numstat = new Map([...parseNumstat(unstagedNumstatRaw), ...parseNumstat(stagedNumstatRaw)]);
  const changedFiles: FleetChangedFile[] = [];
  for (const line of statusRaw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2);
    const filePath = parseStatusPath(line);
    const stats = numstat.get(filePath) || { insertions: 0, deletions: 0 };
    changedFiles.push({
      path: filePath,
      action: actionFromStatus(code),
      insertions: stats.insertions,
      deletions: stats.deletions,
    });
  }
  return {
    files: changedFiles.length,
    insertions: changedFiles.reduce((sum, file) => sum + (file.insertions || 0), 0),
    deletions: changedFiles.reduce((sum, file) => sum + (file.deletions || 0), 0),
    changedFiles,
  };
}

async function emitGitDiff(workerId: string, agent: string, worktree: string): Promise<void> {
  try {
    emit({ type: "git.diff", workerId, agent, ...(await collectGitDiff(worktree)) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit({ type: "worker.progress", workerId, agent, level: "warning", message: `git diff inspection failed: ${message}` });
    emit({ type: "git.diff", workerId, agent, files: 0, insertions: 0, deletions: 0, changedFiles: [] });
  }
}

async function runExternalWorker(input: {
  command: string;
  worktree: string;
  workerId: string;
  agent: string;
}): Promise<number> {
  emit({ type: "shell.started", workerId: input.workerId, agent: input.agent, command: input.command, approval: "auto" });
  const child = spawn(input.command, {
    cwd: input.worktree,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      LYNN_WORKER_ID: input.workerId,
      LYNN_WORKER_AGENT: input.agent,
      LYNN_NO_MODEL_DOWNLOADS: "1",
    },
  });

  const started = Date.now();
  const handleLine = (line: string, stream: "stdout" | "stderr"): void => {
    if (!line.trim()) return;
    const parsed = parseFleetJsonLine(line);
    if (parsed.ok && parsed.event) {
      emit(mergeEventDefaults(parsed.event, input.workerId, input.agent));
    } else {
      emit({ type: "worker.progress", workerId: input.workerId, agent: input.agent, message: line, level: stream === "stderr" ? "warning" : "info" });
    }
  };

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
    const lines = stdout.split(/\r?\n/);
    stdout = lines.pop() || "";
    lines.forEach((line) => handleLine(line, "stdout"));
  });
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
    const lines = stderr.split(/\r?\n/);
    stderr = lines.pop() || "";
    lines.forEach((line) => handleLine(line, "stderr"));
  });

  const exitCode = await new Promise<number>((resolve) => {
    child.on("close", (code) => resolve(code ?? 1));
  });
  handleLine(stdout, "stdout");
  handleLine(stderr, "stderr");
  const ok = exitCode === 0;
  emit({ type: "shell.finished", workerId: input.workerId, agent: input.agent, command: input.command, ok, exitCode, ms: Date.now() - started });
  if (!ok) {
    emit({ type: "worker.error", workerId: input.workerId, agent: input.agent, code: "worker_exit_nonzero", message: `worker exited with ${exitCode}`, recoverable: true });
  }
  return exitCode;
}

function buildLynnCodeWorkerTask(brief: WorkerBrief): string {
  return [
    `Fleet task: ${brief.title}`,
    "",
    "Task type:",
    brief.taskType,
    "",
    ...(brief.image ? ["Image:", brief.image, ""] : []),
    "Objective:",
    brief.objective || brief.title,
    "",
    "Owned files:",
    ...(brief.owned.length ? brief.owned.map((p) => `- ${p}`) : ["- (not specified)"]),
    "",
    "Forbidden files:",
    ...(brief.forbidden.length ? brief.forbidden.map((p) => `- ${p}`) : ["- (none)"]),
    "",
    "Test commands expected by the task:",
    ...(brief.tests.length ? brief.tests.map((cmd) => `- ${cmd}`) : ["- (not specified)"]),
    "",
    "Stay inside the owned files. Do not touch forbidden files. Prefer apply_patch for edits.",
  ].join("\n");
}

function isBuiltInLynnWorker(agent: string): boolean {
  return agent === "lynn-cli" || agent === "mimo-vl" || agent === "mimo-pro" || agent === "mimo-fast" || agent === "stepfun-flash";
}

function isVisionTask(taskType: WorkerBrief["taskType"]): taskType is VisionCommand {
  return taskType === "see" || taskType === "ground" || taskType === "ui2code";
}

export function workerProfileDefaults(agent: string): { reasoning?: "off" | "high" | "xhigh"; maxSteps?: string } {
  if (agent === "mimo-fast") return { reasoning: "off", maxSteps: "6" };
  if (agent === "mimo-pro") return { reasoning: "high", maxSteps: "20" };
  if (agent === "mimo-vl") return { reasoning: "high" };
  return {};
}

async function runLynnCliWorker(input: {
  args: ParsedArgs;
  brief: WorkerBrief;
  worktree: string;
  workerId: string;
  agent: string;
}): Promise<number> {
  const task = buildLynnCodeWorkerTask(input.brief);
  emit({ type: "shell.started", workerId: input.workerId, agent: input.agent, command: "Lynn code", approval: "auto" });
  const started = Date.now();
  const profileDefaults = workerProfileDefaults(input.agent);
  const flags: Record<string, string | boolean> = {
    cwd: input.worktree,
    approval: getStringFlag(input.args.flags, "approval") || "yolo",
    "max-steps": getStringFlag(input.args.flags, "max-steps", "steps") || profileDefaults.maxSteps || "8",
    json: true,
  };
  const brainUrl = getStringFlag(input.args.flags, "brain-url");
  if (brainUrl) flags["brain-url"] = brainUrl;
  const reasoning = getStringFlag(input.args.flags, "reasoning") || profileDefaults.reasoning;
  if (reasoning) flags.reasoning = reasoning;
  const showReasoning = getStringFlag(input.args.flags, "show-reasoning");
  if (showReasoning) flags["show-reasoning"] = showReasoning;
  if (input.brief.resumePath) {
    flags.resume = path.isAbsolute(input.brief.resumePath)
      ? input.brief.resumePath
      : path.resolve(input.worktree, input.brief.resumePath);
  }
  const preset = workerProviderPreset(input.agent);
  if (preset && !getStringFlag(input.args.flags, "preset") && !getStringFlag(input.args.flags, "base-url", "api-base") && !getStringFlag(input.args.flags, "model")) {
    flags.preset = preset;
  }
  copyProviderFlags(input.args.flags, flags);
  const exitCode = await runCode({ command: "code", positionals: [task], flags });
  const ok = exitCode === 0;
  emit({ type: "shell.finished", workerId: input.workerId, agent: input.agent, command: "Lynn code", ok, exitCode, ms: Date.now() - started });
  if (!ok) {
    emit({ type: "worker.error", workerId: input.workerId, agent: input.agent, code: "worker_exit_nonzero", message: `lynn-cli worker exited with ${exitCode}`, recoverable: true });
  }
  return exitCode;
}

export function workerProviderPreset(agent: string): string | null {
  if (agent === "stepfun-flash") return "stepfun";
  return null;
}

async function runLynnVisionWorker(input: {
  args: ParsedArgs;
  brief: WorkerBrief;
  worktree: string;
  workerId: string;
  agent: string;
}): Promise<number> {
  if (!isVisionTask(input.brief.taskType)) return runLynnCliWorker(input);
  if (!input.brief.image) {
    emit({
      type: "worker.error",
      workerId: input.workerId,
      agent: input.agent,
      code: "vision_image_missing",
      message: "MiMo vision worker requires an Image section in the brief",
      recoverable: true,
    });
    return 2;
  }

  const imagePath = path.isAbsolute(input.brief.image) ? input.brief.image : path.resolve(input.worktree, input.brief.image);
  const prompt = buildVisionPrompt(input.brief.taskType, input.brief.objective || input.brief.title);
  const content = await buildImageContentParts(imagePath, prompt);
  const brainUrl = getStringFlag(input.args.flags, "brain-url") || process.env.LYNN_BRAIN_URL || "http://127.0.0.1:8790";
  const profileDefaults = workerProfileDefaults(input.agent);
  const reasoning = parseReasoningOptions({
    ...input.args,
    flags: {
      ...input.args.flags,
      ...(getStringFlag(input.args.flags, "reasoning") ? {} : profileDefaults.reasoning ? { reasoning: profileDefaults.reasoning } : {}),
    },
  });
  const cliProvider = await resolveCliProviderProfile(input.args);
  emit({ type: "shell.started", workerId: input.workerId, agent: input.agent, command: `Lynn ${input.brief.taskType}`, approval: "auto" });
  const started = Date.now();
  let assistantText = "";
  try {
    for await (const event of streamBrainChat({
      brainUrl,
      reasoning,
      messages: [{ role: "user", content }],
      fallbackProvider: cliProvider?.profile,
    })) {
      if (event.type === "assistant.delta") {
        assistantText += event.text;
        emit({ type: "assistant.delta", workerId: input.workerId, agent: input.agent, text: event.text });
      }
      else if (event.type === "reasoning.delta") emit({ type: "reasoning.delta", workerId: input.workerId, agent: input.agent, text: event.text, hidden: event.hidden });
      else if (event.type === "provider") emit({ type: "worker.progress", workerId: input.workerId, agent: input.agent, message: `provider: ${event.activeProvider}`, data: event });
      else if (event.type === "tool_progress") emit({ type: "worker.progress", workerId: input.workerId, agent: input.agent, message: `${event.name}: ${event.event}`, data: event });
      else if (event.type === "usage") emit({ type: "worker.progress", workerId: input.workerId, agent: input.agent, message: "usage", data: usageWithDuration(event.usage, Date.now() - started) });
      else if (event.type === "brain.error") throw new Error(event.code ? `${event.error} (${event.code})` : event.error);
    }
    emit({
      type: "worker.visual_result",
      workerId: input.workerId,
      agent: input.agent,
      taskType: input.brief.taskType,
      image: input.brief.image,
      summary: assistantText.trim() || "MiMo vision worker completed without visible text.",
      ...(input.brief.taskType === "ground" ? { boxes: extractGroundingBoxes(assistantText) } : {}),
    });
    emit({ type: "shell.finished", workerId: input.workerId, agent: input.agent, command: `Lynn ${input.brief.taskType}`, ok: true, exitCode: 0, ms: Date.now() - started });
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit({ type: "worker.error", workerId: input.workerId, agent: input.agent, code: "vision_worker_failed", message, recoverable: true });
    emit({ type: "shell.finished", workerId: input.workerId, agent: input.agent, command: `Lynn ${input.brief.taskType}`, ok: false, exitCode: 1, ms: Date.now() - started });
    return 1;
  }
}

function copyProviderFlags(from: Record<string, string | boolean>, to: Record<string, string | boolean>): void {
  for (const key of ["provider", "preset", "base-url", "api-base", "api-key", "model", "data-dir"]) {
    const value = from[key];
    if (typeof value === "string" && value) to[key] = value;
  }
}

function usageWithDuration(usage: unknown, durationMs: number): unknown {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return { duration_ms: durationMs };
  return { ...(usage as Record<string, unknown>), duration_ms: durationMs };
}

export async function runWorker(args: ParsedArgs): Promise<number> {
  const subcommand = args.positionals[0] || "";
  if (subcommand && subcommand !== "run") {
    throw new Error(`unsupported worker command: ${subcommand}`);
  }

  const briefPath = getStringFlag(args.flags, "brief", "task");
  const worktree = getStringFlag(args.flags, "worktree") || process.cwd();
  const workerId = getStringFlag(args.flags, "id") || `worker-${Date.now()}`;
  const agent = getStringFlag(args.flags, "agent") || "lynn-cli";
  const branch = path.basename(worktree) || "worker";
  const mock = hasFlag(args.flags, "mock");

  if (!briefPath) throw new Error("--brief is required");
  const markdown = await fs.readFile(briefPath, "utf8");
  const brief = parseWorkerBrief(markdown);

  emit({
    type: "worker.started",
    workerId,
    agent,
    cwd: process.cwd(),
    worktree,
    branch,
    pid: process.pid,
  });
  emit({ type: "worker.claims", workerId, agent, owned: brief.owned, forbidden: brief.forbidden });
  emit({ type: "worker.progress", workerId, agent, message: mock ? `Mock worker loaded: ${brief.title}` : `Worker loaded: ${brief.title}` });

  const externalCommand = getStringFlag(args.flags, "agent-command") || buildDefaultAgentCommand(agent, path.resolve(briefPath), path.resolve(worktree), markdown);
  if (!mock && isBuiltInLynnWorker(agent)) {
    const exitCode = isVisionTask(brief.taskType)
      ? await runLynnVisionWorker({ args, brief, worktree, workerId, agent })
      : await runLynnCliWorker({ args, brief, worktree, workerId, agent });
    await emitGitDiff(workerId, agent, worktree);
    emit({ type: "worker.finished", workerId, agent, ok: exitCode === 0, exitCode, summary: exitCode === 0 ? "lynn-cli worker completed" : "lynn-cli worker failed" });
    return exitCode;
  }
  if (!mock && externalCommand) {
    const exitCode = await runExternalWorker({ command: externalCommand, worktree, workerId, agent });
    await emitGitDiff(workerId, agent, worktree);
    emit({ type: "worker.finished", workerId, agent, ok: exitCode === 0, exitCode, summary: exitCode === 0 ? "external worker completed" : "external worker failed" });
    return exitCode;
  }

  for (const command of brief.tests) {
    emit({ type: "test.started", workerId, agent, command });
    emit({ type: "test.finished", workerId, agent, command, ok: true, summary: mock ? "mock pass" : "not run in scaffold", ms: 0 });
  }

  if (mock && isVisionTask(brief.taskType)) {
    emit({
      type: "worker.visual_result",
      workerId,
      agent,
      taskType: brief.taskType,
      image: brief.image,
      summary: `mock ${brief.taskType} result for ${brief.image || "image"}`,
    });
  }

  emit({
    type: "git.diff",
    workerId,
    agent,
    files: 0,
    insertions: 0,
    deletions: 0,
    changedFiles: [],
  });
  emit({ type: "worker.finished", workerId, agent, ok: true, exitCode: 0, summary: mock ? "mock worker completed" : "worker scaffold completed" });
  return 0;
}

export function parseWorkerEventLine(line: string): ReturnType<typeof parseFleetJsonLine> {
  return parseFleetJsonLine(line);
}
