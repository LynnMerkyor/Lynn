import fs from "node:fs/promises";
import path from "node:path";
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
