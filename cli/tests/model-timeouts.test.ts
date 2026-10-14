import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { streamDirectProviderChat } from '../src/brain-client.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lynn-cli-timeout-'));
  vi.stubEnv('LYNN_HOME', home);
  for (const name of ['LYNN_MODEL_CALL_TIMEOUT_MS', 'LYNN_MODEL_TOTAL_TIMEOUT_MS', 'LYNN_MODEL_FIRST_CHUNK_TIMEOUT_MS', 'LYNN_MODEL_IDLE_TIMEOUT_MS']) vi.stubEnv(name, '');
  fs.mkdirSync(path.join(home, 'user'));
  fs.writeFileSync(path.join(home, 'user', 'preferences.json'), JSON.stringify({ model_call_timeouts: { firstChunkMs: 500, idleMs: 120, totalMs: 0 } }));
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(home, { recursive: true, force: true }); });

async function runServer(handler: http.RequestListener) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const events = [];
    for await (const event of streamDirectProviderChat({ brainUrl: '', prompt: 'test', reasoning: { effort: 'auto', display: 'auto' } }, {
      provider: 'local', model: 'slow-local', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, apiKey: '',
    })) events.push(event);
    return events;
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

it('uses persisted GUI idle settings in CLI direct-provider streams', async () => {
  await expect(runServer((request, response) => {
    request.resume(); response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write('data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n');
  })).rejects.toThrow('流式空闲超时');
});

it('applies first-chunk environment override before the saved preference', async () => {
  vi.stubEnv('LYNN_MODEL_FIRST_CHUNK_TIMEOUT_MS', '60');
  await expect(runServer((request, response) => {
    request.resume(); response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.flushHeaders();
  })).rejects.toThrow('first chunk');
});

it('keeps active CLI reasoning beyond the first-chunk limit and closes on DONE', async () => {
  let count = 0;
  const events = await runServer((request, response) => {
    request.resume(); response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const timer = setInterval(() => {
      count++;
      response.write('data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n');
      if (count === 20) { clearInterval(timer); response.write('data: {"choices":[{"delta":{"content":"done"}}]}\n\ndata: [DONE]\n\n'); }
    }, 30);
    response.on('close', () => clearInterval(timer));
  });
  expect(events.filter(event => event.type === 'reasoning.delta')).toHaveLength(20);
  expect(events).toContainEqual({ type: 'assistant.delta', text: 'done' });
});
