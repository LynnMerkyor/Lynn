import crypto from 'node:crypto';
import { promises as fsp } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const brainRoot = fileURLToPath(new URL('..', import.meta.url));
const children = [];
const servers = [];
const tempDirs = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  await Promise.all(tempDirs.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHealth(url, child) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Brain exited before health check: ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Brain health check timed out');
}

function parseSse(raw) {
  return raw
    .split(/\n\n/u)
    .map((block) => block.split(/\r?\n/u).find((line) => line.startsWith('data: '))?.slice(6))
    .filter(Boolean)
    .map((data) => JSON.parse(data));
}

describe('Responses HTTP bridge', () => {
  it('lets Codex-style function calls pass through a Chat-Completions-only BYOK provider', async () => {
    let providerRequest = null;
    const provider = http.createServer((req, res) => {
      if (req.method === 'GET' && (req.url === '/models' || req.url === '/v1/models' || req.url === '/health')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      if (req.method === 'POST' && req.url?.endsWith('/chat/completions')) {
        let body = '';
        req.on('data', (chunk) => { body += String(chunk); });
        req.on('end', () => {
          providerRequest = JSON.parse(body);
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-read', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }] }, finish_reason: null }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
          res.end('data: [DONE]\n\n');
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
    servers.push(provider);
    const providerAddress = provider.address();
    const providerPort = typeof providerAddress === 'object' && providerAddress ? providerAddress.port : 0;
    const brainPort = await freePort();
    const devicesDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lynn-responses-devices-'));
    tempDirs.push(devicesDir);
    const agentKey = 'ak_0123456789abcdef0123456789abcdef';
    const agentSecret = 'aabbccdd11223344aabbccdd11223344';
    await fsp.writeFile(
      path.join(devicesDir, `${agentKey}.json`),
      JSON.stringify({ key: agentKey, secret: agentSecret, disabled: false }),
    );

    const child = spawn(process.execPath, ['--import', 'tsx', path.join(brainRoot, 'server.ts')], {
      cwd: brainRoot,
      env: {
        ...process.env,
        BRAIN_V2_PORT: String(brainPort),
        BRAIN_V2_HOST: '127.0.0.1',
        BRAIN_V2_ENABLE_P_FAKE: '1',
        BRAIN_V2_P_FAKE_BASE: `http://127.0.0.1:${providerPort}/v1`,
        BRAIN_V2_P_FAKE_KEY: 'none',
        BRAIN_V2_P_FAKE_MODEL: 'fake-chat-model',
        BRAIN_V2_DIRECT_KNOWN_OFFICIAL: '0',
        BRAIN_V2_LAST_CHANCE_RECOVERY: '0',
        LOBSTER_DEVICES_DIR: devicesDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    await waitForHealth(`http://127.0.0.1:${brainPort}/health`, child);

    const timestamp = Date.now();
    const nonce = crypto.randomBytes(12).toString('hex');
    const signaturePayload = ['v1', 'POST', '/v1/responses', String(timestamp), nonce, agentKey].join('\n');
    const signature = crypto.createHmac('sha256', agentSecret).update(signaturePayload).digest('hex');

    const response = await fetch(`http://127.0.0.1:${brainPort}/v1/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-agent-key': agentKey,
        'x-lynn-timestamp': String(timestamp),
        'x-lynn-nonce': nonce,
        'x-lynn-signature': `v1:${signature}`,
      },
      body: JSON.stringify({
        model: 'fake-chat-model',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'read the file' }] }],
        tools: [{ type: 'function', name: 'read_file', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
        stream: true,
      }),
    });
    const raw = await response.text();
    const events = parseSse(raw);

    expect(response.status).toBe(200);
    expect(response.headers.get('x-lynn-harness-mode')).toBe('model-only');
    expect(providerRequest.tools).toHaveLength(1);
    expect(providerRequest.tools[0].function.name).toBe('read_file');
    expect(events.some((event) => event.type === 'response.output_item.added' && event.item?.type === 'function_call' && event.item?.name === 'read_file')).toBe(true);
    expect(events.some((event) => event.type === 'response.function_call_arguments.done' && event.arguments === '{"path":"README.md"}')).toBe(true);
    expect(events.filter((event) => event.type === 'response.completed')).toHaveLength(1);
  });
});
