import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLI_FUNCTIONAL_TIMEOUTS, createCliTurnDeadline, isCliTurnActivity } from '../scripts/cli-turn-deadline.mjs';

describe('CLI functional deadlines', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('allows sustained reasoning past 120 seconds but retains the 660 second cap', () => {
    const onTimeout = vi.fn();
    const deadline = createCliTurnDeadline({ onTimeout });
    for (let index = 0; index < 10; index++) {
      vi.advanceTimersByTime(60000);
      if (isCliTurnActivity({ type: 'reasoning.delta', text: 'thinking' })) deadline.activity();
    }
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60000);
    expect(onTimeout).toHaveBeenCalledExactlyOnceWith('total');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('distinguishes silent first output from stalled active output', () => {
    const first = vi.fn();
    createCliTurnDeadline({ onTimeout: first });
    vi.advanceTimersByTime(CLI_FUNCTIONAL_TIMEOUTS.firstChunkMs);
    expect(first).toHaveBeenCalledExactlyOnceWith('first_chunk');
    const idle = vi.fn();
    const deadline = createCliTurnDeadline({ onTimeout: idle });
    deadline.activity();
    vi.advanceTimersByTime(CLI_FUNCTIONAL_TIMEOUTS.idleMs);
    expect(idle).toHaveBeenCalledExactlyOnceWith('idle');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores usage and status heartbeats and empty chunks', () => {
    for (const event of [{ type: 'usage' }, { type: 'status' }, { type: 'assistant.delta', text: '' }, { type: 'tool.start' }]) expect(isCliTurnActivity(event)).toBe(false);
    for (const event of [{ type: 'assistant.delta', text: 'answer' }, { type: 'tool.start', name: 'bash' }, { type: 'tool.end', name: 'bash' }, { type: 'tool_progress', name: 'web_search', event: 'end' }]) expect(isCliTurnActivity(event)).toBe(true);
  });

  it('retains explicit shorter deadlines and cleans up on completion', () => {
    const onTimeout = vi.fn();
    createCliTurnDeadline({ totalMs: 30000, onTimeout });
    vi.advanceTimersByTime(30000);
    expect(onTimeout).toHaveBeenCalledExactlyOnceWith('total');
    const completed = createCliTurnDeadline({ onTimeout });
    completed.activity();
    completed.stop();
    vi.advanceTimersByTime(700000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
