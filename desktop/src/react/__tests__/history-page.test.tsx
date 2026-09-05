// @vitest-environment jsdom
import { act, createElement, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { HistoryPage } from '../components/chat/HistoryPage';
it.each([100, 500, 2000])('initially mounts at most 80 rich messages for %i history items', async (count) => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const host = document.createElement('div'); const root = createRoot(host); const scroll = createRef<HTMLDivElement>();
  try {
    await act(async () => root.render(createElement('div', { ref: scroll }, Array.from({ length: count / 20 }, (_, i) =>
      createElement(HistoryPage, { key: i, root: scroll, count: 20, initialVisible: i >= count / 20 - 4,
        children: Array.from({ length: 20 }, (_, j) => createElement('article', { key: j }, 'message')) })) )));
    expect(host.querySelectorAll('article').length).toBeLessThanOrEqual(80);
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
});
