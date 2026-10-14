import http from "node:http";
import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { createLynnAgentSession } from "../core/agent-runtime/create-session.js";
import { SessionManager } from "../core/agent-runtime/session-manager.js";
import { streamLocalQwen35Completion } from "../server/chat/local-qwen35-direct-runner.js";

afterEach(() => vi.unstubAllEnvs());

const durationMs = process.env.LYNN_TEST_LONG_STREAM === "1" ? 310_000 : 250;
const finalAnswer = "Slow stream completed.";

it.concurrent.each(['runtime', 'local-qwen'])("%s keeps a real HTTP reasoning stream alive past the first-chunk deadline", async mode => {
  for (const name of ["LYNN_MODEL_CALL_TIMEOUT_MS", "LYNN_MODEL_TOTAL_TIMEOUT_MS", "LYNN_MODEL_FIRST_CHUNK_TIMEOUT_MS", "LYNN_MODEL_IDLE_TIMEOUT_MS"]) vi.stubEnv(name, "");
  let chunks = 0;
  let requests = 0;
  const started = Date.now();
  const server = http.createServer((request, response) => {
    requests++;
    expect(request.url).toBe("/v1/chat/completions");
    request.resume();
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const reasoning = () => {
      chunks++;
      if (durationMs > 1000 && chunks % 60 === 0) console.log(JSON.stringify({ stage: "reasoning", elapsedMs: Date.now() - started, chunks, requests, pid: process.pid }));
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "thinking " } }] })}\n\n`);
    };
    reasoning();
    const interval = setInterval(reasoning, durationMs > 1000 ? 1000 : 20);
    const finish = setTimeout(() => {
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: finalAnswer }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    }, durationMs);
    response.on("close", () => { clearInterval(interval); clearTimeout(finish); });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const { session } = await createLynnAgentSession({
    sessionManager: SessionManager.inMemory(),
    model: { id: "slow-local", provider: "local", api: "openai-completions", baseUrl: `http://127.0.0.1:${port}/v1` },
    getModelCallTimeouts: () => durationMs > 1000 ? undefined : { firstChunkMs: 100, idleMs: 100, totalMs: 0 },
  });
  const events: unknown[] = [];
  session.subscribe(event => events.push(event));
  try {
    if (mode === 'runtime') {
      await session.prompt("Think slowly, then answer.");
      expect(session.messages.at(-1)).toMatchObject({ role: "assistant", content: finalAnswer });
    } else {
      const result = await streamLocalQwen35Completion({
        endpoint: `http://127.0.0.1:${port}/v1/chat/completions`, model: 'slow-local',
        timeouts: { firstChunkMs: durationMs > 1000 ? 300_000 : 100, idleMs: durationMs > 1000 ? 120_000 : 100, totalMs: 0 },
      });
      expect(result.assistantText).toBe(finalAnswer);
    }
    expect(requests).toBe(1);
    expect(chunks).toBeGreaterThan(3);
    expect(Date.now() - started).toBeGreaterThanOrEqual(durationMs);
    expect(JSON.stringify(events)).not.toContain("timed out");
    console.log(JSON.stringify({ durationMs: Date.now() - started, chunks, model: "slow-local", pid: process.pid }));
  } finally {
    session.dispose();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, durationMs + 15_000);
