import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  buildDefaultAgentCommand,
  buildWorkerPrompt,
  collectGitDiff,
  parseWorkerBrief,
  parseWorkerEventLine,
  runWorker,
} from "../src/commands/worker-run.js";
import { parseArgs } from "../src/args.js";

const workerBriefPath = new URL("../fixtures/worker-brief.md", import.meta.url).pathname;
const execFileAsync = promisify(execFile);

async function makeTempGitRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-worker-run-"));
  await execFileAsync("git", ["init"], { cwd: dir });
  return dir;
}

describe("worker-run scaffold", () => {
  it("parses task brief ownership and tests", () => {
    const brief = parseWorkerBrief([
      "# Task: Split input",
      "",
      "## Objective",
      "Make InputArea smaller.",
      "",
      "## Owned files",
      "- desktop/src/react/components/InputArea.tsx",
      "- desktop/src/react/components/input/**",
      "",
      "## Forbidden files",
      "- server/**",
      "",
      "## Test commands",
      "- npm run typecheck",
    ].join("\n"));

    expect(brief.title).toBe("Task: Split input");
    expect(brief.objective).toBe("Make InputArea smaller.");
    expect(brief.owned).toEqual([
      "desktop/src/react/components/InputArea.tsx",
      "desktop/src/react/components/input/**",
    ]);
    expect(brief.forbidden).toEqual(["server/**"]);
    expect(brief.tests).toEqual(["npm run typecheck"]);
  });

  it("parses fleet JSONL event lines", () => {
    const parsed = parseWorkerEventLine(JSON.stringify({
      type: "worker.progress",
      message: "hello",
    }));

    expect(parsed.ok).toBe(true);
    expect(parsed.event?.type).toBe("worker.progress");
  });

  it("injects Lynn worker guardrails into external prompts", () => {
    const prompt = buildWorkerPrompt("## Objective\nDo the work.");

    expect(prompt).toContain("Lynn Fleet worker");
    expect(prompt).toContain("Do not download model weights");
    expect(prompt).toContain("## Objective\nDo the work.");
  });

  it("builds Codex worker commands without relying on invalid --file flags", () => {
    const command = buildDefaultAgentCommand("codex-cli", "/tmp/task brief.md", "/tmp/work tree", "hello 'world'");

    expect(command).toContain("codex exec");
    expect(command).toContain("--cd '/tmp/work tree'");
    expect(command).toContain("--json");
    expect(command).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(command).not.toContain("--file");
    expect(command).toContain("hello '\\''world'\\'''");
  });

  it("builds non-interactive Claude, Qwen, and Kimi worker commands", () => {
    const claude = buildDefaultAgentCommand("claude-code", "/tmp/task.md", "/tmp/wt", "task");
    const qwen = buildDefaultAgentCommand("qwen-cli", "/tmp/task.md", "/tmp/wt", "task");
    const kimi = buildDefaultAgentCommand("kimi-cli", "/tmp/task.md", "/tmp/wt", "task");

    expect(claude).toContain("claude -p");
    expect(claude).toContain("--add-dir '/tmp/wt'");
    expect(claude).toContain("--output-format stream-json");
    expect(claude).toContain("--dangerously-skip-permissions");

    expect(qwen).toContain("qwen -p");
    expect(qwen).toContain("--add-dir '/tmp/wt'");
    expect(qwen).toContain("--approval-mode yolo");
    expect(qwen).toContain("--yolo");

    expect(kimi).toContain("kimi --work-dir '/tmp/wt'");
    expect(kimi).toContain("--print");
    expect(kimi).toContain("--output-format stream-json");
    expect(kimi).toContain("--afk");
  });

  it("returns null for unknown default worker agents", () => {
    expect(buildDefaultAgentCommand("custom", "/tmp/task.md", "/tmp/wt", "task")).toBeNull();
  });

  it("collects git diff summaries from a worktree", async () => {
    const repo = await makeTempGitRepo();
    await fs.writeFile(path.join(repo, "added.txt"), "hello\nworld\n");
    await execFileAsync("git", ["add", "added.txt"], { cwd: repo });

    const diff = await collectGitDiff(repo);

    expect(diff.files).toBe(1);
    expect(diff.insertions).toBe(2);
    expect(diff.deletions).toBe(0);
    expect(diff.changedFiles).toEqual([
      { path: "added.txt", action: "add", insertions: 2, deletions: 0 },
    ]);
  });

  it("wraps external worker output as fleet progress", async () => {
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await runWorker(parseArgs([
        "worker",
        "run",
        "--brief",
        workerBriefPath,
        "--worktree",
        process.cwd(),
        "--agent",
        "custom",
        "--agent-command",
        "node -e \"console.log('external hello')\"",
      ]));
      expect(code).toBe(0);
    } finally {
      process.stdout.write = original;
    }

    const lines = output.trim().split(/\r?\n/).map((line) => JSON.parse(line) as { type: string; message?: string });
    expect(lines.some((line) => line.type === "shell.started")).toBe(true);
    expect(lines.some((line) => line.type === "worker.progress" && line.message === "external hello")).toBe(true);
    expect(lines.at(-1)?.type).toBe("worker.finished");
  });

  it("emits real git diff after an external worker changes files", async () => {
    const repo = await makeTempGitRepo();
    const briefPath = path.join(repo, "brief.md");
    await fs.writeFile(briefPath, [
      "# Task: write file",
      "",
      "## Objective",
      "Write a file.",
      "",
      "## Owned files",
      "- worker-output.txt",
      "",
      "## Forbidden files",
      "- server/**",
      "",
      "## Test commands",
      "- npm test",
    ].join("\n"));

    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await runWorker(parseArgs([
        "worker",
        "run",
        "--brief",
        briefPath,
        "--worktree",
        repo,
        "--agent",
        "custom",
        "--agent-command",
        "node -e \"require('fs').writeFileSync('worker-output.txt','hello')\"",
      ]));
      expect(code).toBe(0);
    } finally {
      process.stdout.write = original;
    }

    const lines = output.trim().split(/\r?\n/).map((line) => JSON.parse(line) as { type: string; changedFiles?: Array<{ path: string; action: string }> });
    const diff = lines.find((line) => line.type === "git.diff");
    expect(diff?.changedFiles).toEqual([
      { path: "brief.md", action: "add", insertions: 0, deletions: 0 },
      { path: "worker-output.txt", action: "add", insertions: 0, deletions: 0 },
    ]);
  });
});
