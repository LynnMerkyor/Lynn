// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
const fixture = vi.hoisted(() => ({ fetch: vi.fn(), toast: vi.fn() }));
vi.mock('../hooks/use-hana-fetch', () => ({ hanaFetch: fixture.fetch }));
vi.mock('../stores', () => ({ useStore: Object.assign((select: any) => select({ addToast: fixture.toast, setPendingConfirm: vi.fn() }), { setState: vi.fn() }) }));
import { useAutomationData } from '../components/automation/useAutomationData';
import { useAutomationDraft } from '../components/automation/useAutomationDraft';

let root: Root, host: HTMLElement;
let data: ReturnType<typeof useAutomationData>, draft: ReturnType<typeof useAutomationDraft>;
const input = { editingJobId: null, name: 'test', prompt: 'test', project: '/tmp', model: '', schedulePreset: 'daily' as const, hour: '09', minute: '00', weeklyDay: 1, customDays: [] };
beforeEach(async () => {
  fixture.fetch.mockReset();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); root = createRoot(host);
  function Harness() {
    data = useAutomationData({ enabled: false, isZh: true, tt: (_key, zh) => zh });
    draft = useAutomationDraft({ isZh: true, projectOptions: [], availableModels: [] });
    return null;
  }
  await act(async () => root.render(createElement(Harness)));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it.each([
  ['cron', '0 9 1 * *'], ['cron', '*/5 * * * *'], ['cron', '0 9 * * 1-3'],
  ['every', 3600000], ['at', '2099-01-01T09:00:00Z'], ['cron', '0 9 * * *'],
] as const)('preserves %s schedule %s when editing other fields', async (type, schedule) => {
  await act(async () => draft.editJob({ id: 'existing', type, schedule, enabled: true }));
  await act(async () => draft.setName('renamed'));
  expect(draft.preserveSchedule).toBe(true);
  const posts: any[] = [];
  fixture.fetch.mockImplementation(async (_url, opts) => {
    if (opts?.body) posts.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({ job: { id: 'existing' }, jobs: [], models: [] }) };
  });
  await act(async () => { await data.saveJob({ ...input, editingJobId: 'existing', preserveSchedule: draft.preserveSchedule }); });
  expect(posts[0]).not.toHaveProperty('schedule');
  expect(posts[0].model).toBe('');
});

it('allows an explicit change to a representable schedule', async () => {
  await act(async () => draft.editJob({ id: 'existing', type: 'cron', schedule: '0 9 * * *', enabled: true }));
  await act(async () => draft.setHour('10'));
  expect(draft.preserveSchedule).toBe(false);
});

it('retains the saved identity on test failure and retries as update/run', async () => {
  const actions: string[] = [];
  fixture.fetch.mockImplementation(async (_url, opts) => {
    const payload = opts?.body ? JSON.parse(opts.body) : null;
    if (payload) actions.push(payload.action);
    return { ok: true, json: async () => payload?.action === 'run' ? { error: 'test failure' } : { job: { id: 'created' }, jobs: [], models: [] } };
  });
  let result: any;
  await act(async () => { result = await data.saveJob({ ...input, runNow: true, onSaved: draft.acceptSavedJob }); });
  expect(result.saved).toBe(true); expect(result.testError).toBe('test failure');
  expect(draft.editingJobId).toBe('created');
  await act(async () => { await data.saveJob({ ...input, editingJobId: draft.editingJobId, runNow: true }); });
  expect(actions).toEqual(['add', 'run', 'update', 'run']);
});

it('does not overwrite or reset a newer draft when an old save resolves', async () => {
  await act(async () => draft.startCustom());
  const isCurrentDraft = draft.captureSelection();
  let resolveSave!: (value: unknown) => void;
  fixture.fetch.mockImplementation(async (_url, opts) => {
    if (opts?.body && JSON.parse(opts.body).action === 'add') return await new Promise(resolve => { resolveSave = resolve; });
    return { ok: true, json: async () => ({ jobs: [], models: [] }) };
  });
  let pending!: Promise<void>;
  await act(async () => {
    pending = data.saveJob({ ...input, onSaved: job => { if (isCurrentDraft()) draft.acceptSavedJob(job); } }).then(result => {
      if (isCurrentDraft() && result.saved && !result.testError) draft.reset();
    });
  });
  await act(async () => draft.editJob({ id: 'new-selection', label: 'Keep this draft', prompt: 'Keep this content', schedule: '0 10 * * *', enabled: true }));
  await act(async () => {
    resolveSave({ ok: true, json: async () => ({ job: { id: 'old-created' } }) });
    await pending;
  });
  expect(draft.editingJobId).toBe('new-selection');
  expect(draft.name).toBe('Keep this draft');
  expect(draft.prompt).toBe('Keep this content');
});

it('invalidates pending save callbacks even when starting custom twice', async () => {
  await act(async () => draft.startCustom());
  const isCurrentDraft = draft.captureSelection();
  await act(async () => draft.startCustom());
  expect(isCurrentDraft()).toBe(false);
});
