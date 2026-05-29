import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";
import { buildCodeRuntimeFrames, canPromptForDangerousTool, formatToolResultForLoop, isDangerousClientTool, loadResumeMessages, parseCodeToolRequest, renderCodeIntro, renderCodeTaskHeader, runCode } from "../src/commands/code.js";
import { stableRuntimePrefix } from "../../shared/runtime-instruction-frames.js";
import { globToRegExp } from "../src/tools/glob.js";
import { runClientTool } from "../src/tools/registry.js";
import { setLang } from "../src/i18n.js";

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
  it("reads files inside the workspace", async () => {
    const result = await runClientTool({ cwd: tmp, approval: "ask" }, { name: "read_file", path: "src/hello.ts" });

    expect(result.ok).toBe(true);
    expect(String((result.output as { text: string }).text)).toContain("hello");
  });

  it("blocks path traversal", async () => {
    await expect(runClientTool({ cwd: tmp, approval: "ask" }, { name: "read_file", path: "../secret" })).rejects.toThrow("escapes workspace");
  });

  it("blocks symlink escapes for read and write tools", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-cli-outside-"));
    await fs.writeFile(path.join(outside, "secret.txt"), "nope", "utf8");
    await fs.symlink(outside, path.join(tmp, "linked-out"));

    await expect(runClientTool({ cwd: tmp, approval: "ask" }, { name: "read_file", path: "linked-out/secret.txt" })).rejects.toThrow("escapes workspace");
    await expect(runClientTool({ cwd: tmp, approval: "yolo" }, { name: "write_file", path: "linked-out/new.txt", text: "nope" })).rejects.toThrow("escapes workspace");
  });

  it("greps and globs workspace files", async () => {
    const grep = await runClientTool({ cwd: tmp, approval: "ask" }, { name: "grep", query: "world", path: "src" });
    const glob = await runClientTool({ cwd: tmp, approval: "ask" }, { name: "glob", pattern: "**/*.ts" });

    expect(JSON.stringify(grep.output)).toContain("src/hello.ts");
    expect(JSON.stringify(glob.output)).toContain("src/hello.ts");
    expect(globToRegExp("**/*.ts").test("src/hello.ts")).toBe(true);
  });

  it("requires yolo approval for writes and bash", async () => {
    await expect(runClientTool({ cwd: tmp, approval: "ask" }, { name: "write_file", path: "out.txt", text: "x" })).rejects.toThrow("approval yolo");
    await expect(runClientTool({ cwd: tmp, approval: "ask" }, { name: "apply_patch", text: "diff --git a/x b/x\n" })).rejects.toThrow("approval yolo");
    await expect(runClientTool({ cwd: tmp, approval: "ask" }, { name: "bash", command: "pwd" })).rejects.toThrow("approval yolo");
  });

  it("blocks dangerous tools in read-only sandbox even with yolo approval", async () => {
    await expect(runClientTool({ cwd: tmp, approval: "yolo", sandbox: "read-only" }, { name: "write_file", path: "out.txt", text: "x" })).rejects.toThrow("read-only sandbox");
    await expect(runClientTool({ cwd: tmp, approval: "yolo", sandbox: "read-only" }, { name: "apply_patch", text: "diff --git a/x b/x\n" })).rejects.toThrow("read-only sandbox");
    await expect(runClientTool({ cwd: tmp, approval: "yolo", sandbox: "read-only" }, { name: "bash", command: "pwd" })).rejects.toThrow("read-only sandbox");
  });

  it("knows which client tools need confirmation", () => {
    expect(isDangerousClientTool("read_file")).toBe(false);
    expect(isDangerousClientTool("grep")).toBe(false);
    expect(isDangerousClientTool("write_file")).toBe(true);
    expect(isDangerousClientTool("apply_patch")).toBe(true);
    expect(isDangerousClientTool("bash")).toBe(true);
    expect(canPromptForDangerousTool({ isTTY: true }, { isTTY: true }, false)).toBe(true);
    expect(canPromptForDangerousTool({ isTTY: true }, { isTTY: true }, true)).toBe(false);
    expect(canPromptForDangerousTool({ isTTY: false }, { isTTY: true }, false)).toBe(false);
  });

  it("parses model-requested tool JSON", () => {
    expect(parseCodeToolRequest('{"tool":"grep","args":{"query":"TODO","path":"src"}}')).toMatchObject({
      tool: "grep",
      args: { query: "TODO", path: "src" },
    });
    expect(parseCodeToolRequest('```json\n{"tool":"apply_patch","args":{"patch":"diff"}}\n```')).toMatchObject({
      tool: "apply_patch",
      args: { text: "diff" },
    });
    expect(parseCodeToolRequest("Here is a normal answer.")).toBeNull();
  });

  it("parses common OpenAI-style and top-level tool JSON variants", () => {
    expect(parseCodeToolRequest('{"name":"grep","arguments":{"query":"MiMo"}}')).toMatchObject({
      tool: "grep",
      args: { query: "MiMo" },
    });
    expect(parseCodeToolRequest('{"name":"read_file","arguments":"{\\"path\\":\\"README.md\\"}"}')).toMatchObject({
      tool: "read_file",
      args: { path: "README.md" },
    });
    expect(parseCodeToolRequest('{"tool":"bash","command":"pwd"}')).toMatchObject({
      tool: "bash",
      args: { command: "pwd" },
    });
    expect(parseCodeToolRequest('{"name":"read_file","input":{"path":"cli/src/cli.ts"}}')).toMatchObject({
      tool: "read_file",
      args: { path: "cli/src/cli.ts" },
    });
    expect(parseCodeToolRequest('{"function":{"name":"glob","arguments":"{\\"pattern\\":\\"**/*.ts\\",\\"path\\":\\"cli/src\\"}"}}')).toMatchObject({
      tool: "glob",
      args: { pattern: "**/*.ts", path: "cli/src" },
    });
    expect(parseCodeToolRequest('{"tool_calls":[{"type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"README.md\\"}"}}]}')).toMatchObject({
      tool: "read_file",
      args: { path: "README.md" },
    });
  });

  it("normalizes common coding-agent tool name and argument aliases", () => {
    expect(parseCodeToolRequest('{"tool":"edit_file","args":{"diff":"*** Begin Patch\\n*** End Patch"}}')).toMatchObject({
      tool: "apply_patch",
      args: { text: "*** Begin Patch\n*** End Patch" },
    });
    expect(parseCodeToolRequest('{"name":"run_bash","arguments":{"cmd":"npm test"}}')).toMatchObject({
      tool: "bash",
      args: { command: "npm test" },
    });
    expect(parseCodeToolRequest('{"tool":"read","args":{"file":"README.md"}}')).toMatchObject({
      tool: "read_file",
      args: { path: "README.md" },
    });
    expect(parseCodeToolRequest('{"tool":"write","args":{"file":"notes.txt","content":"hello"}}')).toMatchObject({
      tool: "write_file",
      args: { path: "notes.txt", text: "hello" },
    });
    expect(parseCodeToolRequest('{"tool":"list_files","args":{"glob":"src/**/*.ts","dir":"cli"}}')).toMatchObject({
      tool: "glob",
      args: { pattern: "src/**/*.ts", path: "cli" },
    });
  });

  it("translates edit_file old/new strings into a guarded Codex patch", () => {
    const request = parseCodeToolRequest(JSON.stringify({
      tool: "edit_file",
      args: {
        path: "src/hello.ts",
        old_string: "export const hello = 'world';",
        new_string: "export const hello = 'lynn';",
      },
    }));

    expect(request).toMatchObject({
      tool: "apply_patch",
      args: {
        text: [
          "*** Begin Patch",
          "*** Update File: src/hello.ts",
          "@@",
          "-export const hello = 'world';",
          "+export const hello = 'lynn';",
          "*** End Patch",
          "",
        ].join("\n"),
      },
    });
  });

  it("executes translated edit_file old/new strings through apply_patch approval", async () => {
    const request = parseCodeToolRequest(JSON.stringify({
      tool: "edit_file",
      args: {
        path: "src/hello.ts",
        old_string: "export const hello = 'world';",
        new_string: "export const hello = 'agent';",
      },
    }));
    expect(request?.tool).toBe("apply_patch");
    await expect(runClientTool({ cwd: tmp, approval: "ask" }, { name: request!.tool, ...request!.args })).rejects.toThrow("approval yolo");

    const result = await runClientTool({ cwd: tmp, approval: "yolo" }, { name: request!.tool, ...request!.args });
    const text = await fs.readFile(path.join(tmp, "src", "hello.ts"), "utf8");

    expect(result.ok).toBe(true);
    expect(text).toContain("'agent'");
  });

  it("parses tool JSON embedded after prose when strings contain braces", () => {
    const request = parseCodeToolRequest([
      "I need to patch this.",
      '{"tool":"apply_patch","args":{"patch":"diff --git a/a.ts b/a.ts\\n@@\\n-export const x = \\"{\\";\\n+export const x = \\"}\\";\\n"}}',
    ].join("\n"));

    expect(request).toMatchObject({
      tool: "apply_patch",
      args: { text: expect.stringContaining('export const x = "}"') },
    });
  });

  it("caps tool result text before feeding it back to the model", () => {
    const formatted = formatToolResultForLoop({
      ok: true,
      tool: "bash",
      output: { stdout: "x".repeat(5000) },
    }, 200);

    expect(formatted.length).toBeLessThan(500);
    expect(formatted).toContain("truncated this tool result");
  });

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
    expect(frames.find((frame) => frame.kind === "permission_state")).toMatchObject({ stable: false, cacheable: false });
    expect(frames.find((frame) => frame.kind === "tool_guard")).toMatchObject({ stable: false, cacheable: false });
  });

  it("times out long-running bash commands", async () => {
    const result = await runClientTool({ cwd: tmp, approval: "yolo", timeoutMs: 50 }, { name: "bash", command: "node -e \"setTimeout(()=>{}, 1000)\"" });

    expect(result.ok).toBe(false);
    expect(result.output).toMatchObject({ timedOut: true });
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

  it("parses CLI timeout flags for bash tools", async () => {
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

  it("renders an interactive code-mode intro with MiMo route and permission mode", () => {
    const intro = renderCodeIntro({ approval: "ask", sandbox: "workspace-write" });

    expect(intro).toContain("Lynn Code");
    expect(intro).toContain("MiMo");
    expect(intro).toContain("directory:");
    expect(intro).toContain("/fast");
    expect(intro).toContain("/think");
    expect(intro).toContain("/mode yolo");
    expect(intro).not.toContain(">_");
  });

  it("renders a clear danger warning for YOLO mode", () => {
    const intro = renderCodeIntro({ approval: "yolo", sandbox: "danger-full-access" });

    expect(intro).toContain("DANGER:");
    expect(intro).toContain("YOLO mode can edit files");
  });

  it("localizes the YOLO danger warning", () => {
    setLang("zh");
    const intro = renderCodeIntro({ approval: "yolo", sandbox: "danger-full-access" });

    expect(intro).toContain("危险:");
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
    expect(header).toContain("CLI BYOK: openai-compatible / step-3.7-flash");
  });

  it("renders a code task header with route, cwd, mode, reasoning, and step budget", () => {
    const header = renderCodeTaskHeader({
      cwd: "/repo",
      approval: "ask",
      sandbox: "workspace-write",
      reasoning: { effort: "auto", display: "auto" },
      maxSteps: 8,
    });

    expect(header).toContain("MiMo via local Brain router");
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
      content: expect.stringContaining("Earlier transcript turns were compacted"),
    });
    expect(JSON.stringify(resumed)).not.toContain("old assistant");
    expect(JSON.stringify(resumed)).toContain("latest user detail");
    expect(JSON.stringify(resumed)).toContain("latest assistant detail");
  });
});
