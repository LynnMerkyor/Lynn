import http from 'node:http';
import { once } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createLynnAgentSession } from '../core/agent-runtime/create-session.js';
import { SessionManager } from '../core/agent-runtime/session-manager.js';

beforeEach(() => {
  for (const name of ['LYNN_MODEL_CALL_TIMEOUT_MS', 'LYNN_MODEL_TOTAL_TIMEOUT_MS', 'LYNN_MODEL_FIRST_CHUNK_TIMEOUT_MS', 'LYNN_MODEL_IDLE_TIMEOUT_MS']) vi.stubEnv(name, '');
});
afterEach(() => vi.unstubAllEnvs());

async function exercise(handler: http.RequestListener, timeouts: { firstChunkMs: number; idleMs: number; totalMs: number }) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const { session } = await createLynnAgentSession({
    sessionManager: SessionManager.inMemory(),
    model: { id: 'test-local', provider: 'local', api: 'openai-completions', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1` },
    getModelCallTimeouts: () => timeouts,
  });
  const events: unknown[] = [];
  session.subscribe(event => events.push(event));
  try { await session.prompt('test'); return { events, messages: session.messages }; }
  finally { session.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

it('times out a connection that sends headers but no first chunk', async () => {
  const result = await exercise((request, response) => {
    request.resume(); response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.flushHeaders();
  }, { firstChunkMs: 80, idleMs: 50, totalMs: 0 });
  expect(JSON.stringify(result.events)).toContain('首段等待超时');
  expect(JSON.stringify(result.events)).toContain('LYNN_MODEL_FIRST_CHUNK_TIMEOUT_MS');
});

it('reports idle timeout even after a structurally complete partial answer', async () => {
  const partial = 'This is a complete sentence, but the stream has not finished。';
  const result = await exercise((request, response) => {
    request.resume(); response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: partial } }] })}\n\n`);
  }, { firstChunkMs: 1000, idleMs: 60, totalMs: 0 });
  expect(JSON.stringify(result.events)).toContain('流式空闲超时');
  expect(result.messages.at(-1)).toMatchObject({ role: 'assistant', content: partial });
});

it('resets idle on reasoning, heartbeat and fragmented tool chunks, then stops at DONE without waiting for EOF', async () => {
  const payloads = [
    'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n',
    ': heartbeat\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[',
    '{"index":0,"function":{"arguments":"{}"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"Complete answer。"}}]}\n\n',
    'data: [DONE]\n\n',
  ];
  const result = await exercise((request, response) => {
    request.resume(); response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(payloads.shift()!);
    const interval = setInterval(() => { const payload = payloads.shift(); if (payload) response.write(payload); }, 35);
    response.on('close', () => clearInterval(interval));
  }, { firstChunkMs: 150, idleMs: 120, totalMs: 0 });
  expect(result.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'Complete answer。' });
  expect(JSON.stringify(result.events)).not.toContain('timed out');
});

it('retains an explicitly configured total cap even while chunks arrive', async () => {
  const result = await exercise((request, response) => {
    request.resume(); response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const interval = setInterval(() => response.write(': keepalive\n\n'), 15);
    response.on('close', () => clearInterval(interval));
  }, { firstChunkMs: 1000, idleMs: 100, totalMs: 160 });
  expect(JSON.stringify(result.events)).toContain('总时限超时');
});
