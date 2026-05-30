import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";
import { maxSteps, runCode, runCodeTaskWithEvents, type CodeAgentEvent } from "../src/commands/code.js";
import { appendSessionTurn, readSessionLines, sessionIndexPath } from "../src/session/store.js";

let tmp = "";
const cliRoot = fileURLToPath(new URL("..", import.meta.url));
const pythonIt = hasPython3() ? it : it.skip;

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

  it("emits approval_required for dangerous tools in non-interactive JSON mode", async () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: hello.txt",
      "@@",
      "-hello",
      "+lynn",
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
      await withBrainServer(() => JSON.stringify({ tool: "apply_patch", args: { patch } }), async (brainUrl) => {
        await expect(runCode(parseArgs([
          "code",
          "change hello to lynn",
          "--cwd",
          tmp,
          "--brain-url",
          brainUrl,
          "--approval",
          "ask",
          "--max-steps",
          "1",
          "--json",
        ]))).resolves.toBe(2);
      });
    } finally {
      process.stdout.write = original;
    }

    expect(output).toContain('"type":"code.tool.approval_required"');
    expect(output).toContain('"status":"waiting_approval"');
    expect(output).toContain('"tool":"apply_patch"');
    expect(output).toContain('"type":"code.tool.result"');
    expect(output).toContain('"ok":false');
  });

  it("runs dangerous tools in on-failure approval mode without blocking non-interactive loops", async () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: hello.txt",
      "@@",
      "-hello",
      "+lynn",
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
      await withBrainServer((_body, count) => count === 1
        ? JSON.stringify({ tool: "apply_patch", args: { patch } })
        : "Patch applied after on-failure approval mode.",
      async (brainUrl) => {
        await expect(runCode(parseArgs([
          "code",
          "change hello to lynn",
          "--cwd",
          tmp,
          "--brain-url",
          brainUrl,
          "--approval",
          "on-failure",
          "--max-steps",
          "3",
          "--json",
        ]))).resolves.toBe(0);
      });
    } finally {
      process.stdout.write = original;
    }

    await expect(fs.readFile(path.join(tmp, "hello.txt"), "utf8")).resolves.toBe("lynn\n");
    expect(output).not.toContain('"type":"code.tool.approval_required"');
    expect(output).toContain('"type":"code.tool.result"');
    expect(output).toContain('"ok":true');
    expect(output).toContain("Patch applied after on-failure approval mode");
  });

  it("emits code agent events and uses UI approval callbacks", async () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: hello.txt",
      "@@",
      "-hello",
      "+evented",
      "*** End Patch",
      "",
    ].join("\n");
    const events: CodeAgentEvent[] = [];
    try {
      await withBrainServer((_body, count) => count === 1
        ? JSON.stringify({ tool: "apply_patch", args: { patch } })
        : "Evented patch applied.",
      async (brainUrl) => {
        await expect(runCodeTaskWithEvents(parseArgs([
          "code",
          "change hello through event UI",
          "--cwd",
          tmp,
          "--brain-url",
          brainUrl,
          "--approval",
          "ask",
          "--max-steps",
          "3",
        ]), "change hello through event UI", (event) => {
          events.push(event);
        }, {
          requestApproval: async (request) => {
            expect(request.tool).toBe("apply_patch");
            expect(request.preview).toContain("patch preview");
            return "approve_all";
          },
        })).resolves.toBe(0);
      });
    } finally {
      // Nothing to restore; the event UI path must not patch stdout/stderr.
    }

    await expect(fs.readFile(path.join(tmp, "hello.txt"), "utf8")).resolves.toBe("evented\n");
    expect(events.some((event) => event.type === "tool.requested" && event.tool === "apply_patch")).toBe(true);
    expect(events.some((event) => event.type === "tool.result" && event.result.ok)).toBe(true);
    expect(events.some((event) => event.type === "task.finished" && event.ok)).toBe(true);
  });

  pythonIt("uses the Ink code shell for mock coding turns and Shift+Tab mode toggle", async () => {
    const script = `
import os
import pty
import select
import subprocess
import sys
import time

node_bin, cwd, workspace = sys.argv[1], sys.argv[2], sys.argv[3]
master, slave = pty.openpty()
env = os.environ.copy()
env["NO_COLOR"] = "1"
env["LYNN_LANG"] = "zh"
proc = subprocess.Popen(
    [node_bin, "--import", "tsx", "src/cli.ts", "code", "--cwd", workspace, "--mock-brain"],
    cwd=cwd,
    stdin=slave,
    stdout=slave,
    stderr=slave,
    env=env,
    close_fds=True,
)
os.close(slave)
buf = b""
toggled = False
sent_task = False
sent_exit = False
deadline = time.time() + 12
while time.time() < deadline:
    readable, _, _ = select.select([master], [], [], 0.1)
    if readable:
        try:
            chunk = os.read(master, 4096)
        except OSError:
            break
        if not chunk:
            break
        buf += chunk
        text = buf.decode("utf-8", errors="replace")
        if (not toggled) and "Lynn Code" in text and "Shift+Tab" in text:
            os.write(master, b"\\x1b[Z")
            toggled = True
        elif toggled and (not sent_task) and "YOLO" in text:
            os.write(master, "hi\\r".encode("utf-8"))
            sent_task = True
        elif sent_task and (not sent_exit) and "模拟编码任务" in text:
            os.write(master, b"/exit\\r")
            sent_exit = True
    if sent_exit and proc.poll() is not None:
        break
if proc.poll() is None:
    proc.terminate()
    try:
        proc.wait(timeout=1)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
text = buf.decode("utf-8", errors="replace")
if not toggled:
    sys.stderr.write("Shift+Tab was not sent\\n")
if not sent_task:
    sys.stderr.write("mock task was not sent\\n")
sys.stdout.write(text)
sys.exit(proc.returncode if proc.returncode is not None else 124)
`;
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn("python3", ["-c", script, process.execPath, cliRoot, tmp], {
        cwd: cliRoot,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Lynn Code");
    expect(result.stdout).toContain("YOLO");
    expect(result.stdout).toContain("模拟编码任务");
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
        expect(roles[0]).toBe("system");
        expect(roles.slice(1)).not.toContain("system");
        expect(roles).toContain("assistant");
        expect(roles.at(-1)).toBe("user");
        const dynamicFrames = parsed.messages?.slice(1, 3).map((message) => String(message.content || "")).join("\n") || "";
        expect(dynamicFrames).toContain("lynn_runtime_frame");
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

  it("passes code --image through CLI BYOK in a real subprocess", async () => {
    const image = path.join(tmp, "subprocess-shot.png");
    await fs.writeFile(image, Buffer.from("89504e470d0a1a0a", "hex"));
    let requestBody = "";
    const provider = http.createServer((request, response) => {
      expect(request.url).toBe("/v1/chat/completions");
      expect(request.headers.authorization).toBe("Bearer sk-code-image");
      request.on("data", (chunk) => { requestBody += String(chunk); });
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(sse("Reviewed BYOK screenshot."));
      });
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("provider test server failed to listen");

    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [
        "--import",
        "tsx",
        "src/cli.ts",
        "code",
        "review this screenshot",
        "--cwd",
        tmp,
        "--brain-url",
        "http://127.0.0.1:1",
        "--base-url",
        `http://127.0.0.1:${address.port}/v1`,
        "--api-key",
        "sk-code-image",
        "--model",
        "code-image-model",
        "--image",
        image,
        "--max-steps",
        "1",
        "--json",
      ], {
        cwd: cliRoot,
        env: { ...process.env, NO_COLOR: "1", LYNN_LANG: "en" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("code image subprocess did not exit"));
      }, 8000);
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
    await new Promise<void>((resolve) => provider.close(() => resolve()));

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('"activeProvider":"cli-byok:openai-compatible"');
    expect(result.stdout).toContain("Reviewed BYOK screenshot.");
    const parsed = JSON.parse(requestBody) as { model?: string; messages?: Array<{ role?: string; content?: unknown }> };
    expect(parsed.model).toBe("code-image-model");
    const multimodalUser = parsed.messages?.find((message) => Array.isArray(message.content));
    expect(multimodalUser).toBeTruthy();
    const serialized = JSON.stringify(multimodalUser?.content);
    expect(serialized).toContain("Attached images:");
    expect(serialized).toContain("data:image/png;base64");
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

  it("runs a real CLI BYOK code subprocess through apply_patch and bash", async () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: hello.txt",
      "@@",
      "-hello",
      "+lynn",
      "*** End Patch",
      "",
    ].join("\n");
    const command = "python3 -c \"import pathlib; assert pathlib.Path('hello.txt').read_text().strip() == 'lynn'\"";
    const requestBodies: unknown[] = [];
    const provider = http.createServer((request, response) => {
      expect(request.url).toBe("/v1/chat/completions");
      expect(request.headers.authorization).toBe("Bearer sk-subprocess-code");
      let raw = "";
      request.on("data", (chunk) => { raw += String(chunk); });
      request.on("end", () => {
        const count = requestBodies.push(JSON.parse(raw));
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (count === 1) {
          response.end(rawSsePayloads([
            JSON.stringify({
              choices: [{
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: "call_patch",
                    type: "function",
                    function: { name: "apply_patch", arguments: JSON.stringify({ text: patch }) },
                  }],
                },
              }],
            }),
            JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
          ]));
          return;
        }
        if (count === 2) {
          response.end(rawSsePayloads([
            JSON.stringify({
              choices: [{
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: "call_test",
                    type: "function",
                    function: { name: "bash", arguments: JSON.stringify({ command }) },
                  }],
                },
              }],
            }),
            JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
          ]));
          return;
        }
        response.end(sse("Patched hello.txt and verified the result."));
      });
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("provider test server failed to listen");

    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [
        "--import",
        "tsx",
        "src/cli.ts",
        "code",
        "change hello.txt to lynn and verify it",
        "--cwd",
        tmp,
        "--brain-url",
        "http://127.0.0.1:1",
        "--base-url",
        `http://127.0.0.1:${address.port}/v1`,
        "--api-key",
        "sk-subprocess-code",
        "--model",
        "code-subprocess-model",
        "--approval",
        "yolo",
        "--sandbox",
        "workspace-write",
        "--max-steps",
        "5",
        "--json",
      ], {
        cwd: cliRoot,
        env: { ...process.env, NO_COLOR: "1", LYNN_LANG: "en" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("code subprocess did not exit"));
      }, 8000);
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
    await new Promise<void>((resolve) => provider.close(() => resolve()));

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('"activeProvider":"cli-byok:openai-compatible"');
    expect(result.stdout).toContain('"fallbackFrom":[{"id":"brain","reason":"offline"}]');
    expect(result.stdout).toContain('"tool":"apply_patch"');
    expect(result.stdout).toContain('"tool":"bash"');
    expect(result.stdout).toContain("Patched hello.txt and verified the result.");
    expect(result.stdout).toContain('"type":"code.task.finished"');
    expect(result.stdout).toContain('"ok":true');
    await expect(fs.readFile(path.join(tmp, "hello.txt"), "utf8")).resolves.toBe("lynn\n");
    expect(JSON.stringify(requestBodies[1])).toContain('"role":"tool"');
    expect(JSON.stringify(requestBodies[2])).toContain('"role":"tool"');
  });

  pythonIt("runs multiple dangerous tools after interactive allow-all approval", async () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: hello.txt",
      "@@",
      "-hello",
      "+approved",
      "*** End Patch",
      "",
    ].join("\n");
    const command = "python3 -c \"import pathlib; assert pathlib.Path('hello.txt').read_text().strip() == 'approved'\"";
    const requestBodies: unknown[] = [];
    const provider = http.createServer((request, response) => {
      expect(request.url).toBe("/v1/chat/completions");
      expect(request.headers.authorization).toBe("Bearer sk-approval-test");
      let raw = "";
      request.on("data", (chunk) => { raw += String(chunk); });
      request.on("end", () => {
        const count = requestBodies.push(JSON.parse(raw));
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (count === 1) {
          response.end(rawSsePayloads([
            JSON.stringify({
              choices: [{
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: "call_patch",
                    type: "function",
                    function: { name: "apply_patch", arguments: JSON.stringify({ text: patch }) },
                  }],
                },
              }],
            }),
            JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
          ]));
          return;
        }
        if (count === 2) {
          response.end(rawSsePayloads([
            JSON.stringify({
              choices: [{
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: "call_test",
                    type: "function",
                    function: { name: "bash", arguments: JSON.stringify({ command }) },
                  }],
                },
              }],
            }),
            JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
          ]));
          return;
        }
        response.end(sse("Interactive allow-all approval applied and verified the patch."));
      });
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("provider test server failed to listen");

    const script = `
import os
import pty
import select
import subprocess
import sys
import time

node_bin, cwd, workspace, provider_url = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
master, slave = pty.openpty()
env = os.environ.copy()
env["NO_COLOR"] = "1"
env["LYNN_LANG"] = "en"
proc = subprocess.Popen(
    [
        node_bin,
        "--import",
        "tsx",
        "src/cli.ts",
        "code",
        "change hello.txt to approved",
        "--cwd",
        workspace,
        "--brain-url",
        "http://127.0.0.1:1",
        "--base-url",
        provider_url,
        "--api-key",
        "sk-approval-test",
        "--model",
        "approval-model",
        "--approval",
        "ask",
        "--sandbox",
        "workspace-write",
        "--max-steps",
        "3",
    ],
    cwd=cwd,
    stdin=slave,
    stdout=slave,
    stderr=slave,
    env=env,
    close_fds=True,
)
os.close(slave)
buf = b""
approved = False
deadline = time.time() + 10
while time.time() < deadline:
    readable, _, _ = select.select([master], [], [], 0.1)
    if readable:
        try:
            chunk = os.read(master, 4096)
        except OSError:
            break
        if not chunk:
            break
        buf += chunk
        text = buf.decode("utf-8", errors="replace")
        if (not approved) and "[y/n/a]" in text:
            os.write(master, b"a\\r")
            approved = True
    if proc.poll() is not None:
        break
if proc.poll() is None:
    proc.terminate()
    try:
        proc.wait(timeout=1)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
text = buf.decode("utf-8", errors="replace")
if not approved:
    sys.stderr.write("approval prompt was not observed\\n")
sys.stdout.write(text)
sys.exit(proc.returncode if proc.returncode is not None else 124)
`;
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn("python3", [
        "-c",
        script,
        process.execPath,
        cliRoot,
        tmp,
        `http://127.0.0.1:${address.port}/v1`,
      ], {
        cwd: cliRoot,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    await new Promise<void>((resolve) => provider.close(() => resolve()));

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Allow apply_patch");
    expect(result.stdout).toContain("Interactive allow-all approval applied and verified the patch.");
    expect((result.stdout.match(/\[y\/n\/a\]/g) || [])).toHaveLength(1);
    await expect(fs.readFile(path.join(tmp, "hello.txt"), "utf8")).resolves.toBe("approved\n");
    expect(JSON.stringify(requestBodies[1])).toContain('"role":"tool"');
    expect(JSON.stringify(requestBodies[2])).toContain('"role":"tool"');
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
