import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";
import { maxSteps, runCode } from "../src/commands/code.js";
import { appendSessionTurn, sessionIndexPath } from "../src/session/store.js";

let tmp = "";

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

describe("code agent loop", () => {
  it("keeps normal coding turns capped at 20 steps unless long-run mode is explicit", () => {
    expect(maxSteps(parseArgs(["code", "task"]))).toBe(8);
    expect(maxSteps(parseArgs(["code", "task", "--max-steps", "20"]))).toBe(20);
    expect(() => maxSteps(parseArgs(["code", "task", "--max-steps", "21"]))).toThrow(/--long/);
  });

  it("allows endurance coding turns to opt into a 1000 step budget", () => {
    expect(maxSteps(parseArgs(["code", "task", "--long", "--max-steps", "1000"]))).toBe(1000);
    expect(maxSteps(parseArgs(["code", "task", "--endurance", "--steps", "250"]))).toBe(250);
    expect(() => maxSteps(parseArgs(["code", "task", "--long", "--max-steps", "1001"]))).toThrow(/1 to 1000/);
  });

  it("validates max steps before the mock brain shortcut", async () => {
    await expect(runCode(parseArgs([
      "code",
      "mock task",
      "--cwd",
      tmp,
      "--mock-brain",
      "--max-steps",
      "21",
      "--json",
    ]))).rejects.toThrow(/--long/);
  });

  it("executes a model-requested apply_patch tool and feeds the result back", async () => {
    const patch = [
      "diff --git a/hello.txt b/hello.txt",
      "--- a/hello.txt",
      "+++ b/hello.txt",
      "@@ -1 +1 @@",
      "-hello",
      "+lynn",
      "",
    ].join("\n");
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await withBrainServer((_body, count) => count === 1
        ? JSON.stringify({ tool: "apply_patch", args: { patch } })
        : "Changed hello.txt and applied the patch.",
      async (brainUrl) => {
        await expect(runCode(parseArgs([
          "code",
          "change hello to lynn",
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
    const text = await fs.readFile(path.join(tmp, "hello.txt"), "utf8");
    expect(text).toContain("lynn");
    expect(output).toContain('"type":"code.tool.requested"');
    expect(output).toContain('"tool":"apply_patch"');
    expect(output).toContain("Changed hello.txt");
  });

  it("executes multiple model-requested tool calls from one turn", async () => {
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
              { type: "function", function: { name: "read_file", arguments: "{\"path\":\"hello.txt\"}" } },
              { type: "function", function: { name: "glob", arguments: "{\"pattern\":\"*.txt\"}" } },
            ],
          });
        }
        toolResultTurn = JSON.stringify(body);
        return "I read hello.txt and listed text files.";
      }, async (brainUrl) => {
        await expect(runCode(parseArgs([
          "code",
          "inspect hello with two tools",
          "--cwd",
          tmp,
          "--brain-url",
          brainUrl,
          "--max-steps",
          "3",
          "--json",
        ]))).resolves.toBe(0);
      });
    } finally {
      process.stdout.write = original;
    }

    expect(output.match(/"type":"code\.tool\.requested"/g)).toHaveLength(2);
    expect(output.match(/"type":"code\.tool\.result"/g)).toHaveLength(2);
    expect(toolResultTurn).toContain("Tool result for read_file");
    expect(toolResultTurn).toContain("Tool result for glob");
    expect(toolResultTurn).toContain("hello.txt");
    expect(output).toContain("I read hello.txt and listed text files");
  });

  it("executes OpenAI streamed tool_call deltas from BYOK-style providers", async () => {
    const original = process.stdout.write;
    let output = "";
    let toolResultTurn = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await withRawBrainServer((body, count) => {
        if (count === 1) {
          expect(body).toMatchObject({
            tools: expect.arrayContaining([
              expect.objectContaining({ type: "function", function: expect.objectContaining({ name: "read_file" }) }),
              expect.objectContaining({ type: "function", function: expect.objectContaining({ name: "apply_patch" }) }),
            ]),
            tool_choice: "auto",
          });
          return rawSsePayloads([
            JSON.stringify({
              choices: [{
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: "call_1",
                    type: "function",
                    function: { name: "read_file", arguments: "{\"path\":" },
                  }],
                },
              }],
            }),
            JSON.stringify({
              choices: [{
                delta: {
                  tool_calls: [{
                    index: 0,
                    function: { arguments: "\"hello.txt\"}" },
                  }],
                },
              }],
            }),
            JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
          ]);
        }
        toolResultTurn = JSON.stringify(body);
        return rawSsePayloads([
          JSON.stringify({ choices: [{ delta: { content: "Read streamed tool call result." } }] }),
        ]);
      }, async (brainUrl) => {
        await expect(runCode(parseArgs([
          "code",
          "inspect hello via streamed tool call",
          "--cwd",
          tmp,
          "--brain-url",
          brainUrl,
          "--max-steps",
          "3",
          "--json",
        ]))).resolves.toBe(0);
      });
    } finally {
      process.stdout.write = original;
    }

    expect(output).toContain('"type":"code.tool.requested"');
    expect(output).toContain('"tool":"read_file"');
    expect(toolResultTurn).toContain("Tool result for read_file");
    expect(toolResultTurn).toContain("hello.txt");
    expect(output).toContain("Read streamed tool call result");
  });

  it("feeds failed tool results back so the model can repair and continue", async () => {
    const badPatch = [
      "*** Begin Patch",
      "*** Update File: hello.txt",
      "@@",
      "-not the current content",
      "+broken",
      "*** End Patch",
      "",
    ].join("\n");
    const goodPatch = [
      "*** Begin Patch",
      "*** Update File: hello.txt",
      "@@",
      "-hello",
      "+recovered",
      "*** End Patch",
      "",
    ].join("\n");
    const original = process.stdout.write;
    let output = "";
    let repairTurn = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await withBrainServer((body, count) => {
        if (count === 1) return JSON.stringify({ tool: "apply_patch", args: { patch: badPatch } });
        if (count === 2) {
          repairTurn = JSON.stringify(body);
          return JSON.stringify({ tool: "apply_patch", args: { patch: goodPatch } });
        }
        return "Recovered after reading the failed patch result.";
      }, async (brainUrl) => {
        await expect(runCode(parseArgs([
          "code",
          "fix hello",
          "--cwd",
          tmp,
          "--brain-url",
          brainUrl,
          "--approval",
          "yolo",
          "--max-steps",
          "4",
          "--json",
        ]))).resolves.toBe(0);
      });
    } finally {
      process.stdout.write = original;
    }

    const text = await fs.readFile(path.join(tmp, "hello.txt"), "utf8");
    expect(text).toContain("recovered");
    expect(repairTurn).toContain("context not found");
    expect(output).toContain('"ok":false');
    expect(output).toContain('"ok":true');
    expect(output).toContain("Recovered after reading the failed patch result");
  });

  it("suppresses repeated identical tool requests during the loop", async () => {
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await withBrainServer((_body, count) => {
        if (count <= 2) return JSON.stringify({ tool: "read_file", args: { path: "hello.txt" } });
        return "I already have the file content and can answer now.";
      }, async (brainUrl) => {
        await expect(runCode(parseArgs([
          "code",
          "inspect hello",
          "--cwd",
          tmp,
          "--brain-url",
          brainUrl,
          "--max-steps",
          "4",
          "--json",
        ]))).resolves.toBe(0);
      });
    } finally {
      process.stdout.write = original;
    }

    expect(output).toContain('"type":"code.tool.loop_guard"');
    expect(output).toContain("Repeated identical tool request suppressed");
    expect(output).toContain("I already have the file content");
  });

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

  it("sends attached images through code mode for multimodal MiMo tasks", async () => {
    const image = path.join(tmp, "shot.png");
    await fs.writeFile(image, Buffer.from("89504e470d0a1a0a", "hex"));
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await withBrainServer((body) => {
        const parsed = body as { messages?: Array<{ content?: unknown }> };
        const firstUser = parsed.messages?.find((message) => Array.isArray(message.content));
        expect(firstUser).toBeTruthy();
        expect(JSON.stringify(firstUser?.content)).toContain("data:image/png;base64");
        return "Reviewed the screenshot.";
      }, async (brainUrl) => {
        await expect(runCode(parseArgs([
          "code",
          "review this UI",
          "--cwd",
          tmp,
          "--brain-url",
          brainUrl,
          "--image",
          image,
          "--json",
        ]))).resolves.toBe(0);
      });
    } finally {
      process.stdout.write = original;
    }

    expect(output).toContain("Reviewed the screenshot");
  });

  it("sends multiple attached images through code mode", async () => {
    const first = path.join(tmp, "first.png");
    const second = path.join(tmp, "second.png");
    await fs.writeFile(first, Buffer.from("89504e470d0a1a0a", "hex"));
    await fs.writeFile(second, Buffer.from("89504e470d0a1a0a", "hex"));
    const original = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      await withBrainServer((body) => {
        const parsed = body as { messages?: Array<{ content?: unknown }> };
        const firstUser = parsed.messages?.find((message) => Array.isArray(message.content));
        const content = Array.isArray(firstUser?.content) ? firstUser.content : [];
        expect(content.filter((part) => (part as { type?: string }).type === "image_url")).toHaveLength(2);
        expect(JSON.stringify(content)).toContain("Attached images:");
        return "Compared both screenshots.";
      }, async (brainUrl) => {
        await expect(runCode(parseArgs([
          "code",
          "compare these UIs",
          "--cwd",
          tmp,
          "--brain-url",
          brainUrl,
          "--images",
          `${first},${second}`,
          "--json",
        ]))).resolves.toBe(0);
      });
    } finally {
      process.stdout.write = original;
    }
  });

  it("runs code mode through CLI BYOK when local Brain is offline", async () => {
    const provider = http.createServer((request, response) => {
      expect(request.url).toBe("/v1/chat/completions");
      expect(request.headers.authorization).toBe("Bearer sk-code-test");
      let body = "";
      request.on("data", (chunk) => {
        body += String(chunk);
      });
      request.on("end", () => {
        const parsed = JSON.parse(body) as { model?: string; stream?: boolean; messages?: Array<{ role?: string; content?: unknown }> };
        expect(parsed.model).toBe("code-model");
        expect(parsed.stream).toBe(true);
        expect(JSON.stringify(parsed.messages)).toContain("summarize hello");
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(sse("BYOK code route answered."));
      });
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("provider test server failed to listen");
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(runCode(parseArgs([
        "code",
        "summarize hello",
        "--cwd",
        tmp,
        "--brain-url",
        "http://127.0.0.1:1",
        "--base-url",
        `http://127.0.0.1:${address.port}/v1`,
        "--api-key",
        "sk-code-test",
        "--model",
        "code-model",
        "--max-steps",
        "1",
        "--json",
      ]))).resolves.toBe(0);
    } finally {
      process.stdout.write = original;
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    }

    expect(output).toContain("BYOK code route answered");
  });

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
    expect(finished?.usageSummary).toContain("cache 80 (80%)");
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
