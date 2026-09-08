import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { searchSessionBodies } from '../lib/search/session-search.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
it('finds multilingual body text beyond the first message and ignores reasoning, images and tools', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lynn-search-')); roots.push(root);
  const file = path.join(root, 'session.jsonl');
  const entries = [
    { type: 'message', message: { role: 'user', content: 'first message' } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '隐私专词' }, { type: 'text', text: '这是很久以前讨论过的会议纪要。ＡＢＣ １２３' }, { type: 'image', data: '隐私专词' }] } },
    { type: 'message', message: { role: 'toolResult', content: '隐私专词' } },
  ];
  await fs.writeFile(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n{broken\n');
  const sessions = [{ path: file }];
  expect((await searchSessionBodies(sessions, '会议纪要', { baseDir: root })).hits[0].path).toBe(file);
  expect((await searchSessionBodies(sessions, 'abc 123', { baseDir: root })).hits).toHaveLength(1);
  expect((await searchSessionBodies(sessions, '隐私专词', { baseDir: root })).hits).toEqual([]);
  expect((await searchSessionBodies(sessions, '会议', { baseDir: root, maxFileBytes: 1 })).skipped).toBe(1);
});
it('rejects symlink escape, tolerates deleted sessions and supports cancellation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lynn-search-')); roots.push(root);
  const base = path.join(root, 'sessions'); await fs.mkdir(base);
  const outside = path.join(root, 'private.jsonl'); await fs.writeFile(outside, '{"role":"user","content":"secret"}');
  const link = path.join(base, 'link.jsonl'); await fs.symlink(outside, link);
  expect(await searchSessionBodies([{ path: link }, { path: path.join(base, 'gone') }], 'secret', { baseDir: base })).toMatchObject({ hits: [], skipped: 2 });
  await expect(searchSessionBodies([{ path: link }], 'secret', { baseDir: base, signal: AbortSignal.abort() })).rejects.toThrow();
});
