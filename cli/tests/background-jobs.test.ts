import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  drainCompletedJobs,
  listBackgroundJobs,
  resetBackgroundJobsForTests,
  startBackgroundJob,
} from "../src/background-jobs.js";
import { runClientTool } from "../src/tools/registry.js";

let tmp = "";

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-jobs-"));
  process.env.LYNN_CLI_JOBS_DIR = path.join(tmp, "jobs");
  resetBackgroundJobsForTests();
});

afterEach(async () => {
  resetBackgroundJobsForTests();
  delete process.env.LYNN_CLI_JOBS_DIR;
  delete process.env.LYNN_CLI_BACKGROUND_ON_TIMEOUT;
  await fs.rm(tmp, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForDrain(timeoutMs = 4_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const completed = await drainCompletedJobs();
    if (completed.length) return completed;
    await sleep(25);
  }
  return [];
}

describe("background jobs", () => {
  it("starts a job, writes a log and reports completion", async () => {
    const job = startBackgroundJob({ command: "echo hello-bg", cwd: tmp, runId: "run-1" });
    expect(job.id).toMatch(/^bg-/);
    expect(job.logPath).toContain("run-1");
    expect(listBackgroundJobs()).toHaveLength(1);

    const completed = await waitForDrain();
    expect(completed).toHaveLength(1);
    expect(completed[0].job.exitCode).toBe(0);
    expect(completed[0].tail).toContain("hello-bg");
    await expect(fs.access(job.logPath)).resolves.toBeUndefined();
    // Drained jobs leave the registry.
    expect(listBackgroundJobs()).toHaveLength(0);
  });

  it("reports a non-zero exit code", async () => {
    startBackgroundJob({ command: 'node -e "process.exit(3)"', cwd: tmp });
    const completed = await waitForDrain();
    expect(completed[0].job.exitCode).toBe(3);
  });

  it("is reachable through the bash tool with run_in_background", async () => {
    const result = await runClientTool(
      { cwd: tmp, approval: "yolo", sandbox: "danger-full-access", runId: "tool-run" },
      { name: "bash", command: "echo tool-bg", run_in_background: true },
    );
    expect(result.ok).toBe(true);
    const output = result.output as { backgroundTaskId: string; logPath: string; note: string };
    expect(output.backgroundTaskId).toMatch(/^bg-/);
    expect(output.logPath).toContain("tool-run");
    expect(output.note).toContain("task-notification");

    const completed = await waitForDrain();
    expect(completed[0].tail).toContain("tool-bg");
  });

  it("keeps the foreground path unchanged", async () => {
    const result = await runClientTool(
      { cwd: tmp, approval: "yolo", sandbox: "danger-full-access" },
      { name: "bash", command: "echo foreground" },
    );
    expect(result.ok).toBe(true);
    expect((result.output as { stdout: string }).stdout).toContain("foreground");
  });

  it("moves a timed-out command to the background instead of killing it", async () => {
    const result = await runClientTool(
      { cwd: tmp, approval: "yolo", sandbox: "danger-full-access", timeoutMs: 150 },
      { name: "bash", command: 'node -e "setTimeout(() => console.log(\'after-timeout\'), 500)"' },
    );
    expect(result.ok).toBe(true);
    const output = result.output as { backgrounded: boolean; backgroundTaskId: string; logPath: string };
    expect(output.backgrounded).toBe(true);
    expect(output.backgroundTaskId).toMatch(/^bg-/);

    const completed = await waitForDrain();
    expect(completed[0].job.exitCode).toBe(0);
    expect(completed[0].tail).toContain("after-timeout");
  });

  it("still kills on timeout when backgrounding is disabled", async () => {
    process.env.LYNN_CLI_BACKGROUND_ON_TIMEOUT = "0";
    const result = await runClientTool(
      { cwd: tmp, approval: "yolo", sandbox: "danger-full-access", timeoutMs: 150 },
      { name: "bash", command: 'node -e "setTimeout(() => console.log(\'never\'), 500)"' },
    );
    expect(result.ok).toBe(false);
    expect((result.output as { timedOut: boolean }).timedOut).toBe(true);
  });
});
