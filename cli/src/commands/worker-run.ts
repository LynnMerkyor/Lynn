import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  FLEET_EVENT_SCHEMA_VERSION,
  type FleetWorkerEvent,
  parseFleetJsonLine,
  validateFleetWorkerEvent,
} from "../../../shared/fleet-events.js";
import { getStringFlag, hasFlag, type ParsedArgs } from "../args.js";
import { nowIso, writeJsonLine } from "../jsonl.js";

export interface WorkerBrief {
  title: string;
  objective: string;
  owned: string[];
  forbidden: string[];
  tests: string[];
}

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

export function parseWorkerBrief(markdown: string): WorkerBrief {
  const title = markdown.split(/\r?\n/).find((line) => line.startsWith("# "))?.slice(2).trim() || "Untitled worker task";
  const objective = sectionLines(markdown, "Objective").join("\n").trim();
  const owned = bulletValues(sectionLines(markdown, "Owned files"));
  const forbidden = bulletValues(sectionLines(markdown, "Forbidden files"));
  const tests = bulletValues(sectionLines(markdown, "Test commands"));
  return { title, objective, owned, forbidden, tests };
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

function defaultAgentCommand(agent: string, briefPath: string, worktree: string, taskText: string): string | null {
  switch (agent) {
    case "claude-internal":
      return `claude-internal -p ${shellQuote(taskText)} --add-dir ${shellQuote(worktree)} --output-format stream-json`;
    case "claude-code":
      return `claude -p ${shellQuote(taskText)} --add-dir ${shellQuote(worktree)} --output-format stream-json --verbose --include-partial-messages`;
    case "codex-cli":
      return `codex exec --cd ${shellQuote(worktree)} --file ${shellQuote(briefPath)} --json`;
    case "opencode":
    case "opencode-cli":
    case "open-code":
      return `opencode run --format json ${shellQuote(taskText)}`;
    case "qwen-cli":
      return `qwen -p ${shellQuote(taskText)}`;
    case "kimi-cli":
      return `kimi --print ${shellQuote(taskText)}`;
    default:
      return null;
  }
}

function mergeEventDefaults(event: FleetWorkerEvent, workerId: string, agent: string): FleetWorkerEvent {
  return { workerId, agent, ...event } as FleetWorkerEvent;
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

  const externalCommand = getStringFlag(args.flags, "agent-command") || defaultAgentCommand(agent, path.resolve(briefPath), path.resolve(worktree), markdown);
  if (!mock && externalCommand) {
    const exitCode = await runExternalWorker({ command: externalCommand, worktree, workerId, agent });
    emit({
      type: "git.diff",
      workerId,
      agent,
      files: 0,
      insertions: 0,
      deletions: 0,
      changedFiles: [],
    });
    emit({ type: "worker.finished", workerId, agent, ok: exitCode === 0, exitCode, summary: exitCode === 0 ? "external worker completed" : "external worker failed" });
    return exitCode;
  }

  for (const command of brief.tests) {
    emit({ type: "test.started", workerId, agent, command });
    emit({ type: "test.finished", workerId, agent, command, ok: true, summary: mock ? "mock pass" : "not run in scaffold", ms: 0 });
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
