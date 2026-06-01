import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";
import { maxSteps, runCode, runCodeTaskWithEvents, type CodeAgentEvent } from "../src/commands/code.js";
import { compactRuntimeMessages } from "../src/code-agent-loop.js";
import { appendSessionTurn, readSessionLines, sessionIndexPath } from "../src/session/store.js";

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

describe("code agent loop · resume & checkpoint", () => {
  it("carries cache/TPS usage into the final JSON task summary", async () => {
    const server = http.createServer((req, res) => {
      if (req.url === "/v1/chat/completions" && req.method === "POST") {
        req.resume();
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end([
          `data: ${JSON.stringify({ choices: [{ delta: { content: "Usage-aware answer." } }] })}`,
          "",
          `data: ${JSON.stringify({
            choices: [],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 20,
              total_tokens: 120,
              prompt_cache_hit_tokens: 80,
            },
          })}`,
          "",
          "data: [DONE]",
          "",
        ].join("\n"));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("usage server failed to bind");
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(runCode(parseArgs([
        "code",
        "answer with usage",
        "--cwd",
        tmp,
        "--brain-url",
        `http://127.0.0.1:${address.port}`,
        "--json",
      ]))).resolves.toBe(0);
    } finally {
      process.stdout.write = original;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    const finished = output.trim().split(/\r?\n/).map((line) => JSON.parse(line) as {
      type: string;
      usageSummary?: string;
    }).find((line) => line.type === "code.task.finished");
    expect(finished?.usageSummary).toContain("120 tokens");
    expect(finished?.usageSummary).toContain("prefix-cache 80 hit (80%)");
    expect(finished?.usageSummary).toContain("TPS");
  });

  it("resumes a saved code session and appends the continuation", async () => {
    const dataDir = path.join(tmp, "data");
    const sessionPath = await appendSessionTurn({
      dataDir,
      cwd: tmp,
      title: "resume me",
      prompt: "Read hello.txt and remember it says hello.",
      assistant: "I read hello.txt. It says hello.",
      modelProvider: "mock",
      modelId: "mock-brain",
    });
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await withBrainServer((body) => {
        const parsed = body as { messages?: Array<{ role?: string; content?: unknown }> };
        expect(JSON.stringify(parsed.messages)).toContain("It says hello");
        return "Continued from the saved session.";
      }, async (brainUrl) => {
        await expect(runCode(parseArgs([
          "code",
          "continue",
          "--cwd",
          tmp,
          "--brain-url",
          brainUrl,
          "--resume",
          sessionPath,
          "--data-dir",
          dataDir,
          "--json",
        ]))).resolves.toBe(0);
      });
    } finally {
      process.stdout.write = original;
    }

    const lines = (await fs.readFile(sessionPath, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line) as { type: string; content?: string; data?: { resumedFrom?: string | null } });
    expect(output).toContain('"type":"session.resumed"');
    expect(output).toContain('"type":"session.saved"');
    expect(lines.filter((line) => line.type === "user")).toHaveLength(2);
    expect(lines.at(-1)?.data?.resumedFrom).toBe(sessionPath);
  });

  it("checkpoints structured tool calls so resume preserves tool results", async () => {
    const dataDir = path.join(tmp, "structured-checkpoint-data");
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await withRawBrainServer((_body, count) => {
        expect(count).toBe(1);
        return rawSsePayloads([
          JSON.stringify({
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "read_file", arguments: "{\"path\":\"hello.txt\"}" },
                }],
              },
            }],
          }),
          JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
        ]);
      }, async (brainUrl) => {
        await expect(runCode(parseArgs([
          "code",
          "inspect hello with structured checkpoint",
          "--cwd",
          tmp,
          "--brain-url",
          brainUrl,
          "--save-session",
          "--data-dir",
          dataDir,
          "--max-steps",
          "1",
          "--json",
        ]))).resolves.toBe(2);
      });
    } finally {
      process.stdout.write = original;
    }

    const savedLine = output.split(/\r?\n/).find((line) => line.includes('"type":"session.saved"'));
    const savedPath = savedLine ? JSON.parse(savedLine).path as string : "";
    expect(savedPath).toBeTruthy();
    const lines = await readSessionLines(savedPath);
    expect(lines).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "assistant",
        data: expect.objectContaining({
          tool_calls: [expect.objectContaining({
            id: "call_1",
            function: expect.objectContaining({ name: "read_file" }),
          })],
        }),
      }),
      expect.objectContaining({
        type: "tool",
        content: expect.stringContaining("Tool result for read_file"),
        data: expect.objectContaining({ tool_call_id: "call_1", name: "read_file" }),
      }),
    ]));

    let resumeBody = "";
    const originalResumeStdout = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      await withBrainServer((body) => {
        resumeBody = JSON.stringify(body);
        return "Resumed with structured tool context.";
      }, async (brainUrl) => {
        await expect(runCode(parseArgs([
          "code",
          "continue structured checkpoint",
          "--cwd",
          tmp,
          "--brain-url",
          brainUrl,
          "--resume",
          savedPath,
          "--json",
        ]))).resolves.toBe(0);
      });
    } finally {
      process.stdout.write = originalResumeStdout;
    }

    expect(resumeBody).toContain('"tool_calls"');
    expect(resumeBody).toContain('"role":"tool"');
    expect(resumeBody).toContain('"tool_call_id":"call_1"');
    expect(resumeBody).toContain("Tool result for read_file");
  });

  it("resumes the latest saved CLI session with --resume last", async () => {
    const dataDir = path.join(tmp, "latest-data");
    await appendSessionTurn({
      dataDir,
      cwd: tmp,
      title: "older",
      prompt: "older prompt",
      assistant: "older assistant",
      modelProvider: "mock",
      modelId: "mock-brain",
    });
    const latestPath = await appendSessionTurn({
      dataDir,
      cwd: tmp,
      title: "latest",
      prompt: "latest prompt",
      assistant: "latest assistant marker",
      modelProvider: "mock",
      modelId: "mock-brain",
    });
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await withBrainServer((body) => {
        const parsed = body as { messages?: Array<{ role?: string; content?: unknown }> };
        expect(JSON.stringify(parsed.messages)).toContain("latest assistant marker");
        expect(JSON.stringify(parsed.messages)).not.toContain("older assistant");
        return "Resumed latest session.";
      }, async (brainUrl) => {
        await expect(runCode(parseArgs([
          "code",
          "continue latest",
          "--cwd",
          tmp,
          "--brain-url",
          brainUrl,
          "--resume",
          "last",
          "--data-dir",
          dataDir,
          "--json",
        ]))).resolves.toBe(0);
      });
    } finally {
      process.stdout.write = original;
    }

    expect(output).toContain('"type":"session.resumed"');
    expect(output).toContain(JSON.stringify(latestPath).slice(1, -1));
  });

  it("checkpoints tool-loop turns while a code session is running", async () => {
    const dataDir = path.join(tmp, "checkpoint-data");
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await withBrainServer((_body, count) => count === 1
        ? JSON.stringify({ tool: "read_file", args: { path: "hello.txt" } })
        : "I read hello.txt and found hello.",
      async (brainUrl) => {
        await expect(runCode(parseArgs([
          "code",
          "inspect hello with checkpoints",
          "--cwd",
          tmp,
          "--brain-url",
          brainUrl,
          "--save-session",
          "--data-dir",
          dataDir,
          "--json",
        ]))).resolves.toBe(0);
      });
    } finally {
      process.stdout.write = original;
    }

    const savedLine = output.split(/\r?\n/).find((line) => line.includes('"type":"session.saved"'));
    const savedPath = savedLine ? JSON.parse(savedLine).path as string : "";
    expect(savedPath).toBeTruthy();
    const lines = (await fs.readFile(savedPath, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line) as { type: string; content?: string; data?: Record<string, unknown> });

    expect(output).toContain('"type":"session.checkpoint"');
    expect(lines.map((line) => line.type)).toEqual(["user", "assistant", "user", "assistant", "metadata"]);
    expect(lines[1]?.content).toContain('"tool":"read_file"');
    expect(lines[2]?.content).toContain("Tool result for read_file");
    expect(lines[2]?.content).toContain("hello.txt");
    expect(lines[3]?.content).toContain("I read hello.txt");
    expect(lines.at(-1)?.data).toMatchObject({ kind: "code_task" });
  });

  it("autosaves human code tasks by default for resumable long runs", async () => {
    const dataDir = path.join(tmp, "autosave-data");
    const original = process.stdout.write;
    const originalErr = process.stderr.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      await withBrainServer(() => "Autosaved task complete.", async (brainUrl) => {
        await expect(runCode(parseArgs([
          "code",
          "autosave this human task",
          "--cwd",
          tmp,
          "--brain-url",
          brainUrl,
          "--data-dir",
          dataDir,
          "--max-steps",
          "1",
        ]))).resolves.toBe(0);
      });
    } finally {
      process.stdout.write = original;
      process.stderr.write = originalErr;
    }

    const index = JSON.parse(await fs.readFile(sessionIndexPath(dataDir), "utf8")) as { sessions: Array<{ path: string; title: string }> };
    expect(index.sessions).toHaveLength(1);
    expect(index.sessions[0]?.title).toBe("autosave this human task");
    const lines = (await fs.readFile(index.sessions[0]!.path, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line) as { type: string; content?: string; data?: Record<string, unknown> });
    expect(lines.map((line) => line.type)).toEqual(["user", "assistant", "metadata"]);
    expect(lines[1]?.content).toContain("Autosaved task complete");
  });

  it("allows human code autosave to be disabled explicitly", async () => {
    const dataDir = path.join(tmp, "no-autosave-data");
    const original = process.stdout.write;
    const originalErr = process.stderr.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      await withBrainServer(() => "No autosave requested.", async (brainUrl) => {
        await expect(runCode(parseArgs([
          "code",
          "do not save this human task",
          "--cwd",
          tmp,
          "--brain-url",
          brainUrl,
          "--data-dir",
          dataDir,
          "--no-save-session",
          "--max-steps",
          "1",
        ]))).resolves.toBe(0);
      });
    } finally {
      process.stdout.write = original;
      process.stderr.write = originalErr;
    }

    await expect(fs.stat(sessionIndexPath(dataDir))).rejects.toThrow();
  });
});
