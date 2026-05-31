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

describe("code agent loop · tool calls & repair", () => {
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
    expect(output).toContain('"type":"code.tool.ledger"');
    expect(toolResultTurn).toContain("Tool result for read_file");
    expect(toolResultTurn).toContain("Tool result for glob");
    expect(toolResultTurn).toContain("<lynn_tool_ledger");
    expect(toolResultTurn).toContain("source-of-truth");
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
    const toolTurnBody = JSON.parse(toolResultTurn) as {
      messages?: Array<Record<string, unknown>>;
    };
    expect(toolTurnBody.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "assistant",
        tool_calls: [expect.objectContaining({
          id: "call_1",
          type: "function",
          function: expect.objectContaining({
            name: "read_file",
            arguments: "{\"path\":\"hello.txt\"}",
          }),
        })],
      }),
      expect.objectContaining({
        role: "tool",
        tool_call_id: "call_1",
        name: "read_file",
        content: expect.stringContaining("Tool result for read_file"),
      }),
      expect.objectContaining({
        role: "user",
        content: expect.stringContaining("<lynn_tool_ledger"),
      }),
    ]));
    expect(toolResultTurn).toContain("hello.txt");
    expect(output).toContain("Read streamed tool call result");
  });

  it("keeps runtime instruction frames OpenAI-compatible across resumed code turns", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-cli-runtime-frames-"));
    const sessionPath = await appendSessionTurn({
      dataDir,
      cwd: tmp,
      title: "Prior task",
      prompt: "Earlier user request",
      assistant: "Earlier assistant answer",
      modelProvider: "test",
      modelId: "test-model",
    });
    const original = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      await withBrainServer((body) => {
        const parsed = body as { messages?: Array<{ role?: string; content?: unknown }> };
        const roles = parsed.messages?.map((message) => message.role) || [];
        const contents = parsed.messages?.map((message) => String(message.content || "")) || [];
        expect(roles[0]).toBe("system");
        expect(roles.slice(1)).not.toContain("system");
        expect(roles).toContain("assistant");
        expect(roles.at(-1)).toBe("user");
        const assistantIndex = roles.indexOf("assistant");
        const dynamicIndex = contents.findIndex((content) => content.includes("approval=ask sandbox=workspace-write"));
        expect(dynamicIndex).toBeGreaterThan(assistantIndex);
        const dynamicFrames = contents.filter((content) => content.includes("lynn_runtime_frame")).join("\n");
        expect(dynamicFrames).toContain("approval=ask sandbox=workspace-write");
        expect(dynamicFrames).toContain("Local tool guard");
        return "Runtime frame ordering is compatible.";
      }, async (brainUrl) => {
        await expect(runCode(parseArgs([
          "code",
          "continue safely",
          "--cwd",
          tmp,
          "--brain-url",
          brainUrl,
          "--resume",
          sessionPath,
          "--json",
        ]))).resolves.toBe(0);
      });
    } finally {
      process.stdout.write = original;
      await fs.rm(dataDir, { recursive: true, force: true });
    }
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
    expect(repairTurn).toContain("<lynn_tool_ledger");
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

  it("rebuilds the tool-storm ledger from resume history to avoid repeating completed tools", async () => {
    const sessionPath = path.join(tmp, "resume-tool-storm.jsonl");
    const ts = new Date().toISOString();
    const lines = [
      { type: "user", ts, content: "Read hello.txt and remember it." },
      {
        type: "assistant",
        ts,
        content: "",
        data: {
          tool_calls: [{
            id: "call_seed",
            type: "function",
            function: { name: "read_file", arguments: "{\"path\":\"hello.txt\"}" },
          }],
        },
      },
      {
        type: "tool",
        ts,
        content: "Tool result for read_file:\n{\"ok\":true,\"tool\":\"read_file\",\"output\":{\"path\":\"hello.txt\",\"text\":\"hello\\n\"}}",
        data: { tool_call_id: "call_seed", name: "read_file" },
      },
    ];
    await fs.writeFile(sessionPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");

    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await withBrainServer((_body, count) => {
        if (count === 1) return JSON.stringify({ tool: "read_file", args: { path: "hello.txt" } });
        return "I can continue from the resumed tool result without re-reading.";
      }, async (brainUrl) => {
        await expect(runCode(parseArgs([
          "code",
          "continue from checkpoint",
          "--cwd",
          tmp,
          "--brain-url",
          brainUrl,
          "--resume",
          sessionPath,
          "--max-steps",
          "3",
          "--json",
        ]))).resolves.toBe(0);
      });
    } finally {
      process.stdout.write = original;
    }

    expect(output).toContain('"type":"code.tool.loop_guard"');
    expect(output).toContain("Repeated identical tool request suppressed");
    expect(output).toContain("I can continue from the resumed tool result");
  });

  it("rebuilds mutating tool fingerprints from resume history to avoid duplicate writes", async () => {
    await fs.writeFile(path.join(tmp, "hello.txt"), "changed\n", "utf8");
    const sessionPath = path.join(tmp, "resume-mutating-tool-storm.jsonl");
    const ts = new Date().toISOString();
    const patch = [
      "*** Begin Patch",
      "*** Update File: hello.txt",
      "@@",
      "-hello",
      "+changed",
      "*** End Patch",
      "",
    ].join("\n");
    const lines = [
      { type: "user", ts, content: "Change hello.txt to changed." },
      {
        type: "assistant",
        ts,
        content: "",
        data: {
          tool_calls: [{
            id: "call_patch",
            type: "function",
            function: { name: "apply_patch", arguments: JSON.stringify({ text: patch }) },
          }],
        },
      },
      {
        type: "tool",
        ts,
        content: "Tool result for apply_patch:\n{\"ok\":true,\"tool\":\"apply_patch\",\"output\":{\"changed\":true}}",
        data: { tool_call_id: "call_patch", name: "apply_patch" },
      },
    ];
    await fs.writeFile(sessionPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");

    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await withBrainServer((_body, count) => {
        if (count === 1) return JSON.stringify({ tool: "apply_patch", args: { patch } });
        return "The resumed edit is already complete; no duplicate write needed.";
      }, async (brainUrl) => {
        await expect(runCode(parseArgs([
          "code",
          "continue from edit checkpoint",
          "--cwd",
          tmp,
          "--brain-url",
          brainUrl,
          "--resume",
          sessionPath,
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

    expect(output).toContain('"type":"code.tool.loop_guard"');
    expect(output).toContain("Repeated identical tool request suppressed");
    expect(output).toContain("already complete");
    await expect(fs.readFile(path.join(tmp, "hello.txt"), "utf8")).resolves.toBe("changed\n");
  });

  it("allows a verification read after a mutating edit", async () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: hello.txt",
      "@@",
      "-hello",
      "+changed",
      "*** End Patch",
      "",
    ].join("\n");
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await withBrainServer((_body, count) => {
        if (count === 1) return JSON.stringify({ tool: "read_file", args: { path: "hello.txt" } });
        if (count === 2) return JSON.stringify({ tool: "apply_patch", args: { patch } });
        if (count === 3) return JSON.stringify({ tool: "read_file", args: { path: "hello.txt" } });
        return "Verified changed content.";
      }, async (brainUrl) => {
        await expect(runCode(parseArgs([
          "code",
          "change hello and verify",
          "--cwd",
          tmp,
          "--brain-url",
          brainUrl,
          "--approval",
          "yolo",
          "--max-steps",
          "5",
          "--json",
        ]))).resolves.toBe(0);
      });
    } finally {
      process.stdout.write = original;
    }

    expect(output).not.toContain('"type":"code.tool.loop_guard"');
    expect(output).toContain("Verified changed content.");
    await expect(fs.readFile(path.join(tmp, "hello.txt"), "utf8")).resolves.toBe("changed\n");
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

});
