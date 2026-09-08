import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { KimiDeviceLogin, refreshManagedKimiCredentials } from '../lib/mcp/kimi-device-auth.js';
import { bundledKimiDatasource } from '../lib/mcp/kimi-datasource.js';
import { McpManager } from '../lib/mcp-client.js';
const directories: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function temp() { const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lynn-kimi-device-')); directories.push(directory); return directory; }
it('handles pending/slow-down then saves an isolated token and refreshes without a CLI', async () => {
  vi.useFakeTimers(); const home = temp(); let polls = 0;
  const requests = vi.fn(async (url, init) => {
    expect(String(url)).toMatch(/^https:\/\/auth\.kimi\.com\/api\/oauth\//);
    const body = new URLSearchParams(init.body);
    expect(body.get('client_id')).toBe('17e5f671-d194-4dfb-9706-5516cb48c098');
    if (String(url).endsWith('device_authorization')) return Response.json({ device_code: 'device-secret', user_code: 'ABCD-1234', verification_uri_complete: 'https://auth.kimi.com/device?user_code=ABCD-1234', interval: 5, expires_in: 600 });
    if (body.get('grant_type') === 'refresh_token') return Response.json({ access_token: 'renewed-secret', expires_in: 3600 });
    polls++; if (polls === 1) return Response.json({ error: 'slow_down' }, { status: 400 });
    return Response.json({ access_token: 'access-secret', refresh_token: 'refresh-secret', expires_in: 1 });
  }); vi.stubGlobal('fetch', requests);
  const onAuthorized = vi.fn(async () => {});
  const login = new KimiDeviceLogin(onAuthorized); await login.start(home);
  expect(JSON.stringify(login.getState())).not.toContain('device-secret');
  await vi.advanceTimersByTimeAsync(5000); expect(login.getState().status).toBe('waiting');
  await vi.advanceTimersByTimeAsync(10000); expect(login.getState().status).toBe('complete');
  expect(onAuthorized).toHaveBeenCalledTimes(1);
  const file = path.join(home, 'credentials/kimi-code.json'); expect(JSON.parse(fs.readFileSync(file, 'utf8')).access_token).toBe('access-secret');
  await Promise.all([refreshManagedKimiCredentials(home), refreshManagedKimiCredentials(home)]);
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ access_token: 'renewed-secret', refresh_token: 'refresh-secret' });
  expect(requests.mock.calls.filter(([, init]) => String(init.body).includes('grant_type=refresh_token'))).toHaveLength(1);
  login.cancel();
});
it('initializes the real bundled official MCP and discovers its tools without accessing a Kimi account', async () => {
  const home = temp(); const candidate = await bundledKimiDatasource(path.join(home, 'isolated-kimi'));
  const manager = new McpManager(home);
  try {
    await manager.init(); const state = await manager.saveServer(candidate.name, candidate.config);
    expect(state?.connected).toBe(true); expect(state?.tools.map(tool => tool.name).sort()).toEqual(['call_data_source_tool', 'get_data_source_desc']);
    expect(fs.existsSync(path.join(home, 'isolated-kimi/credentials'))).toBe(false);
  } finally { await manager.dispose(); }
});
