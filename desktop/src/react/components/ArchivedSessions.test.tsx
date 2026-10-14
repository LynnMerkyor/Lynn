// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ArchivedSessions } from './ArchivedSessions';
import { hanaFetch } from '../hooks/use-hana-fetch';
import { deleteSession } from '../stores/session-actions';

const state = vi.hoisted(() => ({ sessions: [], setPendingConfirm: vi.fn() }));
vi.mock('../stores', () => ({ useStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), { getState: () => state }) }));
vi.mock('../hooks/use-hana-fetch', () => ({ hanaFetch: vi.fn() }));
vi.mock('../hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('../stores/session-actions', () => ({ deleteSession: vi.fn() }));

let host: HTMLDivElement;
let root: Root;
let archives: Array<{ path: string; title: string; agentId: string; modified: string }>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  archives = ['first', 'second'].map(name => ({ path: `/agents/a/sessions/archived/${name}.jsonl`, title: name, agentId: 'a', modified: '2026-10-14T00:00:00Z' }));
  vi.mocked(hanaFetch).mockImplementation(async (_url, options) => {
    if (options?.method === 'POST') {
      const paths = JSON.parse(String(options.body)).paths;
      archives = archives.filter(item => !paths.includes(item.path));
      return Response.json({ ok: true, deleted: paths.length });
    }
    return Response.json({ sessions: archives });
  });
  vi.mocked(deleteSession).mockImplementation(async target => { archives = archives.filter(item => item.path !== target); return true; });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

async function openArchives() {
  await act(async () => root.render(<ArchivedSessions />));
  expect(hanaFetch).not.toHaveBeenCalled();
  await act(async () => host.querySelector<HTMLButtonElement>('button')!.click());
}

it('requires confirmation before single deletion and refreshes the archive list', async () => {
  await openArchives();
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="session.delete first"]')!.click());
  expect(deleteSession).not.toHaveBeenCalled();
  const confirmation = state.setPendingConfirm.mock.calls[0][0];
  expect(confirmation).toMatchObject({ tone: 'danger', title: 'session.delete' });
  expect(host.textContent).toContain('first');
  await act(async () => { confirmation.onConfirm(); });
  expect(deleteSession).toHaveBeenCalledWith('/agents/a/sessions/archived/first.jsonl');
  expect(host.textContent).not.toContain('first');
  expect(host.textContent).toContain('second');
});

it('clears only the confirmed snapshot, not archives added later', async () => {
  await openArchives();
  const clearButton = Array.from(host.querySelectorAll('button')).find(button => button.textContent === 'session.clearArchived')!;
  await act(async () => clearButton.click());
  expect(vi.mocked(hanaFetch).mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0);
  archives = [...archives, { path: '/agents/a/sessions/archived/later.jsonl', title: 'later', agentId: 'a', modified: '2026-10-14T00:00:00Z' }];
  await act(async () => { state.setPendingConfirm.mock.calls[0][0].onConfirm(); });
  const request = vi.mocked(hanaFetch).mock.calls.find(([, options]) => options?.method === 'POST')!;
  expect(JSON.parse(String(request[1]?.body)).paths).toHaveLength(2);
  expect(host.textContent).toContain('later');
  expect(host.textContent).not.toContain('first');
});

it('shows failed loading instead of an empty success state', async () => {
  vi.mocked(hanaFetch).mockResolvedValue(Response.json({ error: 'Permission denied' }, { status: 500 }));
  await openArchives();
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('Permission denied');
  expect(host.textContent).not.toContain('session.archiveEmpty');
  expect(Array.from(host.querySelectorAll('button')).find(button => button.textContent === 'session.clearArchived')?.disabled).toBe(true);
});
