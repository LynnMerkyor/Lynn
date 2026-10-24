import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stableRuntimePrefix } from "../../shared/runtime-instruction-frames.js";
import { parseArgs } from "../src/args.js";
import { buildCodeRuntimeFrames, codeTaskPrompt, loadResumeMessages, renderCodeHeadlessHelp, renderCodeIntro, renderCodeTaskHeader, runCode } from "../src/commands/code.js";
import { setLang } from "../src/i18n.js";
import { computeStablePrefixDiagnostics } from "../src/session/prefix-diagnostics.js";
import { runClientTool } from "../src/tools/registry.js";

let tmp = "";

beforeEach(() => setLang("en"));
afterEach(() => setLang(null));

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-cli-tools-"));
  await fs.mkdir(path.join(tmp, "src"), { recursive: true });
  await fs.writeFile(path.join(tmp, "src", "hello.ts"), "export const hello = 'world';\n", "utf8");
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});
describe("code tools", () => {


  it("keeps cacheable code instructions separate from dynamic permission state", () => {
    const baseContext = {
      cwd: "/repo",
      gitStatus: "",
      gitDiffStat: "",
      topFiles: [],
      packageScripts: {},
    };
    const frames = buildCodeRuntimeFrames({
      context: baseContext,
      toolCtx: {
        cwd: "/repo",
        approval: "ask",
        sandbox: "workspace-write",
      },
    });
    const yoloFrames = buildCodeRuntimeFrames({
      context: {
        ...baseContext,
      },
      toolCtx: {
        cwd: "/repo",
        approval: "yolo",
        sandbox: "danger-full-access",
      },
    });
    const prefix = stableRuntimePrefix(frames);
    const yoloPrefix = stableRuntimePrefix(yoloFrames);

    expect(prefix).toContain("base_system:");
    expect(prefix).toContain("cacheable_context:Repository root: /repo");
    expect(prefix).not.toContain("approval=ask");
    expect(prefix).toBe(yoloPrefix);
    expect(computeStablePrefixDiagnostics(frames).stablePrefixHash).toBe(computeStablePrefixDiagnostics(yoloFrames).stablePrefixHash);
    expect(frames.find((frame) => frame.kind === "permission_state")).toMatchObject({ stable: false, cacheable: false });
    expect(frames.find((frame) => frame.kind === "tool_guard")).toMatchObject({ stable: false, cacheable: false });
  });


  it("kills long-running bash commands when backgrounding is disabled", async () => {
    process.env.LYNN_CLI_BACKGROUND_ON_TIMEOUT = "0";
    try {
      const result = await runClientTool({ cwd: tmp, approval: "yolo", timeoutMs: 50 }, { name: "bash", command: "node -e \"setTimeout(()=>{}, 1000)\"" });
      expect(result.ok).toBe(false);
      expect(result.output).toMatchObject({ timedOut: true });
    } finally {
      delete process.env.LYNN_CLI_BACKGROUND_ON_TIMEOUT;
    }
  });


  it("applies a git patch inside the workspace", async () => {
    const patch = [
      "diff --git a/src/hello.ts b/src/hello.ts",
      "index 5f836d9..eafb5d8 100644",
      "--- a/src/hello.ts",
      "+++ b/src/hello.ts",
      "@@ -1 +1 @@",
      "-export const hello = 'world';",
      "+export const hello = 'lynn';",
      "",
    ].join("\n");

    const result = await runClientTool({ cwd: tmp, approval: "yolo" }, { name: "apply_patch", text: patch });
    const text = await fs.readFile(path.join(tmp, "src", "hello.ts"), "utf8");

    expect(result.ok).toBe(true);
    expect(text).toContain("lynn");
  });


  it("applies Codex-style Begin Patch updates and additions", async () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/hello.ts",
      "@@",
      "-export const hello = 'world';",
      "+export const hello = 'codex';",
      "*** Add File: src/new.ts",
      "+export const added = true;",
      "*** End Patch",
      "",
    ].join("\n");

    const result = await runClientTool({ cwd: tmp, approval: "yolo" }, { name: "apply_patch", text: patch });
    const hello = await fs.readFile(path.join(tmp, "src", "hello.ts"), "utf8");
    const added = await fs.readFile(path.join(tmp, "src", "new.ts"), "utf8");

    expect(result.ok).toBe(true);
    expect(result.output).toMatchObject({ format: "codex-patch", files: ["src/hello.ts", "src/new.ts"] });
    expect(hello).toContain("codex");
    expect(added).toContain("added");
  });


  it("applies Codex-style Begin Patch file moves", async () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/hello.ts",
      "*** Move to: src/greeting.ts",
      "@@",
      "-export const hello = 'world';",
      "+export const hello = 'moved';",
      "*** End Patch",
      "",
    ].join("\n");

    const result = await runClientTool({ cwd: tmp, approval: "yolo" }, { name: "apply_patch", text: patch });
    const moved = await fs.readFile(path.join(tmp, "src", "greeting.ts"), "utf8");

    await expect(fs.access(path.join(tmp, "src", "hello.ts"))).rejects.toThrow();
    expect(result.ok).toBe(true);
    expect(result.output).toMatchObject({ format: "codex-patch", files: ["src/greeting.ts"] });
    expect(moved).toContain("moved");
  });


  it("parses CLI timeout flags for bash tools", async () => {
    process.env.LYNN_CLI_BACKGROUND_ON_TIMEOUT = "0";
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(runCode(parseArgs([
        "code",
        "--tool",
        "bash",
        "--command",
        "node -e \"setTimeout(()=>{}, 1000)\"",
        "--approval",
        "yolo",
        "--timeout-ms",
        "50",
        "--json",
      ]))).resolves.toBe(1);
    } finally {
      process.stdout.write = original;
      delete process.env.LYNN_CLI_BACKGROUND_ON_TIMEOUT;
    }
    expect(output).toContain("\"timedOut\":true");
  });


  it("uses saved CLI permission profile for direct code tools", async () => {
    await fs.mkdir(path.join(tmp, "permissions"), { recursive: true });
    await fs.writeFile(path.join(tmp, "permissions", "cli.json"), JSON.stringify({
      approval: "yolo",
      sandbox: "danger-full-access",
    }));

    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(runCode(parseArgs([
        "code",
        "--tool",
        "write_file",
        "--path",
        "out.txt",
        "--text",
        "profile ok",
        "--cwd",
        tmp,
        "--data-dir",
        tmp,
        "--json",
      ]))).resolves.toBe(0);
    } finally {
      process.stdout.write = original;
    }

    await expect(fs.readFile(path.join(tmp, "out.txt"), "utf8")).resolves.toBe("profile ok");
    expect(output).toContain("\"ok\":true");
  });


  it("runs code command list-tools", async () => {
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(runCode(parseArgs(["code", "--list-tools", "--json"]))).resolves.toBe(0);
    } finally {
      process.stdout.write = original;
    }
    expect(output).toContain("code.tools");
  });


  it("answers code headless version questions locally", async () => {
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(runCode(parseArgs([
        "code",
        "-p",
        "你的版本号",
        "--json",
        "--brain-url",
        "http://127.0.0.1:1",
      ]))).resolves.toBe(0);
    } finally {
      process.stdout.write = original;
    }
    expect(output).toContain("\"type\":\"assistant.delta\"");
    expect(output).toContain("Lynn CLI 版本");
    expect(output).toContain("\"local\":true");
    expect(output).not.toContain("fetch failed");
  });


  it("answers code headless model route questions locally", async () => {
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(runCode(parseArgs([
        "code",
        "-p",
        "你现在工作模型是什么模型",
        "--json",
        "--brain-url",
        "http://127.0.0.1:1",
      ]))).resolves.toBe(0);
    } finally {
      process.stdout.write = original;
    }
    expect(output).toContain("\"type\":\"assistant.delta\"");
    expect(output).toContain("模型路由:Step 5 Preview");
    expect(output).toContain("\"local\":true");
    expect(output).not.toContain("fetch failed");
  });


  it("renders an interactive code-mode intro with full model route and permission mode", () => {
    const intro = renderCodeIntro({ approval: "ask", sandbox: "workspace-write" });

    expect(intro).toContain("Lynn Code");
    expect(intro).toContain("Step 5 Preview");
    expect(intro).toContain("directory:");
    expect(intro).toContain("/fast");
    expect(intro).toContain("/think");
    expect(intro).toContain("/yolo");
    expect(intro).not.toContain(">_");
  });


  it("renders a clear danger warning for YOLO mode", () => {
    const intro = renderCodeIntro({ approval: "yolo", sandbox: "danger-full-access" });

    expect(intro).toContain("YOLO mode can edit files");
  });


  it("localizes the YOLO danger warning", () => {
    setLang("zh");
    const intro = renderCodeIntro({ approval: "yolo", sandbox: "danger-full-access" });

    expect(intro).toContain("YOLO 模式可直接编辑文件");
    expect(intro).toContain("shell 命令");
  });


  it("renders CLI BYOK route in code intro and task header", () => {
    const provider = {
      provider: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-test",
      model: "step-3.7-flash",
    };
    const intro = renderCodeIntro(
      { approval: "ask", sandbox: "workspace-write" },
      { effort: "auto", display: "auto" },
      { modelLabel: `CLI BYOK: ${provider.provider} / ${provider.model}` },
    );
    const header = renderCodeTaskHeader({
      cwd: "/repo",
      approval: "ask",
      sandbox: "workspace-write",
      reasoning: { effort: "auto", display: "auto" },
      maxSteps: 8,
      fallbackProvider: provider,
    });

    expect(intro).toContain("CLI BYOK: openai-compatible / step-3.7-flash");
    expect(header).toContain("CLI BYOK: StepFun 3.7 Flash (step-3.7-flash)");
  });


  it("renders a code task header with route, cwd, mode, reasoning, and step budget", () => {
    const header = renderCodeTaskHeader({
      cwd: "/repo",
      approval: "ask",
      sandbox: "workspace-write",
      reasoning: { effort: "auto", display: "auto" },
      maxSteps: 8,
    });

    expect(header).toContain("Step 5 Preview");
    expect(header).toContain("/repo");
    expect(header).toContain("ask / workspace-write");
    expect(header).toContain("think:");
    expect(header).toContain("auto");
    expect(header).toContain("max steps 8");
  });


  it("localizes code intro and task header labels in Chinese", () => {
    setLang("zh");
    const intro = renderCodeIntro({ approval: "ask", sandbox: "workspace-write" });
    const header = renderCodeTaskHeader({
      cwd: "/repo",
      approval: "ask",
      sandbox: "workspace-write",
      reasoning: { effort: "auto", display: "auto" },
      maxSteps: 8,
      mockBrain: true,
    });

    expect(intro).toContain("模型:");
    expect(intro).toContain("目录:");
    expect(header).toContain("模拟 Brain");
    expect(header).toContain("思考:");
    expect(header).toContain("最多 8 步");
  });


  it("runs a read-only code task with repository context", async () => {
    const original = process.stdout.write;
    const originalErr = process.stderr.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      await expect(runCode(parseArgs(["code", "review current diff", "--cwd", tmp, "--mock-brain"]))).resolves.toBe(0);
    } finally {
      process.stdout.write = original;
      process.stderr.write = originalErr;
    }
    expect(output).toContain("Mock code task: review current diff");
    expect(output).toContain("Directory:");
  });


  it("accepts -p/--prompt as a headless code task for agent callers", async () => {
    expect(codeTaskPrompt(parseArgs(["code", "-p", "review current diff"]))).toBe("review current diff");
    expect(codeTaskPrompt(parseArgs(["code", "--prompt", "review", "src/cli.ts"]))).toBe("review\n\nsrc/cli.ts");

    const original = process.stdout.write;
    const originalErr = process.stderr.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      await expect(runCode(parseArgs([
        "code",
        "-p",
        "headless agent task",
        "--cwd",
        tmp,
        "--mock-brain",
        "--json",
      ]))).resolves.toBe(0);
    } finally {
      process.stdout.write = original;
      process.stderr.write = originalErr;
    }

    expect(output).toContain('"type":"code.task.started"');
    expect(output).toContain('"task":"headless agent task"');
    expect(output).toContain('"type":"code.task.finished"');
    expect(output).not.toContain("code mode ready");
  });


  it("renders copyable headless help for agent callers", async () => {
    const help = renderCodeHeadlessHelp();
    expect(help).toContain("Lynn code -p \"fix tests");
    expect(help).toContain("--approval yolo --sandbox danger-full-access");
    expect(help).toContain("交互式 ask 模式会逐次弹出授权");
    expect(help).toContain("Lynn worker run --brief task.md");
    expect(help).toContain("code.tool.ledger");

    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(runCode(parseArgs(["code", "--help"]))).resolves.toBe(0);
    } finally {
      process.stdout.write = original;
    }
    expect(output).toContain("Lynn code headless / CLI Fleet");
    expect(output).not.toContain("code mode ready");
  });


  it("saves code tasks as GUI-compatible CLI sessions", async () => {
    const original = process.stdout.write;
    const originalErr = process.stderr.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      await expect(runCode(parseArgs([
        "code",
        "save this task",
        "--cwd",
        tmp,
        "--mock-brain",
        "--save-session",
        "--data-dir",
        tmp,
        "--json",
      ]))).resolves.toBe(0);
    } finally {
      process.stdout.write = original;
      process.stderr.write = originalErr;
    }

    expect(output).toContain("session.saved");
    const index = JSON.parse(await fs.readFile(path.join(tmp, "agents", "cli", "sessions", "session-index.json"), "utf8")) as { sessions: Array<{ path: string }> };
    const lines = (await fs.readFile(index.sessions[0].path, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line) as { type: string; data?: { kind?: string } });
    expect(lines.map((line) => line.type)).toEqual(["user", "assistant", "metadata"]);
    expect(lines.at(-1)?.data?.kind).toBe("code_task");
  });


  it("compacts older saved turns when resuming long-running code sessions", async () => {
    const sessionFile = path.join(tmp, "long-session.jsonl");
    const turns = [
      { type: "user", content: "old user " + "u".repeat(120) },
      { type: "assistant", content: "old assistant " + "a".repeat(120) },
      { type: "user", content: "latest user detail" },
      { type: "assistant", content: "latest assistant detail" },
    ];
    await fs.writeFile(sessionFile, turns.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");

    const resumed = await loadResumeMessages(sessionFile, 80);

    expect(resumed[0]).toMatchObject({
      role: "user",
      content: expect.stringContaining("old user"),
    });
    expect(JSON.stringify(resumed)).toContain("Earlier transcript turns were compacted");
    expect(JSON.stringify(resumed)).not.toContain("old assistant");
    expect(JSON.stringify(resumed)).toContain("latest user detail");
    expect(JSON.stringify(resumed)).toContain("latest assistant detail");
  });


  it("keeps saved assistant tool calls and matching tool results together when resuming", async () => {
    const sessionFile = path.join(tmp, "structured-tool-session.jsonl");
    const turns = [
      { type: "user", content: "inspect the file" },
      {
        type: "assistant",
        content: "",
        data: {
          tool_calls: [{
            id: "call_read",
            type: "function",
            function: { name: "read_file", arguments: "{\"path\":\"src/hello.ts\"}" },
          }],
        },
      },
      {
        type: "tool",
        content: "Tool result for read_file\nhello",
        data: { tool_call_id: "call_read", name: "read_file" },
      },
      { type: "assistant", content: "I saw hello.ts." },
    ];
    await fs.writeFile(sessionFile, turns.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");

    const resumed = await loadResumeMessages(sessionFile, 2_000);

    expect(resumed).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "assistant",
        tool_calls: [expect.objectContaining({ id: "call_read" })],
      }),
      expect.objectContaining({
        role: "tool",
        tool_call_id: "call_read",
        content: expect.stringContaining("Tool result for read_file"),
      }),
    ]));
  });


  it("drops orphan tool results when resume compaction cuts off their assistant tool call", async () => {
    const sessionFile = path.join(tmp, "orphan-tool-session.jsonl");
    const turns = [
      { type: "user", content: "old task" },
      {
        type: "assistant",
        content: "",
        data: {
          tool_calls: [{
            id: "call_big",
            type: "function",
            function: { name: "grep", arguments: JSON.stringify({ query: "needle".repeat(80) }) },
          }],
        },
      },
      {
        type: "tool",
        content: "short tool result that would have fit alone",
        data: { tool_call_id: "call_big", name: "grep" },
      },
      { type: "user", content: "latest instruction" },
    ];
    await fs.writeFile(sessionFile, turns.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");

    const resumed = await loadResumeMessages(sessionFile, 80);

    expect(resumed).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", content: "latest instruction" }),
    ]));
    expect(resumed.some((message) => message.role === "tool")).toBe(false);
    expect(JSON.stringify(resumed)).not.toContain("call_big");
  });


  it("repairs incomplete tool chains by synthesizing the missing tool result", async () => {
    const sessionFile = path.join(tmp, "incomplete-tool-session.jsonl");
    const turns = [
      { type: "user", content: "try a tool" },
      {
        type: "assistant",
        content: "I was about to inspect a file.",
        data: {
          tool_calls: [{
            id: "call_missing",
            type: "function",
            function: { name: "read_file", arguments: "{\"path\":\"missing.ts\"}" },
          }],
        },
      },
      { type: "user", content: "continue safely" },
    ];
    await fs.writeFile(sessionFile, turns.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");

    const resumed = await loadResumeMessages(sessionFile, 2_000);
    const assistant = resumed.find((message) => message.role === "assistant" && typeof message.content === "string" && message.content.includes("about to inspect"));

    expect(assistant).toBeTruthy();
    expect(assistant?.tool_calls?.length).toBe(1);
    const synth = resumed.find((message) => message.role === "tool"
      && (message as { tool_call_id?: string }).tool_call_id === "call_missing") as { content: string } | undefined;
    expect(synth?.content).toContain("did not finish");
  });
});
