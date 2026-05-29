/**
 * fleet-hub.ts — in-memory orchestration of worker dispatch + event fan-out (B-line).
 *
 * Holds worker records, owns a WorktreeManager, and broadcasts fleet events over the
 * existing server WebSocket (envelope `{ type: "fleet:event", event }`). v0.80 step-2
 * `dispatch` is a stub: it registers the worker and streams a started/claims/progress
 * sequence so the GUI board lights up end-to-end. In integration it creates a
 * worktree, writes a brief file, and spawns `Lynn worker run --jsonl`.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FleetWorkerEvent, FleetAgentKind, FleetWorkerStatus } from "../../shared/fleet-events.js";
import { annotateChangedFiles, evaluateScope } from "./forbidden-guard.js";
import { spawnWorker, type SpawnWorkerOptions, type WorkerHandle } from "./worker-manager.js";
import { WorktreeManager } from "./worktree-manager.js";

export interface FleetBrief {
  title: string;
  agent: FleetAgentKind | string;
  objective: string;
  owned: string[];
  forbidden: string[];
  centerLocks?: string[];
  testCommands?: string[];
  branch: string;
  worktree: string;
}

export interface FleetWorkerRecord {
  workerId: string;
  agent: string;
  status: FleetWorkerStatus;
  brief: FleetBrief;
  createdAt: string;
  events: FleetWorkerEvent[];
}

export type FleetBroadcast = (msg: unknown) => void;
export type FleetSpawnWorker = (opts: SpawnWorkerOptions, onEvent: (e: FleetWorkerEvent) => void) => WorkerHandle;

export interface FleetHubOptions {
  mode?: "spawn" | "stub";
  runnerCommand?: string;
  runnerArgsPrefix?: string[];
  runnerEnv?: NodeJS.ProcessEnv;
  spawnWorker?: FleetSpawnWorker;
  createWorktree?: boolean;
}

export class FleetHub {
  private workers = new Map<string, FleetWorkerRecord>();
  private handles = new Map<string, WorkerHandle>();
  private seq = 0;
  readonly worktrees: WorktreeManager;
  private readonly mode: "spawn" | "stub";
  private readonly runnerCommand: string;
  private readonly runnerArgsPrefix: string[];
  private readonly runnerEnv: NodeJS.ProcessEnv;
  private readonly spawnWorker: FleetSpawnWorker;
  private readonly createWorktree: boolean;

  constructor(
    private repoRoot: string,
    private broadcast: FleetBroadcast,
    private now: () => string = () => new Date().toISOString(),
    options: FleetHubOptions = {},
  ) {
    this.worktrees = new WorktreeManager(repoRoot);
    this.mode = options.mode ?? "spawn";
    this.runnerCommand = options.runnerCommand || process.env.LYNN_CLI_BIN || "Lynn";
    this.runnerArgsPrefix = options.runnerArgsPrefix || [];
    this.runnerEnv = options.runnerEnv || {};
    this.spawnWorker = options.spawnWorker || spawnWorker;
    this.createWorktree = options.createWorktree ?? true;
  }

  listWorkers(): FleetWorkerRecord[] {
    return [...this.workers.values()];
  }

  getWorker(id: string): FleetWorkerRecord | undefined {
    return this.workers.get(id);
  }

  private emit(workerId: string, event: FleetWorkerEvent): void {
    const rec = this.workers.get(workerId);
    const enriched = {
      ts: this.now(),
      workerId,
      agent: rec?.agent,
      ...event,
    } as FleetWorkerEvent;
    if (rec) {
      rec.events.push(enriched);
      rec.status = statusAfterEvent(rec.status, enriched);
    }
    this.broadcast({ type: "fleet:event", event: enriched });
  }

  async dispatch(brief: FleetBrief): Promise<FleetWorkerRecord> {
    const workerId = `w${++this.seq}`;
    const rec: FleetWorkerRecord = {
      workerId,
      agent: String(brief.agent),
      status: "queued",
      brief,
      createdAt: this.now(),
      events: [],
    };
    this.workers.set(workerId, rec);

    this.emit(workerId, {
      schemaVersion: 1,
      type: "worker.started",
      workerId,
      agent: brief.agent,
      cwd: this.repoRoot,
      worktree: brief.worktree,
      branch: brief.branch,
    });
    this.emit(workerId, {
      type: "worker.claims",
      workerId,
      owned: brief.owned,
      forbidden: brief.forbidden,
      centerLocks: brief.centerLocks ?? [],
    });
    this.emit(workerId, {
      type: "worker.progress",
      workerId,
      message: this.mode === "stub" ? `dispatched to ${brief.agent}; awaiting runner` : `dispatching ${brief.agent} via ${this.runnerCommand}`,
    });
    rec.status = "running";
    if (this.mode !== "stub") {
      void this.startWorker(rec);
    }
    return rec;
  }

  cancel(id: string): boolean {
    const rec = this.workers.get(id);
    if (!rec) return false;
    this.handles.get(id)?.kill();
    rec.status = "cancelled";
    this.emit(id, {
      type: "worker.error",
      workerId: id,
      code: "cancelled",
      message: "cancelled by user",
      recoverable: false,
    });
    return true;
  }

  async fileDiff(id: string, filePath: string): Promise<string | null> {
    const rec = this.workers.get(id);
    if (!rec) return null;
    const worktreePath = resolveFromRepo(this.repoRoot, rec.brief.worktree);
    return this.worktrees.fileDiff(worktreePath, filePath);
  }

  private async startWorker(rec: FleetWorkerRecord): Promise<void> {
    const { brief, workerId, agent } = rec;
    try {
      const worktreePath = resolveFromRepo(this.repoRoot, brief.worktree);
      if (this.createWorktree) {
        this.emit(workerId, { type: "worker.progress", workerId, message: `creating worktree ${brief.worktree}` });
        await this.worktrees.create(brief.worktree, brief.branch);
      }
      const briefPath = await writeFleetBrief(workerId, brief);
      const args = [
        ...this.runnerArgsPrefix,
        "worker",
        "run",
        "--brief",
        briefPath,
        "--worktree",
        worktreePath,
        "--agent",
        agent,
        "--id",
        workerId,
        "--jsonl",
      ];
      this.emit(workerId, { type: "worker.progress", workerId, message: `starting ${this.runnerCommand} ${args.join(" ")}` });
      const handle = this.spawnWorker({
        command: this.runnerCommand,
        args,
        cwd: this.repoRoot,
        workerId,
        env: {
          ...process.env,
          ...this.runnerEnv,
          LYNN_NO_MODEL_DOWNLOADS: "1",
        },
      }, (event) => this.handleWorkerEvent(workerId, event));
      this.handles.set(workerId, handle);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit(workerId, { type: "worker.error", workerId, code: "dispatch_failed", message, recoverable: true });
    }
  }

  private handleWorkerEvent(workerId: string, event: FleetWorkerEvent): void {
    if ((event.type === "worker.started" || event.type === "worker.claims") && hasEvent(this.workers.get(workerId), event.type)) {
      return;
    }
    this.emit(workerId, event);
    if (event.type === "worker.finished" || event.type === "worker.error") {
      this.handles.delete(workerId);
      void this.emitAuthoritativeDiff(workerId);
    }
  }

  private async emitAuthoritativeDiff(workerId: string): Promise<void> {
    const rec = this.workers.get(workerId);
    if (!rec) return;
    try {
      const worktreePath = resolveFromRepo(this.repoRoot, rec.brief.worktree);
      const [paths, stat] = await Promise.all([
        this.worktrees.changedFiles(worktreePath),
        this.worktrees.diffStat(worktreePath),
      ]);
      const changedFiles = annotateChangedFiles(paths.map((p) => ({ path: p })), rec.brief.forbidden, rec.brief.centerLocks ?? []);
      this.emit(workerId, {
        type: "git.diff",
        workerId,
        files: stat.files || changedFiles.length,
        insertions: stat.insertions,
        deletions: stat.deletions,
        changedFiles,
      });
      const scope = evaluateScope(paths, rec.brief.forbidden, rec.brief.centerLocks ?? []);
      for (const file of scope.forbiddenPaths) {
        this.emit(workerId, { type: "worker.violation", workerId, code: "forbidden_file", message: `changed forbidden file ${file}`, path: file, severity: "error" });
      }
      for (const file of scope.centerLockPaths) {
        this.emit(workerId, { type: "worker.violation", workerId, code: "center_lock", message: `changed center-locked file ${file}`, path: file, severity: "error" });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit(workerId, { type: "worker.progress", workerId, level: "warning", message: `diff inspection failed: ${message}` });
    }
  }
}

function resolveFromRepo(repoRoot: string, target: string): string {
  return path.isAbsolute(target) ? target : path.join(repoRoot, target);
}

async function writeFleetBrief(workerId: string, brief: FleetBrief): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `lynn-fleet-${workerId}-`));
  const file = path.join(dir, "brief.md");
  const lines = [
    `# Task: ${brief.title}`,
    "",
    "## Objective",
    brief.objective || brief.title,
    "",
    "## Owned files",
    ...brief.owned.map((p) => `- ${p}`),
    "",
    "## Forbidden files",
    ...brief.forbidden.map((p) => `- ${p}`),
    "",
    "## Test commands",
    ...(brief.testCommands || []).map((cmd) => `- ${cmd}`),
    "",
  ];
  await fs.writeFile(file, lines.join("\n"), "utf8");
  return file;
}

function statusAfterEvent(current: FleetWorkerStatus, event: FleetWorkerEvent): FleetWorkerStatus {
  if (event.type === "worker.finished") return event.ok ? "completed" : "failed";
  if (event.type === "worker.error") return event.code === "cancelled" ? "cancelled" : "failed";
  if (event.type === "worker.violation") return "blocked";
  if (current === "queued" && event.type !== "worker.started") return "running";
  return current;
}

function hasEvent(rec: FleetWorkerRecord | undefined, type: FleetWorkerEvent["type"]): boolean {
  return !!rec?.events.some((event) => event.type === type);
}
