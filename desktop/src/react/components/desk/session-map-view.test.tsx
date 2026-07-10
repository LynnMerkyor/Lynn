// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../types';
import { SessionMapView } from './SessionMapView';

const mocks = vi.hoisted(() => ({
  state: {
    sessions: [] as Session[],
    currentSessionPath: null as string | null,
    requestInputFocus: vi.fn(),
    locale: 'zh-CN',
  },
  setState: vi.fn(),
  switchSession: vi.fn(),
  branchSession: vi.fn(),
  consumeInsights: vi.fn(),
}));

vi.mock('../../stores', () => {
  const useStore = Object.assign(
    (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
    {
      setState: mocks.setState,
      getState: () => mocks.state,
    },
  );
  return { useStore };
});

vi.mock('../../stores/session-actions', () => ({
  switchSession: mocks.switchSession,
  branchSession: mocks.branchSession,
  consumeInsights: mocks.consumeInsights,
}));

function session(path: string, title: string, options: Partial<Session> = {}): Session {
  return {
    path,
    title,
    firstMessage: '',
    modified: new Date().toISOString(),
    messageCount: 2,
    agentId: null,
    agentName: null,
    cwd: null,
    ...options,
  };
}

describe('SessionMapView hierarchy', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.setState.mockReset();
    mocks.switchSession.mockReset();
    mocks.branchSession.mockReset();
    mocks.consumeInsights.mockReset();
    mocks.state.requestInputFocus.mockReset();
    mocks.state.currentSessionPath = '/sessions/current.jsonl';
    mocks.state.sessions = [
      session('/sessions/current.jsonl', 'Ship v0.85.9', {
        topology: {
          parentSessionPath: null,
          rootSessionPath: null,
          branchLabel: null,
          taskStatus: 'active',
          summary: null,
          resumeHint: null,
          createdAt: null,
          updatedAt: null,
        },
      }),
      session('/sessions/history.jsonl', 'Fix the settings flow', {
        digest: {
          objective: 'Fix the settings flow',
          status: 'Ready to verify',
          summary: 'The implementation is complete and needs a final verification pass.',
          decisions: [],
          openQuestions: [],
          nextSteps: ['Run the GUI regression'],
          evidenceRefs: [],
          updatedAt: null,
        },
      }),
    ];
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders the current session once and keeps historical detail collapsed', async () => {
    await act(async () => {
      root.render(<SessionMapView />);
    });

    expect(container.textContent?.match(/Ship v0\.85\.9/g)).toHaveLength(1);
    expect(container.textContent).toContain('当前会话');
    expect(container.textContent).not.toContain('The implementation is complete');
    expect(container.textContent).not.toContain('打开会话');
  });

  it('expands a non-current session in place with a keyboard-focusable control', async () => {
    await act(async () => {
      root.render(<SessionMapView />);
    });

    const toggle = container.querySelector<HTMLButtonElement>('[aria-label="查看 Fix the settings flow"]');
    expect(toggle?.tagName).toBe('BUTTON');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');

    await act(async () => {
      toggle?.click();
    });

    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('The implementation is complete and needs a final verification pass.');
    expect(container.textContent).toContain('打开会话');
    expect(container.textContent?.match(/Fix the settings flow/g)).toHaveLength(1);
  });

  it('opens an expanded session only through the explicit action', async () => {
    await act(async () => {
      root.render(<SessionMapView />);
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="查看 Fix the settings flow"]')?.click();
    });
    const open = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === '打开会话');
    await act(async () => {
      open?.click();
    });
    expect(mocks.switchSession).toHaveBeenCalledWith('/sessions/history.jsonl');
  });
});
