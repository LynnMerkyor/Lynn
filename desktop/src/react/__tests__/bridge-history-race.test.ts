import { beforeEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ state: {} as Record<string, any>, fetch: vi.fn() }));
vi.mock('../stores/index', () => ({ useStore: { getState: () => fixture.state, setState: (patch: any) => Object.assign(fixture.state, patch) } }));
vi.mock('../hooks/use-hana-fetch', () => ({ hanaFetch: fixture.fetch }));
import { openBridgeSession } from '../stores/bridge-actions';
beforeEach(() => { fixture.state = {}; fixture.fetch.mockReset(); });

it.each(['success', 'failure'])('ignores delayed old %s after selecting B', async (outcome) => {
  let finishA!: (value: any) => void;
  fixture.fetch.mockImplementationOnce(() => new Promise(resolve => { finishA = resolve; }))
    .mockResolvedValueOnce({ json: async () => ({ messages: [{ content: 'B' }] }) });
  const old = openBridgeSession('A');
  await openBridgeSession('B');
  finishA({ json: async () => outcome === 'failure' ? { error: 'old error' } : { messages: [{ content: 'A' }] } });
  await old;
  expect(fixture.state.activeBridgeSessionKey).toBe('B');
  expect(fixture.state.activeBridgeMessages).toEqual([{ content: 'B' }]);
  expect(fixture.state.bridgeHistoryError).toBeNull();
});

it('does not reopen IM after switching to a local session', async () => {
  let finish!: (value: any) => void;
  fixture.fetch.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const pending = openBridgeSession('A');
  Object.assign(fixture.state, { activeBridgeSessionKey: null, welcomeVisible: true });
  finish({ json: async () => ({ messages: [{ content: 'A' }] }) });
  await pending;
  expect(fixture.state.welcomeVisible).toBe(true);
  expect(fixture.state.activeBridgeMessages).toEqual([]);
});
