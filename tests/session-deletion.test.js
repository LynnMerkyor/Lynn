import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSessionsRoute } from '../server/routes/sessions.js';
import { SessionManager } from '../core/agent-runtime/session-manager.js';
import { createLynnAgentSession } from '../core/agent-runtime/create-session.js';
import { closeCachedSession } from '../core/session-lifecycle.js';
import { collectAgentSessionEntries } from '../core/session-list-cache.js';

let directory;
let agentsDir;
let sessionDir;
let engine;
let route;
const post = (url, body) => route.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
function makeSession(name, archived = false) {
  const target = path.join(sessionDir, ...(archived ? ['archived'] : []), `${name}.jsonl`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify({ type: 'session', id: name, cwd: directory }) + '\n');
  return target;
}
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lynn-delete-'));
  agentsDir = path.join(directory, 'agents');
  sessionDir = path.join(agentsDir, 'agent-a', 'sessions');
  fs.mkdirSync(sessionDir, { recursive: true });
  engine = { agentsDir, closeSession: vi.fn(), listSessions: () => collectAgentSessionEntries({ agentsDir, agents: [{ id: 'agent-a', name: 'Agent' }] }) };
  route = createSessionsRoute(engine);
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }); });

it('deletes the file, metadata, index and copied attachments but preserves external originals and other sessions after restart', async () => {
  const target = makeSession('remove');
  const keep = makeSession('keep');
  const original = path.join(directory, 'original.txt');
  fs.writeFileSync(original, 'keep original');
  fs.writeFileSync(`${target}.files.json`, JSON.stringify({ files: [{ localPath: original, storageKind: 'external' }] }));
  fs.mkdirSync(`${target}.attachments`);
  fs.writeFileSync(path.join(`${target}.attachments`, 'copy.txt'), 'copy');
  for (const name of ['session-meta.json', 'session-titles.json']) fs.writeFileSync(path.join(sessionDir, name), JSON.stringify({ [target]: 'remove', 'remove.jsonl': 'remove', [keep]: 'keep' }));
  fs.writeFileSync(path.join(sessionDir, 'session-index.json'), JSON.stringify({ version: 1, sessions: [{ path: target }, { path: keep }] }));
  expect((await post('/sessions/delete', { path: target })).status).toBe(200);
  expect(engine.closeSession).toHaveBeenCalledWith(target);
  for (const file of [target, `${target}.files.json`, `${target}.attachments`]) expect(fs.existsSync(file)).toBe(false);
  expect(fs.readFileSync(original, 'utf8')).toBe('keep original');
  const freshEngine = { ...engine, listSessions: () => collectAgentSessionEntries({ agentsDir, agents: [{ id: 'agent-a', name: 'Agent' }] }) };
  const listed = await (await createSessionsRoute(freshEngine).request('/sessions')).json();
  expect(listed.map(entry => entry.path)).toEqual([keep]);
  expect(JSON.parse(fs.readFileSync(path.join(sessionDir, 'session-meta.json'), 'utf8'))).toEqual({ [keep]: 'keep' });
  expect((await post('/sessions/delete', { path: target })).status).toBe(404);
});

it('lists archives and clears only confirmed paths, leaving active and later archives intact', async () => {
  const active = makeSession('active');
  const first = makeSession('first', true);
  const second = makeSession('second', true);
  fs.writeFileSync(path.join(sessionDir, 'session-titles.json'), JSON.stringify({ [path.join(sessionDir, 'first.jsonl')]: 'Original title' }));
  const listed = await (await route.request('/sessions/archived')).json();
  expect(listed.sessions.find(entry => entry.path === first).title).toBe('Original title');
  const later = makeSession('later', true);
  expect((await post('/sessions/cleanup', { paths: [first, active] })).status).toBe(400);
  expect(fs.existsSync(first)).toBe(true);
  const response = await post('/sessions/cleanup', { paths: [first, second] });
  expect(await response.json()).toMatchObject({ ok: true, deleted: 2, failures: [] });
  expect(fs.existsSync(active)).toBe(true);
  expect(fs.existsSync(later)).toBe(true);
  const restarted = createSessionsRoute(engine);
  expect((await (await restarted.request('/sessions/archived')).json()).sessions.map(entry => entry.path)).toEqual([later]);
});

it('keeps age-based cleanup and reports partial failures', async () => {
  const old = makeSession('old', true);
  const recent = makeSession('recent', true);
  fs.utimesSync(old, new Date(0), new Date(0));
  expect(await (await post('/sessions/cleanup', { maxAgeDays: 90 })).json()).toMatchObject({ deleted: 1, ok: true });
  engine.closeSession.mockRejectedValueOnce(new Error('could not stop session'));
  expect(await (await post('/sessions/cleanup', { paths: [recent] })).json()).toMatchObject({ ok: false, deleted: 0, failures: [{ path: recent, error: 'could not stop session' }] });
  expect(fs.existsSync(recent)).toBe(true);
  expect((await post('/sessions/cleanup', { maxAgeDays: -1 })).status).toBe(400);
});

it('rejects traversal, non-session files and file/directory symlink escapes', async () => {
  const outside = path.join(directory, 'outside.jsonl');
  fs.writeFileSync(outside, 'preserve');
  const linked = path.join(sessionDir, 'linked.jsonl');
  fs.symlinkSync(outside, linked);
  fs.symlinkSync(directory, path.join(sessionDir, 'archived'));
  const invalid = [outside, path.join(agentsDir, '../outside.jsonl'), path.join(sessionDir, 'session-meta.json'), linked, path.join(sessionDir, 'archived', 'outside.jsonl')];
  for (const target of invalid) expect((await post('/sessions/delete', { path: target })).status).toBe(403);
  expect(engine.closeSession).not.toHaveBeenCalled();
  expect(fs.readFileSync(outside, 'utf8')).toBe('preserve');
});

it('prevents late streaming writes and queued prompts from recreating a deleted session', async () => {
  const manager = SessionManager.create(directory, sessionDir);
  manager.appendMessage({ role: 'user', content: 'original' });
  const target = manager.getSessionFile();
  const { session } = await createLynnAgentSession({ sessionManager: manager });
  session.isStreaming = true;
  await session.prompt('queued', { streamingBehavior: 'followUp' });
  const sessions = new Map([[target, { session, unsub: vi.fn(), agentId: 'agent-a' }]]);
  engine.closeSession = sessionPath => closeCachedSession({ sessions, sessionPath, currentSessionPath: target, setCurrentSession: vi.fn(), getAgentById: () => null, getFallbackAgent: () => null, notifySessionEnd: vi.fn() });
  expect((await post('/sessions/delete', { path: target })).status).toBe(200);
  manager.appendMessage({ role: 'assistant', content: 'late result' });
  manager._rewriteFile();
  await expect(session.prompt('late prompt')).rejects.toThrow('Session is closed');
  expect(fs.existsSync(target)).toBe(false);
  expect(sessions.size).toBe(0);
});

it('does not start a model request if deletion occurs while preparing the prompt', async () => {
  const manager = SessionManager.create(directory, sessionDir);
  let release;
  const preparation = new Promise(resolve => { release = resolve; });
  const { session } = await createLynnAgentSession({ sessionManager: manager, resourceLoader: { getSystemPrompt: () => preparation } });
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  const pending = session.prompt('prepare then send');
  const target = manager.getSessionFile();
  engine.closeSession = () => session.dispose();
  expect((await post('/sessions/delete', { path: target })).status).toBe(200);
  release('system');
  await pending;
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(fs.existsSync(target)).toBe(false);
});

it('unblocks the existing session after a failed close/delete operation', async () => {
  const target = makeSession('still-here');
  const restore = vi.fn();
  const beforeClose = vi.fn(() => restore);
  engine.closeSession.mockRejectedValue(new Error('close failed'));
  route = createSessionsRoute(engine, { beforeClose });
  expect((await post('/sessions/delete', { path: target })).status).toBe(500);
  expect(beforeClose).toHaveBeenCalledWith(target);
  expect(restore).toHaveBeenCalledTimes(1);
  expect(fs.existsSync(target)).toBe(true);
});
