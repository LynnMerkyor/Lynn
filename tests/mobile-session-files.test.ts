import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { MobileService } from '../server/mobile/service.js';
import { MobileDeviceStore } from '../server/mobile/device-store.js';
import { registerSessionFile, sessionIdForPath, resolveSessionFile, listSessionFiles } from '../lib/session-files.js';
import { createSessionFilesRoute } from '../server/routes/session-files.js';
import { Hono } from 'hono';
import { createUploadRoute } from '../server/routes/upload.js';

const roots: string[] = []; const services: MobileService[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.stop(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lynn-mobile-test-')); roots.push(home);
  const a = path.join(home, 'a.jsonl'); const b = path.join(home, 'b.jsonl'); fs.writeFileSync(a, ''); fs.writeFileSync(b, '');
  const input = path.join(home, 'report.csv'); fs.writeFileSync(input, 'name,value\nLynn,42\n'); return { home, a, b, input };
}
it('binds staged uploads only to an explicit enumerated session when sending', async () => {
  const { home, a, b, input } = fixture();
  const route = createUploadRoute({ cwd: home, listSessions: () => [{ path: a }, { path: b }] });
  const request = (url: string, body: unknown) => route.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const uploaded = await (await request('/upload', { paths: [input] })).json();
  expect(listSessionFiles(a)).toEqual([]); expect(listSessionFiles(b)).toEqual([]);
  const uploadIds = [uploaded.uploads[0].uploadId]; expect(uploadIds[0]).toBeTruthy();
  expect((await request('/upload/bind', { sessionPath: input, uploadIds })).status).toBe(404);
  expect((await request('/upload/bind', { sessionPath: b, uploadIds: [input] })).status).toBe(410);
  const bound = await (await request('/upload/bind', { sessionPath: b, uploadIds })).json();
  expect(listSessionFiles(a)).toEqual([]); expect(bound.files[0].sessionId).toBe(sessionIdForPath(b));
  fs.unlinkSync(uploaded.uploads[0].dest);
  const retried = await (await request('/upload/bind', { sessionPath: b, uploadIds })).json();
  expect(retried.files[0].fileId).toBe(bound.files[0].fileId);
  expect(fs.readFileSync(resolveSessionFile(b, bound.files[0].fileId).localPath, 'utf8')).toContain('Lynn,42');
});
it('retains uploaded bytes, scopes IDs to a session and refuses replaced symlinks', async () => {
  const { home, a, b, input } = fixture();
  const file = registerSessionFile(a, input, { copy: true });
  expect(registerSessionFile(a, input, { copy: true }).fileId).toBe(file.fileId);
  fs.unlinkSync(input);
  const resolved = resolveSessionFile(a, file.fileId); expect(fs.readFileSync(resolved.localPath, 'utf8')).toContain('Lynn,42');
  expect(() => resolveSessionFile(b, file.fileId)).toThrow('not found');
  expect(JSON.stringify(listSessionFiles(a))).not.toContain('localPath');
  fs.unlinkSync(resolved.localPath); fs.symlinkSync(b, resolved.localPath);
  expect(() => resolveSessionFile(a, file.fileId)).toThrow('changed');
  expect(fs.statSync(path.join(home, 'a.jsonl.files.json')).size).toBeGreaterThan(0);
});
it('downloads only registered files for an enumerated session with safe attachment headers', async () => {
  const { a, b, input } = fixture(); const file = registerSessionFile(a, input, { name: '结果.csv' });
  const route = createSessionFilesRoute({ listSessions: () => [{ path: a }, { path: b }] });
  const response = await route.request(file.downloadUrl.replace('/api', ''));
  expect(response.status).toBe(200); expect(response.headers.get('content-disposition')).toContain("filename*=UTF-8''"); expect(await response.text()).toContain('Lynn,42');
  expect((await route.request(`/session-files/${sessionIdForPath(b)}/${file.fileId}`)).status).toBe(404);
  expect((await route.request(`/session-files/${sessionIdForPath(a)}/../../etc/passwd`)).status).not.toBe(200);
});
it('uses single-use expiring pair codes and persists only hashed device credentials', () => {
  const { home } = fixture(); const destination = path.join(home, 'devices.json'); const store = new MobileDeviceStore(destination);
  const code = store.createPairing(); const paired = store.pair(code.code, 'My phone');
  expect(store.authenticate(paired.token)).toBe(paired.id); expect(fs.readFileSync(destination, 'utf8')).not.toContain(paired.token);
  expect(() => store.pair(code.code, 'again')).toThrow();
  const restored = new MobileDeviceStore(destination); expect(restored.authenticate(paired.token)).toBe(paired.id); restored.revoke(paired.id); expect(restored.authenticate(paired.token)).toBeNull();
  const expired = store.createPairing(); const now = vi.spyOn(Date, 'now').mockReturnValue(expired.expiresAt + 1);
  try { expect(() => store.pair(expired.code, 'expired')).toThrow(); } finally { now.mockRestore(); }
});
it('keeps corrupt mobile records untouched and isolates failure from desktop construction', async () => {
  const { home } = fixture(); fs.mkdirSync(path.join(home, 'user')); const file = path.join(home, 'user/mobile-devices.json'); fs.writeFileSync(file, '{broken');
  const service = new MobileService({ home, listSessions: () => [], request: () => new Response(), send: async () => {}, abort: async () => {}, isStreaming: () => false }); services.push(service);
  expect(service.status().enabled).toBe(false); expect(service.status().error).toContain('unreadable');
  await expect(service.update(true, '')).rejects.toThrow('unreadable'); expect(fs.readFileSync(file, 'utf8')).toBe('{broken');
});
it('pairs over HTTP, continues the exact session, rejects unrelated APIs and revokes immediately', async () => {
  vi.stubEnv('LYNN_MOBILE_BIND', '127.0.0.1');
  const { home, a, input } = fixture(); const file = registerSessionFile(a, input); const app = new Hono();
  app.route('/api', createSessionFilesRoute({ listSessions: () => [{ path: a }] }));
  app.get('/api/sessions/messages', c => c.json({ messages: [{ id: '0', role: 'user', content: 'history' }], hasMore: false }));
  const send = vi.fn(async () => {});
  const service = new MobileService({ home, listSessions: () => [{ path: a, title: 'Test session' }], request: (url, init) => app.request(url, init), send, abort: async () => {}, isStreaming: () => false }); services.push(service);
  await service.update(true, ''); const base = `http://127.0.0.1:${service.status().port}`;
  expect((await fetch(`${base}/api/sessions`)).status).toBe(401);
  const code = service.devices.createPairing(); const pair = await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ code: code.code, name: 'Phone' }) });
  expect(pair.status).toBe(200); const cookie = pair.headers.get('set-cookie')!.split(';')[0]; const headers = { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' };
  const list = await (await fetch(`${base}/api/sessions`, { headers })).json(); expect(list.sessions[0].id).toBe(sessionIdForPath(a)); expect(JSON.stringify(list)).not.toContain(a);
  expect((await fetch(`${base}/api/config`, { headers })).status).toBe(404);
  const wrongOrigin = await fetch(`${base}/api/sessions`, { headers: { ...headers, Origin: 'https://evil.example' } }); expect(wrongOrigin.status).toBe(403);
  const sent = await fetch(`${base}/api/sessions/${sessionIdForPath(a)}/messages`, { method: 'POST', headers, body: JSON.stringify({ text: 'Continue here', fileIds: [file.fileId] }) }); expect(sent.status).toBe(200); expect(send.mock.calls[0][0]).toBe(a); expect(send.mock.calls[0][1]).toContain('Continue here');
  expect(await (await fetch(`${base}${file.downloadUrl}`, { headers })).text()).toContain('Lynn,42');
  const page = await fetch(base); expect((await page.text()).includes('id="composer"')).toBe(true);
  const sw = await (await fetch(`${base}/sw.js`)).text(); expect(sw).toContain('!SHELL.includes(url.pathname)');
  service.devices.revoke(service.devices.list()[0].id); expect((await fetch(`${base}/api/sessions`, { headers })).status).toBe(401);
});
