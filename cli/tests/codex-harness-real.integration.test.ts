import http from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { runCodexHarnessLoop } from "../src/codex-harness-loop.js";
import type { CodeAgentEvent } from "../src/code-agent-loop.js";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

const realCodexIt = process.env.LYNN_RUN_CODEX_INTEGRATION === "1" ? it : it.skip;

describe("real Codex app-server integration", () => {
  realCodexIt("runs a turn against a Chat-Completions-only BYOK endpoint", async () => {
    let requestCount = 0;
    let providerToolNames: string[] = [];
    const provider = http.createServer((req, res) => {
      if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
        res.writeHead(404);
        res.end();
        return;
      }
      let rawBody = "";
      req.on("data", (chunk) => { rawBody += String(chunk); });
      req.on("end", () => {
        requestCount += 1;
        const body = JSON.parse(rawBody) as { tools?: Array<{ function?: { name?: string } }> };
        providerToolNames = (body.tools || []).map((tool) => tool.function?.name || "").filter(Boolean);
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "REAL_CODEX_HARNESS_OK" }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } })}\n\n`);
        res.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    servers.push(provider);
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("provider did not bind");
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(new Error("real Codex integration timed out")), 30_000);
    try {
      const result = await runCodexHarnessLoop({
        task: "Reply with exactly REAL_CODEX_HARNESS_OK and do not use tools.",
        context: { cwd: process.cwd(), gitStatus: "", gitDiffStat: "", topFiles: [], packageScripts: {} },
        brainUrl: "http://unused.invalid",
        fallbackProvider: {
          provider: "integration-chat",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          model: "integration-model",
          apiKey: "integration-secret",
        },
        reasoning: { effort: "low", display: "never" },
        json: true,
        maxSteps: 10,
        toolCtx: { cwd: process.cwd(), approval: "never", sandbox: "read-only" },
        input: new PassThrough() as unknown as NodeJS.ReadStream,
        output: new PassThrough() as unknown as NodeJS.WriteStream,
        signal: abort.signal,
      });
      expect(result.text).toContain("REAL_CODEX_HARNESS_OK");
      expect(result.terminal).toMatchObject({ code: "completed", ok: true });
      expect(requestCount).toBeGreaterThan(0);
      expect(providerToolNames).toContain("exec_command");
    } finally {
      clearTimeout(timeout);
    }
  });

  realCodexIt("executes a read-only tool and completes the second model round", async () => {
    let requestCount = 0;
    let sawToolOutput = false;
    const provider = http.createServer((req, res) => {
      if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
        res.writeHead(404);
        res.end();
        return;
      }
      let rawBody = "";
      req.on("data", (chunk) => { rawBody += String(chunk); });
      req.on("end", () => {
        requestCount += 1;
        const body = JSON.parse(rawBody) as {
          messages?: Array<{ role?: string; content?: unknown }>;
          tools?: Array<{ function?: { name?: string } }>;
        };
        sawToolOutput = (body.messages || []).some((message) => message.role === "tool");
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (!sawToolOutput) {
          const hasExec = (body.tools || []).some((tool) => tool.function?.name === "exec_command");
          if (!hasExec) {
            res.end(`data: ${JSON.stringify({ error: { message: "exec_command missing" } })}\n\n`);
            return;
          }
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-pwd", type: "function", function: { name: "exec_command", arguments: JSON.stringify({ cmd: "pwd", yield_time_ms: 1_000, max_output_tokens: 1_000 }) } }] }, finish_reason: null }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
          res.end("data: [DONE]\n\n");
          return;
        }
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "REAL_CODEX_TOOL_LOOP_OK" }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
        res.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    servers.push(provider);
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("provider did not bind");
    const events: CodeAgentEvent[] = [];
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(new Error("real Codex tool integration timed out")), 30_000);
    try {
      const result = await runCodexHarnessLoop({
        task: "Run pwd once, then reply with exactly REAL_CODEX_TOOL_LOOP_OK.",
        context: { cwd: process.cwd(), gitStatus: "", gitDiffStat: "", topFiles: [], packageScripts: {} },
        brainUrl: "http://unused.invalid",
        fallbackProvider: {
          provider: "integration-chat",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          model: "integration-model",
          apiKey: "integration-secret",
        },
        reasoning: { effort: "low", display: "never" },
        json: true,
        maxSteps: 10,
        toolCtx: { cwd: process.cwd(), approval: "never", sandbox: "read-only" },
        input: new PassThrough() as unknown as NodeJS.ReadStream,
        output: new PassThrough() as unknown as NodeJS.WriteStream,
        signal: abort.signal,
        onEvent: (event) => events.push(event),
      });
      expect(result.text).toContain("REAL_CODEX_TOOL_LOOP_OK");
      expect(result.terminal).toMatchObject({ code: "completed", ok: true });
      expect(requestCount).toBe(2);
      expect(sawToolOutput).toBe(true);
      expect(events.some((event) => event.type === "tool.requested" && event.tool === "bash")).toBe(true);
      expect(events.some((event) => event.type === "tool.result" && event.result.tool === "bash" && event.result.ok)).toBe(true);
    } finally {
      clearTimeout(timeout);
    }
  });
});
