import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  buildDefaultAgentCommand,
  buildWorkerPrompt,
  collectGitDiff,
  extractGroundingBoxes,
  parseWorkerBrief,
  parseWorkerEventLine,
  runWorker,
  workerProfileDefaults,
  workerProviderPreset,
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
      "## Task Type",
      "code",
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
    expect(brief.taskType).toBe("code");
    expect(brief.objective).toBe("Make InputArea smaller.");
    expect(brief.owned).toEqual([
      "desktop/src/react/components/InputArea.tsx",
      "desktop/src/react/components/input/**",
    ]);
    expect(brief.forbidden).toEqual(["server/**"]);
    expect(brief.tests).toEqual(["npm run typecheck"]);
  });

  it("parses MiMo vision task metadata from GUI Fleet briefs", () => {
    const brief = parseWorkerBrief([
      "# Task: Ground UI",
      "",
      "## Task Type",
      "- ground",
      "",
      "## Image",
      "- screenshots/login.png",
      "",
      "## Resume",
      "- /tmp/lynn-session.jsonl",
      "",
      "## Objective",
      "Find the login button.",
      "",
      "## Owned files",
      "- desktop/src/react/**",
      "",
      "## Forbidden files",
      "- server/**",
      "",
      "## Test commands",
      "- npm run typecheck",
    ].join("\n"));

    expect(brief.taskType).toBe("ground");
    expect(brief.image).toBe("screenshots/login.png");
    expect(brief.resumePath).toBe("/tmp/lynn-session.jsonl");
  });

  it("extracts normalized grounding boxes from MiMo JSON text", () => {
    expect(extractGroundingBoxes('```json\n{"x":0.25,"y":0.5,"w":0.2,"h":0.1,"confidence":0.88,"label":"submit"}\n```')).toEqual([{
      label: "submit",
      x: 0.25,
      y: 0.5,
      width: 0.2,
      height: 0.1,
      confidence: 0.88,
    }]);
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
    const codebuddy = buildDefaultAgentCommand("codebuddy", "/tmp/task.md", "/tmp/wt", "task");

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

    expect(codebuddy).toContain("codebuddy -p");
    expect(codebuddy).toContain("--output-format stream-json");
    expect(codebuddy).toContain("--include-partial-messages");
    expect(codebuddy).toContain("--add-dir '/tmp/wt'");
    expect(codebuddy).toContain("--permission-mode bypassPermissions");
    expect(codebuddy).toContain("-y");
  });

  it("returns null for unknown default worker agents", () => {
    expect(buildDefaultAgentCommand("custom", "/tmp/task.md", "/tmp/wt", "task")).toBeNull();
  });

  it("maps StepFun Fleet workers to the StepFun BYOK preset", () => {
    expect(workerProviderPreset("stepfun-flash")).toBe("stepfun");
    expect(workerProviderPreset("lynn-cli")).toBeNull();
  });

  it("applies concrete defaults for MiMo Fleet worker profiles", () => {
    expect(workerProfileDefaults("mimo-fast")).toEqual({ reasoning: "off", maxSteps: "6" });
    expect(workerProfileDefaults("mimo-pro")).toEqual({ reasoning: "high", maxSteps: "100", long: true });
    expect(workerProfileDefaults("mimo-vl")).toEqual({ reasoning: "high" });
    expect(workerProfileDefaults("stepfun-flash")).toEqual({ reasoning: "high", maxSteps: "100", long: true });
    expect(workerProfileDefaults("lynn-cli")).toEqual({});
  });

  it("runs mimo-fast workers with thinking disabled unless overridden", async () => {
    const repo = await makeTempGitRepo();
    const briefPath = path.join(repo, "brief.md");
    await fs.writeFile(briefPath, [
      "# Task: quick answer",
      "",
      "## Objective",
      "Answer quickly.",
      "",
      "## Owned files",
      "- cli/**",
      "",
      "## Forbidden files",
      "- server/**",
      "",
      "## Test commands",
      "- npm test",
    ].join("\n"));
    let body = "";
    const server = http.createServer((req, res) => {
      if (req.url === "/v1/chat/completions" && req.method === "POST") {
        req.on("data", (chunk) => { body += String(chunk); });
        req.on("end", () => {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "Fast worker done." } }] })}\n\ndata: [DONE]\n\n`);
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");

    const original = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      const code = await runWorker(parseArgs([
        "worker",
        "run",
        "--brief",
        briefPath,
        "--worktree",
        repo,
        "--agent",
        "mimo-fast",
        "--brain-url",
        `http://127.0.0.1:${address.port}`,
      ]));
      expect(code).toBe(0);
    } finally {
      process.stdout.write = original;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    const parsed = JSON.parse(body) as { reasoning_effort?: string; extra_body?: { enable_thinking?: boolean } };
    expect(parsed.reasoning_effort).toBe("off");
    expect(parsed.extra_body?.enable_thinking).toBe(false);
  });

  it("runs mimo-pro workers with endurance defaults enabled", async () => {
    const repo = await makeTempGitRepo();
    const briefPath = path.join(repo, "brief.md");
    await fs.writeFile(briefPath, [
      "# Task: long analysis",
      "",
      "## Objective",
      "Run a longer coding worker.",
      "",
      "## Owned files",
      "- cli/**",
      "",
      "## Forbidden files",
      "- server/**",
      "",
      "## Test commands",
      "- npm test",
    ].join("\n"));
    let body = "";
    const server = http.createServer((req, res) => {
      if (req.url === "/v1/chat/completions" && req.method === "POST") {
        req.on("data", (chunk) => { body += String(chunk); });
        req.on("end", () => {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "Long worker done." } }] })}\n\ndata: [DONE]\n\n`);
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");

    const original = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      const code = await runWorker(parseArgs([
        "worker",
        "run",
        "--brief",
        briefPath,
        "--worktree",
        repo,
        "--agent",
        "mimo-pro",
        "--brain-url",
        `http://127.0.0.1:${address.port}`,
      ]));
      expect(code).toBe(0);
    } finally {
      process.stdout.write = original;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    const parsed = JSON.parse(body) as { reasoning_effort?: string };
    expect(parsed.reasoning_effort).toBe("high");
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

  it("runs the built-in lynn-cli worker through the Brain-backed code loop", async () => {
    const repo = await makeTempGitRepo();
    await fs.writeFile(path.join(repo, "hello.txt"), "hello\n", "utf8");
    const briefPath = path.join(repo, "brief.md");
    await fs.writeFile(briefPath, [
      "# Task: patch file",
      "",
      "## Objective",
      "Change hello to lynn.",
      "",
      "## Owned files",
      "- hello.txt",
      "",
      "## Forbidden files",
      "- server/**",
      "",
      "## Test commands",
      "- npm test",
    ].join("\n"));
    const patch = [
      "diff --git a/hello.txt b/hello.txt",
      "--- a/hello.txt",
      "+++ b/hello.txt",
      "@@ -1 +1 @@",
      "-hello",
      "+lynn",
      "",
    ].join("\n");
    let calls = 0;
    const server = http.createServer((req, res) => {
      if (req.url === "/v1/chat/completions" && req.method === "POST") {
        req.resume();
        calls += 1;
        const content = calls === 1
          ? JSON.stringify({ tool: "apply_patch", args: { patch } })
          : "Patched hello.txt.";
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");

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
        "lynn-cli",
        "--brain-url",
        `http://127.0.0.1:${address.port}`,
        "--approval",
        "yolo",
        "--max-steps",
        "3",
      ]));
      expect(code).toBe(0);
    } finally {
      process.stdout.write = original;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    const text = await fs.readFile(path.join(repo, "hello.txt"), "utf8");
    const lines = output.trim().split(/\r?\n/).map((line) => JSON.parse(line) as { type: string; tool?: string; summary?: string; path?: string });
    expect(text).toContain("lynn");
    expect(lines.some((line) => line.type === "shell.started")).toBe(true);
    expect(lines.some((line) => line.type === "session.checkpoint")).toBe(true);
    expect(lines.some((line) => line.type === "session.saved" && line.path)).toBe(true);
    expect(lines.some((line) => line.type === "worker.finished" && line.summary === "lynn-cli worker completed")).toBe(true);
  });

  it("runs MiMo vision workers through the Brain multimodal path", async () => {
    const repo = await makeTempGitRepo();
    await fs.writeFile(path.join(repo, "shot.png"), Buffer.from("89504e470d0a1a0a", "hex"));
    const briefPath = path.join(repo, "brief.md");
    await fs.writeFile(briefPath, [
      "# Task: ground screenshot",
      "",
      "## Task Type",
      "ground",
      "",
      "## Image",
      "shot.png",
      "",
      "## Objective",
      "Find the submit button.",
      "",
      "## Owned files",
      "- desktop/src/react/**",
      "",
      "## Forbidden files",
      "- server/**",
      "",
      "## Test commands",
      "- npm test",
    ].join("\n"));
    let body = "";
    const server = http.createServer((req, res) => {
      if (req.url === "/v1/chat/completions" && req.method === "POST") {
        req.on("data", (chunk) => { body += String(chunk); });
        req.on("end", () => {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "{\"x\":0.5,\"y\":0.5,\"confidence\":0.9}" } }] })}\n\ndata: [DONE]\n\n`);
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");

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
        "mimo-vl",
        "--brain-url",
        `http://127.0.0.1:${address.port}`,
      ]));
      expect(code).toBe(0);
    } finally {
      process.stdout.write = original;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    expect(body).toContain("data:image/png;base64");
    expect(body).toContain("Find the submit button");
    const lines = output.trim().split(/\r?\n/).map((line) => JSON.parse(line) as {
      type: string;
      agent?: string;
      text?: string;
      summary?: string;
      taskType?: string;
      image?: string;
      boxes?: Array<{ x: number; y: number; confidence?: number }>;
    });
    expect(lines.some((line) => line.type === "worker.started" && line.agent === "mimo-vl")).toBe(true);
    expect(lines.some((line) => line.type === "assistant.delta" && line.text?.includes("\"x\""))).toBe(true);
    expect(lines.some((line) => (
      line.type === "worker.visual_result"
      && line.taskType === "ground"
      && line.image === "shot.png"
      && line.summary?.includes("\"confidence\"")
      && line.boxes?.[0]?.x === 0.5
      && line.boxes?.[0]?.confidence === 0.9
    ))).toBe(true);
    expect(lines.some((line) => line.type === "worker.finished" && line.summary === "lynn-cli worker completed")).toBe(true);
  });

  it("emits mock visual results for visual briefs", async () => {
    const repo = await makeTempGitRepo();
    const briefPath = path.join(repo, "brief.md");
    await fs.writeFile(briefPath, [
      "# Task: describe screenshot",
      "",
      "## Task Type",
      "see",
      "",
      "## Image",
      "shot.png",
      "",
      "## Objective",
      "Describe the screen.",
      "",
      "## Owned files",
      "- desktop/src/react/**",
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
        "mimo-vl",
        "--mock",
      ]));
      expect(code).toBe(0);
    } finally {
      process.stdout.write = original;
    }

    const lines = output.trim().split(/\r?\n/).map((line) => JSON.parse(line) as { type: string; taskType?: string; image?: string; summary?: string });
    expect(lines.some((line) => (
      line.type === "worker.visual_result"
      && line.taskType === "see"
      && line.image === "shot.png"
      && line.summary === "mock see result for shot.png"
    ))).toBe(true);
  });
});
