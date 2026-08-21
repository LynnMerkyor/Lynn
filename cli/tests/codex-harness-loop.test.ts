import { PassThrough } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCodexHarnessLoop } from "../src/codex-harness-loop.js";
import type { CodeAgentEvent } from "../src/code-agent-loop.js";

const fixture = fileURLToPath(new URL("../../tests/fixtures/fake-codex-app-server.mjs", import.meta.url));

describe("Codex harness loop", () => {
  it("maps app-server turn completion onto the shared run lifecycle", async () => {
    const events: CodeAgentEvent[] = [];
    const output = new PassThrough() as unknown as NodeJS.WriteStream;
    const input = new PassThrough() as unknown as NodeJS.ReadStream;
    const result = await runCodexHarnessLoop({
      task: "say hello",
      context: { cwd: process.cwd(), gitStatus: "", gitDiffStat: "", topFiles: [], packageScripts: {} },
      brainUrl: "http://127.0.0.1:9",
      reasoning: { effort: "auto", display: "never" },
      json: true,
      maxSteps: 10,
      toolCtx: { cwd: process.cwd(), approval: "never", sandbox: "workspace-write" },
      input,
      output,
      onEvent: (event) => events.push(event),
    }, {
      clientOptions: {
        command: process.execPath,
        commandArgs: [fixture],
        cwd: path.dirname(fixture),
        requestTimeoutMs: 2_000,
      },
    });

    const started = events.filter((event): event is Extract<CodeAgentEvent, { type: "run.started" }> => event.type === "run.started");
    const finished = events.filter((event): event is Extract<CodeAgentEvent, { type: "run.finished" }> => event.type === "run.finished");
    expect(result.text).toBe("hello");
    expect(result.terminal).toMatchObject({ code: "completed", ok: true });
    expect(started).toHaveLength(1);
    expect(finished).toHaveLength(1);
    expect(finished[0]?.runId).toBe(started[0]?.runId);
    expect(events).toContainEqual({ type: "assistant.delta", text: "hello" });
  });

  it("answers v2, permissions, and legacy approval requests with their native schemas", async () => {
    const result = await runCodexHarnessLoop({
      task: "approval protocol",
      context: { cwd: process.cwd(), gitStatus: "", gitDiffStat: "", topFiles: [], packageScripts: {} },
      brainUrl: "http://127.0.0.1:9",
      reasoning: { effort: "auto", display: "never" },
      json: true,
      maxSteps: 10,
      toolCtx: { cwd: process.cwd(), approval: "yolo", sandbox: "danger-full-access" },
      input: new PassThrough() as unknown as NodeJS.ReadStream,
      output: new PassThrough() as unknown as NodeJS.WriteStream,
    }, {
      clientOptions: {
        command: process.execPath,
        commandArgs: [fixture, "approvals"],
        cwd: path.dirname(fixture),
        requestTimeoutMs: 2_000,
      },
    });

    expect(result.text).toBe("approved");
    expect(result.terminal).toMatchObject({ code: "completed", ok: true });
  });

  it("declines unsupported interactive requests with valid protocol responses", async () => {
    const result = await runCodexHarnessLoop({
      task: "interactive protocol",
      context: { cwd: process.cwd(), gitStatus: "", gitDiffStat: "", topFiles: [], packageScripts: {} },
      brainUrl: "http://127.0.0.1:9",
      reasoning: { effort: "auto", display: "never" },
      json: false,
      maxSteps: 10,
      toolCtx: { cwd: process.cwd(), approval: "never", sandbox: "workspace-write" },
      input: new PassThrough() as unknown as NodeJS.ReadStream,
      output: new PassThrough() as unknown as NodeJS.WriteStream,
    }, {
      clientOptions: {
        command: process.execPath,
        commandArgs: [fixture, "elicitation"],
        cwd: path.dirname(fixture),
        requestTimeoutMs: 2_000,
      },
    });

    expect(result.text).toBe("declined safely");
    expect(result.terminal).toMatchObject({ code: "completed", ok: true });
  });

  it("passes durable memory and repaired resume history into a new app-server thread", async () => {
    const result = await runCodexHarnessLoop({
      task: "continue now",
      context: { cwd: process.cwd(), gitStatus: "", gitDiffStat: "", topFiles: [], packageScripts: {} },
      brainUrl: "http://127.0.0.1:9",
      reasoning: { effort: "auto", display: "never" },
      json: false,
      maxSteps: 10,
      toolCtx: { cwd: process.cwd(), approval: "never", sandbox: "workspace-write" },
      input: new PassThrough() as unknown as NodeJS.ReadStream,
      output: new PassThrough() as unknown as NodeJS.WriteStream,
      memoryFrame: "remember alpha",
      resumeMessages: [{ role: "assistant", content: "earlier answer" }],
    }, {
      clientOptions: {
        command: process.execPath,
        commandArgs: [fixture, "resume"],
        cwd: path.dirname(fixture),
        requestTimeoutMs: 2_000,
      },
    });

    expect(result.text).toBe("resumed");
    expect(result.terminal).toMatchObject({ code: "completed", ok: true });
  });

  it("closes the shared lifecycle exactly once when app-server crashes mid-turn", async () => {
    const events: CodeAgentEvent[] = [];
    await expect(runCodexHarnessLoop({
      task: "crash safely",
      context: { cwd: process.cwd(), gitStatus: "", gitDiffStat: "", topFiles: [], packageScripts: {} },
      brainUrl: "http://127.0.0.1:9",
      reasoning: { effort: "auto", display: "never" },
      json: false,
      maxSteps: 10,
      toolCtx: { cwd: process.cwd(), approval: "never", sandbox: "workspace-write" },
      input: new PassThrough() as unknown as NodeJS.ReadStream,
      output: new PassThrough() as unknown as NodeJS.WriteStream,
      onEvent: (event) => events.push(event),
    }, {
      clientOptions: {
        command: process.execPath,
        commandArgs: [fixture, "crash"],
        cwd: path.dirname(fixture),
        requestTimeoutMs: 2_000,
      },
    })).rejects.toThrow(/exited/i);

    const finished = events.filter((event): event is Extract<CodeAgentEvent, { type: "run.finished" }> => event.type === "run.finished");
    expect(finished).toHaveLength(1);
    expect(finished[0]?.terminal).toMatchObject({ code: "provider_failed", ok: false });
  });
});
