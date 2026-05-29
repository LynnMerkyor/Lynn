import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";
import { runCode } from "../src/commands/code.js";
import { globToRegExp } from "../src/tools/glob.js";
import { runClientTool } from "../src/tools/registry.js";

let tmp = "";

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
    await expect(runClientTool({ cwd: tmp, approval: "ask" }, { name: "bash", command: "pwd" })).rejects.toThrow("approval yolo");
  });

  it("times out long-running bash commands", async () => {
    const result = await runClientTool({ cwd: tmp, approval: "yolo", timeoutMs: 50 }, { name: "bash", command: "node -e \"setTimeout(()=>{}, 1000)\"" });

    expect(result.ok).toBe(false);
    expect(result.output).toMatchObject({ timedOut: true });
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

  it("runs a read-only code task with repository context", async () => {
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(runCode(parseArgs(["code", "review current diff", "--cwd", tmp, "--mock-brain"]))).resolves.toBe(0);
    } finally {
      process.stdout.write = original;
    }
    expect(output).toContain("Mock Lynn code task: review current diff");
    expect(output).toContain("CWD:");
  });
});
