import { afterEach, expect, it, vi } from 'vitest';
import { createRequestDeadline } from '../request-deadline.js';
afterEach(() => vi.useRealTimers());
it('preserves caller cancellation, including an already aborted caller', () => {
  const caller = new AbortController();
  const reason = new Error('cancelled by user');
  caller.abort(reason);
  const deadline = createRequestDeadline(1000, caller.signal);
  expect(deadline.signal.reason).toBe(reason);
  expect(deadline.timedOut).toBe(false);
  deadline.dispose();
});
it('clears only the header timeout while keeping stream cancellation', () => {
  vi.useFakeTimers();
  const caller = new AbortController();
  const deadline = createRequestDeadline(1000, caller.signal);
  deadline.dispose();
  vi.advanceTimersByTime(2000);
  expect(deadline.signal.aborted).toBe(false);
  caller.abort();
  expect(deadline.signal.aborted).toBe(true);
  expect(deadline.timedOut).toBe(false);
});
it('classifies a real timeout separately from a user stop', () => {
  vi.useFakeTimers();
  const deadline = createRequestDeadline(1000);
  vi.advanceTimersByTime(1000);
  expect(deadline.signal.aborted).toBe(true);
  expect(deadline.signal.reason.name).toBe('TimeoutError');
  expect(deadline.timedOut).toBe(true);
});
