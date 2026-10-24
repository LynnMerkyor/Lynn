import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";
import { listBackgroundJobs, resetBackgroundJobsForTests, startBackgroundJob } from "../src/background-jobs.js";
import { runCode } from "../src/commands/code.js";

let tmp = "";
const cliRoot = fileURLToPath(new URL("..", import.meta.url));
const pythonIt = hasPython3() ? it : it.skip;
const ptyIt = process.platform === "win32" ? it.skip : pythonIt;
const interactivePtyIt = process.env.CI === "true" ? it.skip : ptyIt;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-cli-agent-"));
  await fs.writeFile(path.join(tmp, "hello.txt"), "hello\n", "utf8");
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function sse(content: string): string {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");
}

function rawSsePayloads(payloads: string[]): string {
  return [
    ...payloads.flatMap((payload) => [`data: ${payload}`, ""]),
    "data: [DONE]",
    "",
  ].join("\n");
}

function hasPython3(): boolean {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function withBrainServer(handler: (body: unknown, count: number) => string, run: (url: string) => Promise<void>): Promise<void> {
  let count = 0;
  const server = http.createServer((req, res) => {
    if (req.url === "/v1/chat/completions" && req.method === "POST") {
      let raw = "";
      req.on("data", (chunk) => { raw += String(chunk); });
      req.on("end", () => {
        count += 1;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(sse(handler(JSON.parse(raw), count)));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server failed to bind");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function withRawBrainServer(handler: (body: unknown, count: number) => string, run: (url: string) => Promise<void>): Promise<void> {
  let count = 0;
  const server = http.createServer((req, res) => {
    if (req.url === "/v1/chat/completions" && req.method === "POST") {
      let raw = "";
      req.on("data", (chunk) => { raw += String(chunk); });
      req.on("end", () => {
        count += 1;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(handler(JSON.parse(raw), count));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server failed to bind");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
describe("code agent loop · tool calls & repair", () => {


  it("returns a non-zero result when the tool loop exhausts max steps", async () => {
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await withBrainServer(() => JSON.stringify({ tool: "read_file", args: { path: "hello.txt" } }), async (brainUrl) => {
        await expect(runCode(parseArgs([
          "code",
          "keep inspecting hello",
          "--cwd",
          tmp,
          "--brain-url",
          brainUrl,
          "--max-steps",
          "1",
          "--json",
        ]))).resolves.toBe(2);
      });
    } finally {
      process.stdout.write = original;
    }

    expect(output).toContain('"type":"code.tool.requested"');
    expect(output).toContain('"ok":false');
    expect(output).toContain('"code":"max_steps_reached"');
    expect(output).toContain("Stopped after the maximum tool steps");
  });


  it("emits a resumable checkpoint command when max steps exhaust with session saving", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-cli-resume-hint-"));
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await withBrainServer(() => JSON.stringify({ tool: "read_file", args: { path: "hello.txt" } }), async (brainUrl) => {
        await expect(runCode(parseArgs([
          "code",
          "keep inspecting hello",
          "--cwd",
          tmp,
          "--brain-url",
          brainUrl,
          "--max-steps",
          "1",
          "--json",
          "--save-session",
          "--data-dir",
          dataDir,
        ]))).resolves.toBe(2);
      });
    } finally {
      process.stdout.write = original;
      await fs.rm(dataDir, { recursive: true, force: true });
    }

    expect(output).toContain('"code":"max_steps_reached"');
    expect(output).toContain('"sessionPath"');
    expect(output).toContain('"resumeCommand"');
    expect(output).toContain("Lynn code --resume");
    expect(output).toContain("--long");
  });



  it("runs a write as a barrier so a later read sees the new content", async () => {
    const original = process.stdout.write;
    let output = "";
    let toolResultTurn = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await withBrainServer((body, count) => {
        if (count === 1) {
          return JSON.stringify({
            tool_calls: [
              { type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "made.txt", text: "barrier\n" }) } },
              { type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "made.txt" }) } },
            ],
          });
        }
        toolResultTurn = JSON.stringify(body);
        return "wrote then read";
      }, async (brainUrl) => {
        await expect(runCode(parseArgs([
          "code",
          "write then read",
          "--cwd",
          tmp,
          "--brain-url",
          brainUrl,
          "--approval",
          "yolo",
          "--max-steps",
          "3",
          "--json",
        ]))).resolves.toBe(0);
      });
    } finally {
      process.stdout.write = original;
    }

    expect(await fs.readFile(path.join(tmp, "made.txt"), "utf8")).toBe("barrier\n");
    expect(toolResultTurn).toContain("Tool result for write_file");
    expect(toolResultTurn).toContain("Tool result for read_file");
    // The read must contain the bytes the write just produced, not an "unchanged" stub.
    expect(toolResultTurn).toContain("barrier");
  });


  it.each(["deny", "ask"])("enforces explicit project %s rules even in yolo mode", async (decision) => {
    await fs.mkdir(path.join(tmp, ".lynn"), { recursive: true });
    await fs.writeFile(path.join(tmp, ".lynn", "settings.json"), JSON.stringify({
      permissions: { [decision]: ["write_file(secret.txt)"] },
    }), "utf8");
    const original = process.stdout.write;
    let output = "";
    let toolResultTurn = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await withBrainServer((body, count) => {
        if (count === 1) {
          return JSON.stringify({
            tool_calls: [
              { type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "secret.txt", text: "nope" }) } },
            ],
          });
        }
        toolResultTurn = JSON.stringify(body);
        return "the rule blocked it";
      }, async (brainUrl) => {
        await expect(runCode(parseArgs([
          "code",
          "try to write the denied file",
          "--cwd",
          tmp,
          "--brain-url",
          brainUrl,
          "--approval",
          "yolo",
          "--max-steps",
          "3",
          "--json",
        ]))).resolves.toBe(0);
      });
    } finally {
      process.stdout.write = original;
    }

    await expect(fs.access(path.join(tmp, "secret.txt"))).rejects.toThrow();
    const diagnostic = decision === "deny" ? "Blocked by permission rule" : "Explicit rule or hook requires approval";
    expect(output).toContain(diagnostic);
    expect(toolResultTurn).toContain(diagnostic);
  });



  it("runs lifecycle hooks: PreToolUse can block, PostToolUse can add context", async () => {
    await fs.mkdir(path.join(tmp, ".lynn"), { recursive: true });
    await fs.writeFile(path.join(tmp, ".lynn", "hooks.json"), JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "^write_file$", command: "node -e \"process.exit(2)\"" }],
        PostToolUse: [{ matcher: "^read_file$", command: "node -e \"console.log(JSON.stringify({additionalContext:'HOOK_NOTE'}))\"" }],
      },
    }), "utf8");
    process.env.LYNN_TRUST_PROJECT_RULES = "1";
    const original = process.stdout.write;
    let output = "";
    let toolResultTurn = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await withBrainServer((body, count) => {
        if (count === 1) {
          return JSON.stringify({
            tool_calls: [
              { type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "hooked.txt", text: "nope" }) } },
              { type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "hello.txt" }) } },
            ],
          });
        }
        toolResultTurn = JSON.stringify(body);
        return "hooks handled";
      }, async (brainUrl) => {
        await expect(runCode(parseArgs([
          "code", "hook test", "--cwd", tmp, "--brain-url", brainUrl,
          "--approval", "yolo", "--max-steps", "3", "--json",
        ]))).resolves.toBe(0);
      });
    } finally {
      process.stdout.write = original;
      delete process.env.LYNN_TRUST_PROJECT_RULES;
    }

    await expect(fs.access(path.join(tmp, "hooked.txt"))).rejects.toThrow();
    expect(toolResultTurn).toContain("Blocked by PreToolUse hook");
    expect(toolResultTurn).toContain("[hook context]");
    expect(toolResultTurn).toContain("HOOK_NOTE");
    expect(output).toContain("hooks handled");
  });



  it("injects a completed background job as a task notification", async () => {
    process.env.LYNN_CLI_JOBS_DIR = path.join(tmp, "jobs");
    resetBackgroundJobsForTests();
    const job = startBackgroundJob({ command: "echo prepopulated", cwd: tmp, runId: "loop-run" });
    const started = Date.now();
    while (Date.now() - started < 3_000) {
      if (listBackgroundJobs().some((entry) => entry.id === job.id && entry.done)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const original = process.stdout.write;
    let output = "";
    let firstTurnBody = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await withBrainServer((body, count) => {
        if (count === 1) {
          firstTurnBody = JSON.stringify(body);
          return "noticed the background result";
        }
        return "done";
      }, async (brainUrl) => {
        await expect(runCode(parseArgs([
          "code", "check background", "--cwd", tmp, "--brain-url", brainUrl,
          "--max-steps", "2", "--json",
        ]))).resolves.toBe(0);
      });
    } finally {
      process.stdout.write = original;
      delete process.env.LYNN_CLI_JOBS_DIR;
      resetBackgroundJobsForTests();
    }

    expect(firstTurnBody).toContain("<task-notification>");
    expect(firstTurnBody).toContain("prepopulated");
    expect(output).toContain('"type":"code.background.completed"');
  });



  it("blocks writes in plan mode and records the presented plan", async () => {
    const original = process.stdout.write;
    let output = "";
    let nextTurnBody = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await withBrainServer((body, count) => {
        if (count === 1) {
          return JSON.stringify({
            tool_calls: [
              { type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "planned.txt", text: "nope" }) } },
              { type: "function", function: { name: "exit_plan_mode", arguments: JSON.stringify({ plan: "Step 1: read hello.txt\nStep 2: change it" }) } },
              { type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "hello.txt" }) } },
            ],
          });
        }
        nextTurnBody = JSON.stringify(body);
        return "plan presented";
      }, async (brainUrl) => {
        await expect(runCode(parseArgs([
          "code", "plan first", "--cwd", tmp, "--brain-url", brainUrl,
          "--plan", "--approval", "yolo", "--max-steps", "3", "--json",
        ]))).resolves.toBe(0);
      });
    } finally {
      process.stdout.write = original;
    }

    await expect(fs.access(path.join(tmp, "planned.txt"))).rejects.toThrow();
    expect(output).toContain('"type":"code.plan.presented"');
    expect(nextTurnBody).toContain("plan mode: write_file is disabled");
    expect(nextTurnBody).toContain("Plan recorded");
    expect(nextTurnBody).toContain("Step 1: read hello.txt");
    expect(nextTurnBody).toContain("Tool result for read_file");
    expect(output).toContain('"permission_denials"');
    expect(output).toContain('"stop_reason":"completed"');
    expect(output).toContain('"duration_ms"');
  });



  it("lists skills without bodies and loads one on demand", async () => {
    await fs.mkdir(path.join(tmp, ".lynn", "skills", "pdf"), { recursive: true });
    await fs.writeFile(
      path.join(tmp, ".lynn", "skills", "pdf", "SKILL.md"),
      "---\nname: pdf\ndescription: Handle PDFs\n---\nSKILL_BODY_MARKER\n",
      "utf8",
    );
    process.env.LYNN_DATA_DIR = path.join(tmp, "data");
    const original = process.stdout.write;
    let output = "";
    let firstTurnBody = "";
    let secondTurnBody = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await withBrainServer((body, count) => {
        if (count === 1) {
          firstTurnBody = JSON.stringify(body);
          return JSON.stringify({
            tool_calls: [
              { type: "function", function: { name: "load_skill", arguments: JSON.stringify({ name: "pdf" }) } },
            ],
          });
        }
        secondTurnBody = JSON.stringify(body);
        return "skill applied";
      }, async (brainUrl) => {
        await expect(runCode(parseArgs([
          "code", "use the pdf skill", "--cwd", tmp, "--brain-url", brainUrl,
          "--max-steps", "3", "--json",
        ]))).resolves.toBe(0);
      });
    } finally {
      process.stdout.write = original;
      delete process.env.LYNN_DATA_DIR;
    }

    expect(firstTurnBody).toContain("pdf: Handle PDFs");
    expect(firstTurnBody).not.toContain("SKILL_BODY_MARKER");
    expect(secondTurnBody).toContain("Tool result for load_skill");
    expect(secondTurnBody).toContain("SKILL_BODY_MARKER");
    expect(output).toContain("skill applied");
  });
});
