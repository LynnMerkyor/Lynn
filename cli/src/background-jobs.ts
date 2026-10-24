/**
 * background-jobs.ts — long commands that outlive one tool call.
 *
 * A coding agent that kills `npm test` at 120 seconds is not usable on real
 * repositories. A command started in the background keeps its own log file and
 * reports back through the loop as a `<task-notification>` on a later step, so
 * the model can keep working instead of polling.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stopProcessTree } from "./process-tree.js";

export interface BackgroundJob {
  id: string;
  command: string;
  cwd: string;
  logPath: string;
  startedAt: number;
  finishedAt?: number;
  done: boolean;
  exitCode: number | null;
  signal: string | null;
  error?: string;
}

export interface CompletedJob {
  job: BackgroundJob;
  tail: string;
}

const jobs = new Map<string, BackgroundJob>();
const children = new Map<string, ChildProcess>();
let sequence = 0;

export function jobsRoot(): string {
  return process.env.LYNN_CLI_JOBS_DIR?.trim() || path.join(process.env.LYNN_DATA_DIR?.trim() || process.env.LYNN_HOME?.trim() || path.join(os.homedir(), ".lynn"), "cli-jobs");
}

export function newBackgroundJobId(): string {
  return `bg-${Date.now().toString(36)}-${(sequence += 1)}`;
}

export function backgroundLogPath(id: string, runId?: string): string {
  const dir = path.join(jobsRoot(), safeSegment(runId || "run"));
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${id}.log`);
}

/**
 * Take over a child that is already running (the bash timeout path): keep its
 * output file and report completion through the normal notification drain.
 */
export function adoptBackgroundChild(input: {
  id: string;
  command: string;
  cwd: string;
  logPath: string;
  child: ChildProcess;
}): BackgroundJob {
  const job: BackgroundJob = {
    id: input.id,
    command: input.command,
    cwd: input.cwd,
    logPath: input.logPath,
    startedAt: Date.now(),
    done: false,
    exitCode: null,
    signal: null,
  };
  jobs.set(job.id, job);
  children.set(job.id, input.child);
  input.child.on("exit", (code, signal) => {
    job.done = true;
    job.exitCode = code;
    job.signal = signal;
    job.finishedAt = Date.now();
    children.delete(job.id);
  });
  input.child.on("error", (error) => {
    job.done = true;
    job.exitCode = -1;
    job.error = error.message;
    job.finishedAt = Date.now();
    children.delete(job.id);
  });
  return job;
}

export function startBackgroundJob(input: { command: string; cwd: string; runId?: string; argv?: { file: string; args: string[] } }): BackgroundJob {
  if (!input.command.trim()) throw new Error("background command is empty");
  const id = `bg-${Date.now().toString(36)}-${(sequence += 1)}`;
  const dir = path.join(jobsRoot(), safeSegment(input.runId || "run"));
  fs.mkdirSync(dir, { recursive: true });
  const logPath = path.join(dir, `${id}.log`);
  const fd = fs.openSync(logPath, "a");
  let child: ChildProcess;
  try {
    child = input.argv
      ? spawn(input.argv.file, input.argv.args, {
        cwd: input.cwd,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", fd, fd],
        windowsHide: true,
      })
      : spawn(input.command, {
        cwd: input.cwd,
        shell: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", fd, fd],
        windowsHide: true,
      });
  } finally {
    fs.closeSync(fd);
  }

  const job: BackgroundJob = {
    id,
    command: input.command,
    cwd: input.cwd,
    logPath,
    startedAt: Date.now(),
    done: false,
    exitCode: null,
    signal: null,
  };
  jobs.set(id, job);
  children.set(id, child);
  child.on("exit", (code, signal) => {
    job.done = true;
    job.exitCode = code;
    job.signal = signal;
    job.finishedAt = Date.now();
    children.delete(id);
  });
  child.on("error", (error) => {
    job.done = true;
    job.exitCode = -1;
    job.error = error.message;
    job.finishedAt = Date.now();
    children.delete(id);
  });
  child.unref();
  return job;
}

/** Completed jobs, removed from the registry after this call. */
export async function drainCompletedJobs(): Promise<CompletedJob[]> {
  const completed: CompletedJob[] = [];
  for (const [id, job] of [...jobs.entries()]) {
    if (!job.done) continue;
    jobs.delete(id);
    completed.push({ job, tail: await tailLog(job.logPath) });
  }
  return completed;
}

export function listBackgroundJobs(): BackgroundJob[] {
  return [...jobs.values()];
}

export function killBackgroundJob(id: string): boolean {
  const child = children.get(id);
  if (!child) return false;
  try {
    return stopProcessTree(child);
  } catch {
    return false;
  }
}

export function killAllBackgroundJobs(): void {
  for (const child of children.values()) {
    try {
      stopProcessTree(child);
    } catch {
      // best effort
    }
  }
  children.clear();
}

/** Test hook: forget the registry without touching processes. */
export function resetBackgroundJobsForTests(): void {
  jobs.clear();
  children.clear();
}

async function tailLog(logPath: string, maxChars = 4_000): Promise<string> {
  try {
    const file = await fsp.open(logPath, "r");
    try {
      const { size } = await file.stat();
      const buffer = Buffer.alloc(Math.min(size, maxChars * 4));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
      const text = buffer.subarray(0, bytesRead).toString("utf8");
      return size > buffer.length || text.length > maxChars ? `…${text.slice(-maxChars)}` : text;
    } finally {
      await file.close();
    }
  } catch {
    return "";
  }
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80) || "run";
}
