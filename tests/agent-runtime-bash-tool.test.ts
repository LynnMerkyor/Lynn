import { describe, expect, it, vi } from "vitest";
import { createBashTool } from "../core/agent-runtime/tools.js";
import { spawnAndStream } from "../lib/sandbox/exec-helper.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSeatbeltExec } from "../lib/sandbox/seatbelt.js";

describe("runtime Bash executor contract", () => {
  it.each([undefined, 0, 600])("uses a bounded default and preserves explicit timeout %s", async timeout => {
    const execute = vi.fn(async (_command, _directory, settings) => {
      expect(settings.timeout).toBe(timeout === undefined ? 60 : timeout);
      return { exitCode: 0 };
    });
    const tool = createBashTool(process.cwd(), { operations: { exec: execute } });
    expect(await tool.execute("deadline", { command: "test-command", ...(timeout === undefined ? {} : { timeout }) })).toMatchObject({ isError: false });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("passes the three-argument sandbox contract and combines byte chunks", async () => {
    const controller = new AbortController();
    const execute = vi.fn(async (_command, directory, { onData, signal, timeout }) => {
      expect(directory).toBe(process.cwd());
      expect(signal).toBe(controller.signal);
      expect(timeout).toBe(3);
      const bytes = Buffer.from("中文 output\n");
      onData(bytes.subarray(0, 2));
      onData(bytes.subarray(2));
      return { exitCode: 0 };
    });
    const tool = createBashTool(process.cwd(), { operations: { exec: execute } });
    const result = await tool.execute("contract", { command: "test-command", timeout: 3 }, { signal: controller.signal });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0]).toBe("test-command");
    expect(result).toMatchObject({ isError: false, content: [{ text: "中文 output" }], details: { exitCode: 0 } });
  });

  it("marks nonzero exits as failures even when stdout exists", async () => {
    const tool = createBashTool(process.cwd(), { operations: { exec: async (_command, _directory, { onData }) => {
      onData(Buffer.from("partial stdout\nerror on stderr\n"));
      return { exitCode: 7 };
    } } });
    expect(await tool.execute("failure", { command: "failure" })).toMatchObject({ isError: true, content: [{ text: "partial stdout\nerror on stderr" }], details: { exitCode: 7 } });
  });

  it("does not execute an already cancelled request", async () => {
    const execute = vi.fn();
    const controller = new AbortController();
    controller.abort();
    await expect(createBashTool(process.cwd(), { operations: { exec: execute } }).execute("cancelled", { command: "unused" }, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(["", "  "])("rejects an empty command: %j", async command => {
    const execute = vi.fn();
    expect(await createBashTool(process.cwd(), { operations: { exec: execute } }).execute("empty", { command })).toMatchObject({ isError: true });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([-1, Infinity, NaN, 2147484])("rejects invalid explicit command timeouts: %s", async timeout => {
    const execute = vi.fn();
    expect(await createBashTool(process.cwd(), { operations: { exec: execute } }).execute("timeout", { command: "unused", timeout })).toMatchObject({ isError: true });
    expect(execute).not.toHaveBeenCalled();
  });

  it("runs a real process through the shared streaming executor", async () => {
    const tool = createBashTool(process.cwd(), { operations: { exec: (_command, directory, options) => spawnAndStream(process.execPath, ["-e", "process.stdout.write('stdout');process.stderr.write('stderr');process.exitCode=4"], { ...options, cwd: directory }) } });
    const result = await tool.execute("process", { command: "safe test", timeout: 3 });
    expect(result.isError).toBe(true);
    expect(result.details).toEqual({ exitCode: 4 });
    expect(result.content?.[0].text).toContain("stdout");
    expect(result.content?.[0].text).toContain("stderr");
  });

  it("propagates cancellation to a real subprocess", async () => {
    const controller = new AbortController();
    let signalReady;
    const ready = new Promise<void>(resolve => { signalReady = resolve; });
    const tool = createBashTool(process.cwd(), { operations: { exec: (_command, directory, options) => spawnAndStream(process.execPath, ["-e", "process.stdout.write('ready');setTimeout(()=>{},30000)"], { ...options, cwd: directory, onData: data => { options.onData(data); signalReady(); } }) } });
    const task = tool.execute("cancel", { command: "safe wait", timeout: 3 }, { signal: controller.signal });
    const rejected = expect(task).rejects.toThrow(/aborted/i);
    await ready;
    controller.abort();
    await rejected;
  });

  it("propagates the executor's real timeout", async () => {
    const tool = createBashTool(process.cwd(), { operations: { exec: (_command, directory, options) => spawnAndStream(process.execPath, ["-e", "setTimeout(()=>{},30000)"], { ...options, cwd: directory }) } });
    await expect(tool.execute("timeout", { command: "safe wait", timeout: 0.05 })).rejects.toThrow("timeout:0.05");
  });

  it("terminates a real subprocess at the default deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const tool = createBashTool(process.cwd(), { operations: { exec: (_command, directory, options) => spawnAndStream(process.execPath, ["-e", "setInterval(()=>{},1000)"], { ...options, cwd: directory }) } });
      const result = expect(tool.execute("default-timeout", { command: "safe wait" })).rejects.toThrow("timeout:60");
      await vi.advanceTimersByTimeAsync(60_000);
      await result;
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs the native shell without an injected executor", async () => {
    const result = await createBashTool().execute("native", { command: "echo native-output && exit 4", timeout: 3 });
    expect(result).toMatchObject({ isError: true, details: { exitCode: 4 } });
    expect(result.content?.[0].text).toContain("native-output");
  });

  it.runIf(process.platform === "darwin")("executes in Seatbelt while retaining read and write restrictions", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-bash-contract-"));
    const protectedPath = path.join(directory, "protected");
    const deniedPath = path.join(directory, "denied");
    try {
      await fs.writeFile(protectedPath, "unchanged");
      await fs.writeFile(deniedPath, "private-fixture");
      const execute = createSeatbeltExec({ mode: "standard", lynnHome: directory, agentDir: directory, workspace: directory, trustedRoots: [directory], writablePaths: [directory], protectedPaths: [protectedPath], denyReadPaths: [deniedPath] });
      const tool = createBashTool(directory, { operations: { exec: execute } });
      expect(await tool.execute("allowed", { command: "printf sandbox-output > allowed; cat allowed", timeout: 3 })).toMatchObject({ isError: false, content: [{ text: "sandbox-output" }] });
      expect(await tool.execute("protected", { command: "printf changed > protected", timeout: 3 })).toMatchObject({ isError: true });
      expect(await fs.readFile(protectedPath, "utf8")).toBe("unchanged");
      const denied = await tool.execute("denied", { command: "cat denied", timeout: 3 });
      expect(denied.isError).toBe(true);
      expect(denied.content?.[0].text).not.toContain("private-fixture");
      await expect(tool.execute("sandbox-timeout", { command: "sleep 30", timeout: 0.05 })).rejects.toThrow("timeout:0.05");
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
