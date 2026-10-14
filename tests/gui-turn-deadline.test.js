import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGuiTurnDeadline, isGuiTurnActivity } from '../scripts/gui-turn-deadline.mjs';

describe('GUI functional turn deadlines', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reports a silent first chunk timeout and disposes all timers', () => {
    const onTimeout = vi.fn();
    createGuiTurnDeadline({ firstChunkMs: 600000, idleMs: 600000, onTimeout });
    vi.advanceTimersByTime(599999);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledExactlyOnceWith('first_chunk');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps sustained reasoning alive beyond the old total deadline and reports an actual idle stall', () => {
    const onTimeout = vi.fn();
    const deadline = createGuiTurnDeadline({ firstChunkMs: 600000, idleMs: 600000, onTimeout });
    for (let index = 0; index < 20; index += 1) {
      vi.advanceTimersByTime(60000);
      if (isGuiTurnActivity({ type: 'thinking_delta', delta: 'still reasoning' })) deadline.activity();
    }
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(600000);
    expect(onTimeout).toHaveBeenCalledExactlyOnceWith('idle');
  });

  it('retains an explicitly configured total deadline', () => {
    const onTimeout = vi.fn();
    const deadline = createGuiTurnDeadline({ firstChunkMs: 600000, idleMs: 600000, totalMs: 120000, onTimeout });
    vi.advanceTimersByTime(119999);
    deadline.activity();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledExactlyOnceWith('total');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not allow status heartbeats or empty chunks to keep a stalled request alive', () => {
    for (const event of [{ type: 'status', isStreaming: true }, { type: 'provider_meta' }, { type: 'text_delta', delta: '' }, { type: 'tool_progress', name: 'weather', event: 'heartbeat' }]) {
      expect(isGuiTurnActivity(event)).toBe(false);
    }
    for (const event of [{ type: 'text_delta', delta: 'text' }, { type: 'tool_start', name: 'weather' }, { type: 'tool_progress', name: 'weather', event: 'end' }]) {
      expect(isGuiTurnActivity(event)).toBe(true);
    }
  });

  it('stops all deadlines when a turn finishes or is cancelled', () => {
    const onTimeout = vi.fn();
    const deadline = createGuiTurnDeadline({ firstChunkMs: 600000, idleMs: 600000, totalMs: 120000, onTimeout });
    deadline.activity();
    deadline.stop();
    deadline.activity();
    vi.advanceTimersByTime(1000000);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects invalid or silently disabled first/idle limits', () => {
    for (const firstChunkMs of [0, -1, NaN, Infinity]) {
      expect(() => createGuiTurnDeadline({ firstChunkMs, idleMs: 600000, onTimeout: vi.fn() })).toThrow('Invalid GUI deadline');
    }
  });
});
