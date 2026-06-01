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
import type { ChatMessage } from "../src/brain-client.js";
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

describe("code agent loop · core & approvals", () => {
  it("compacts old runtime loop turns while keeping the anchored goal", () => {
    const messages: ChatMessage[] = [
      { role: "system" as const, content: "stable prefix" },
      { role: "user" as const, content: "ORIGINAL TASK: keep me" },
      ...Array.from({ length: 20 }, (_, index) => ({ role: index % 2 ? "assistant" as const : "user" as const, content: `old turn ${index} ${"x".repeat(200)}` })),
    ];
    const compacted = compactRuntimeMessages(messages, 2_000, 4, 2);
    expect(compacted).toBeGreaterThan(0);
    expect(messages[0]).toMatchObject({ role: "system", content: "stable prefix" });
    expect(messages[1]).toMatchObject({ role: "user", content: "ORIGINAL TASK: keep me" });
    expect(JSON.stringify(messages)).toContain("runtime compaction");
    expect(JSON.stringify(messages)).toContain("old turn 19");
  });

  it("keeps recent assistant tool-call frames atomic during runtime compaction", () => {
    const recentToolCall = {
      role: "assistant" as const,
      content: "",
      tool_calls: [
        { id: "call_read", type: "function" as const, function: { name: "read_file", arguments: "{\"path\":\"a.ts\"}" } },
        { id: "call_grep", type: "function" as const, function: { name: "grep", arguments: "{\"query\":\"TODO\"}" } },
      ],
    };
    const messages: ChatMessage[] = [
      { role: "system" as const, content: "stable prefix" },
      { role: "user" as const, content: "ORIGINAL TASK: keep me" },
      ...Array.from({ length: 18 }, (_, index) => ({
        role: index % 2 ? "assistant" as const : "user" as const,
        content: `old turn ${index} ${"x".repeat(260)}`,
      })),
      recentToolCall,
      { role: "tool" as const, tool_call_id: "call_read", content: "read result" },
      { role: "tool" as const, tool_call_id: "call_grep", content: "grep result" },
      { role: "assistant" as const, content: "next step" },
    ];

    expect(compactRuntimeMessages(messages, 2_000, 2, 2)).toBeGreaterThan(0);
    const assistantIndex = messages.findIndex((message) => message.role === "assistant" && message.tool_calls?.[0]?.id === "call_read");
    expect(assistantIndex).toBeGreaterThan(0);
    expect(messages[assistantIndex + 1]).toMatchObject({ role: "tool", tool_call_id: "call_read", content: "read result" });
    expect(messages[assistantIndex + 2]).toMatchObject({ role: "tool", tool_call_id: "call_grep", content: "grep result" });
  });

  it("emits a runtime compaction event during long tool loops", async () => {
    for (let index = 1; index <= 12; index += 1) {
      await fs.writeFile(path.join(tmp, `big-${index}.txt`), `chunk ${index}\n${"x".repeat(35_000)}`, "utf8");
    }
    const events: CodeAgentEvent[] = [];
    await withBrainServer((_body, count) => count <= 12
      ? JSON.stringify({ tool: "read_file", args: { path: `big-${count}.txt` } })
      : "Finished after reading the large files.",
    async (brainUrl) => {
      await expect(runCodeTaskWithEvents(parseArgs([
        "code",
        "read several large files and summarize them",
        "--cwd",
        tmp,
        "--brain-url",
        brainUrl,
        "--max-steps",
        "14",
      ]), "read several large files and summarize them", (event) => {
        events.push(event);
      })).resolves.toBe(0);
    });

    expect(events.some((event) => event.type === "runtime.compacted" && event.messages > 0)).toBe(true);
    expect(events.some((event) => event.type === "task.finished" && event.ok)).toBe(true);
  });

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

  it("keeps code --json output machine-readable when reasoning deltas stream", async () => {
    const originalOut = process.stdout.write;
    const originalErr = process.stderr.write;
    let output = "";
    let stderr = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      await withRawBrainServer(() => rawSsePayloads([
        JSON.stringify({ choices: [{ delta: { reasoning_content: "think quietly" } }] }),
        JSON.stringify({ choices: [{ delta: { content: "Done." } }] }),
      ]), async (brainUrl) => {
        await expect(runCode(parseArgs([
          "code",
          "answer without tools",
          "--cwd",
          tmp,
          "--brain-url",
          brainUrl,
          "--json",
        ]))).resolves.toBe(0);
      });
    } finally {
      process.stdout.write = originalOut;
      process.stderr.write = originalErr;
    }

    expect(output).toContain('"type":"reasoning.delta"');
    expect(output).toContain('"hidden":true');
    expect(output).toContain('"type":"code.task.finished"');
    expect(stderr).not.toContain("think quietly");
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

  it("does not prompt for per-tool approval in yolo mode", async () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: hello.txt",
      "@@",
      "-hello",
      "+yolo",
      "*** End Patch",
      "",
    ].join("\n");
    let approvalCallbacks = 0;
    await withBrainServer((_body, count) => count === 1
      ? JSON.stringify({ tool: "apply_patch", args: { patch } })
      : "YOLO patch applied.",
    async (brainUrl) => {
      await expect(runCodeTaskWithEvents(parseArgs([
        "code",
        "patch without asking",
        "--cwd",
        tmp,
        "--brain-url",
        brainUrl,
        "--approval",
        "yolo",
        "--sandbox",
        "danger-full-access",
        "--max-steps",
        "3",
      ]), "patch without asking", () => {}, {
        requestApproval: async () => {
          approvalCallbacks += 1;
          return "deny";
        },
      })).resolves.toBe(0);
    });

    await expect(fs.readFile(path.join(tmp, "hello.txt"), "utf8")).resolves.toBe("yolo\n");
    expect(approvalCallbacks).toBe(0);
  });

  it("emits visible plan updates from TodoWrite-style tool calls", async () => {
    const events: CodeAgentEvent[] = [];
    await withBrainServer((_body, count) => count === 1
      ? JSON.stringify({
          tool: "TodoWrite",
          args: {
            todos: [
              { id: "S0", content: "探索代码库结构", status: "completed" },
              { id: "C1", content: "实现修复", status: "in_progress" },
            ],
          },
        })
      : "Plan noted; continuing with the task.",
    async (brainUrl) => {
      await expect(runCodeTaskWithEvents(parseArgs([
        "code",
        "plan first",
        "--cwd",
        tmp,
        "--brain-url",
        brainUrl,
        "--max-steps",
        "3",
      ]), "plan first", (event) => {
        events.push(event);
      })).resolves.toBe(0);
    });

    expect(events).toContainEqual({
      type: "plan.updated",
      items: [
        { id: "S0", content: "探索代码库结构", status: "completed" },
        { id: "C1", content: "实现修复", status: "in_progress" },
      ],
    });
    expect(events.some((event) => event.type === "tool.result" && event.result.tool === "update_plan")).toBe(true);
  });

  it("emits session resume/save events for Ink goal visibility", async () => {
    const dataDir = path.join(tmp, "event-session-data");
    const sessionPath = await appendSessionTurn({
      dataDir,
      cwd: tmp,
      title: "saved task",
      prompt: "previous task",
      assistant: "previous answer",
    });
    const events: CodeAgentEvent[] = [];

    await expect(runCodeTaskWithEvents(parseArgs([
      "code",
      "continue saved work",
      "--cwd",
      tmp,
      "--mock-brain",
      "--resume",
      sessionPath,
      "--save-session",
      "--data-dir",
      dataDir,
    ]), "continue saved work", (event) => {
      events.push(event);
    })).resolves.toBe(0);

    expect(events).toContainEqual({
      type: "session.resumed",
      path: sessionPath,
      messages: expect.any(Number),
    });
    expect(events.some((event) => event.type === "session.saved" && event.path === sessionPath)).toBe(true);
  });

  interactivePtyIt("uses the Ink code shell for mock coding turns", async () => {
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
env["LYNN_CLI_UPDATE_CHECK"] = "0"
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
sent_task = False
sent_exit = False
exit_ready_at = None
deadline = time.time() + 75
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
        if (not sent_task) and "Lynn Code" in text:
            os.write(master, "hi\\r".encode("utf-8"))
            sent_task = True
        elif sent_task and (not sent_exit) and exit_ready_at is None and "模拟编码任务" in text and "Git:干净" in text:
            exit_ready_at = time.time() + 0.25
    if sent_task and (not sent_exit) and exit_ready_at is not None and time.time() >= exit_ready_at:
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
    expect(result.stdout).toContain("模拟编码任务");
  }, 100_000);

});
