import http from "node:http";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";
import { runManager } from "../src/commands/manager-run.js";

function captureStdout(fn: () => Promise<number>): Promise<{ code: number; lines: Array<Record<string, unknown>>; raw: string }> {
  const original = process.stdout.write;
  let raw = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    raw += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  return fn()
    .then((code) => ({
      code,
      raw,
      lines: raw.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>),
    }))
    .finally(() => {
      process.stdout.write = original;
    });
}

function sse(text: string): string {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");
}

describe("manager run dual-brain loop", () => {
  it("emits a mock delegate loop with a valid acceptance report", async () => {
    const { code, lines } = await captureStdout(() => runManager(parseArgs([
      "manager",
      "run",
      "-p",
      "summarize the release gate",
      "--jsonl",
      "--mock",
      "--expect",
      "mock",
      "--id",
      "task-mock",
    ])));

    expect(code).toBe(0);
    expect(lines.map((line) => line.type)).toEqual([
      "manager.started",
      "manager.delegated",
      "worker.started",
      "assistant.delta",
      "worker.finished",
      "manager.validation",
      "worker.progress",
      "manager.finished",
    ]);
    const reportEvent = lines.find((line) => line.type === "worker.progress" && line.message === "dual-brain acceptance report");
    expect(reportEvent).toMatchObject({
      data: {
        kind: "dual_brain_acceptance_report",
        report: {
          taskId: "task-mock",
          managerModel: "local-a3b-distill",
          workerModel: "step-3.7-flash",
          escapeModel: "deepseek-v4-flash",
          status: "passed",
          falseVerifyRisk: "none",
        },
      },
    });
  });

  it("runs the live StepFun worker lane and escalates failed validation to DS-V4 Flash", async () => {
    let brainBody = "";
    let escapeBody = "";
    let escapeAuth = "";
    const brain = http.createServer((request, response) => {
      if (request.url === "/v1/chat/completions" && request.method === "POST") {
        request.on("data", (chunk) => { brainBody += String(chunk); });
        request.on("end", () => {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(sse("worker answered without the required marker"));
        });
        return;
      }
      response.writeHead(404);
      response.end();
    });
    const escape = http.createServer((request, response) => {
      if (request.url === "/v1/chat/completions" && request.method === "POST") {
        escapeAuth = String(request.headers.authorization || "");
        request.on("data", (chunk) => { escapeBody += String(chunk); });
        request.on("end", () => {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(sse("escape route repaired the task with PASS evidence"));
        });
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) => brain.listen(0, "127.0.0.1", resolve));
    await new Promise<void>((resolve) => escape.listen(0, "127.0.0.1", resolve));
    const brainAddress = brain.address();
    const escapeAddress = escape.address();
    if (!brainAddress || typeof brainAddress === "string") throw new Error("brain server did not bind");
    if (!escapeAddress || typeof escapeAddress === "string") throw new Error("escape server did not bind");

    try {
      const { code, lines } = await captureStdout(() => runManager(parseArgs([
        "manager",
        "run",
        "-p",
        "fix the failing hard task",
        "--jsonl",
        "--brain-url",
        `http://127.0.0.1:${brainAddress.port}`,
        "--escape-base-url",
        `http://127.0.0.1:${escapeAddress.port}/v1`,
        "--escape-api-key",
        "sk-escape-test",
        "--escape-model",
        "deepseek-v4-flash",
        "--expect",
        "PASS",
        "--task-class",
        "concurrency",
        "--id",
        "task-escape",
      ])));

      expect(code).toBe(0);
      expect(JSON.parse(brainBody)).toMatchObject({ model: "lynn-brain-router", stream: true });
      expect(escapeAuth).toBe("Bearer sk-escape-test");
      expect(JSON.parse(escapeBody)).toMatchObject({ model: "deepseek-v4-flash", stream: true });
      expect(lines.filter((line) => line.type === "manager.delegated").map((line) => line.workerId)).toEqual([
        "step37-worker",
        "ds-v4-flash-escape",
      ]);
      expect(lines.find((line) => line.type === "manager.finished")).toMatchObject({
        ok: true,
        status: "escalated",
        escalationReason: expect.stringContaining("missing expected marker"),
      });
      expect(lines.find((line) => line.type === "worker.progress" && line.message === "dual-brain acceptance report")).toMatchObject({
        data: {
          report: {
            status: "escalated",
            falseVerifyRisk: "suspected",
            escalationReason: expect.stringContaining("missing expected marker"),
          },
        },
      });
    } finally {
      await new Promise<void>((resolve) => brain.close(() => resolve()));
      await new Promise<void>((resolve) => escape.close(() => resolve()));
    }
  });
});
