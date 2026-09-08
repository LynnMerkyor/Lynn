// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useSessionBodySearch } from './use-session-body-search';
import { hanaFetch } from './use-hana-fetch';
vi.mock('./use-hana-fetch', () => ({ hanaFetch: vi.fn() }));
it('ignores an earlier response after the query changes and clears an empty query', async () => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div'); const root = createRoot(host);
  let resolveFirst!: (response: Response) => void;
  vi.mocked(hanaFetch).mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; })).mockResolvedValueOnce(Response.json({ hits: [{ path: '/b', snippet: 'new result' }] }));
  function Search({ query }: { query: string }) { const state = useSessionBodySearch(query, 1); return <output>{JSON.stringify(state)}</output>; }
  try {
    await act(async () => root.render(<Search query="old" />)); await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    await act(async () => root.render(<Search query="new" />)); await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(host.textContent).toContain('new result');
    await act(async () => resolveFirst(Response.json({ hits: [{ path: '/a', snippet: 'stale result' }] })));
    expect(host.textContent).not.toContain('stale result');
    await act(async () => root.render(<Search query="" />)); expect(JSON.parse(host.textContent!).snippets).toEqual({});
  } finally { await act(async () => root.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetAllMocks(); }
});
