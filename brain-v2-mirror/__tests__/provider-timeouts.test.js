import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderAttemptSignal, providerTimeoutPolicy } from '../provider-timeouts.js';
import { parseOpenAISSE } from '../wire-adapter/_sse-parser.js';

const provider = { id: 'test', timeout_ms: 35_000 };
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('provider stream deadlines', () => {
  it('uses ten-minute phase deadlines instead of the legacy total timeout', () => {
    expect(providerTimeoutPolicy(provider)).toEqual({ firstChunkMs: 600_000, idleMs: 600_000, totalMs: 0 });
    expect(providerTimeoutPolicy(provider, true).firstChunkMs).toBe(600_000);
  });

  it('validates overrides and preserves an explicit recovery cap', () => {
    vi.stubEnv('BRAIN_V2_PROVIDER_FIRST_CHUNK_TIMEOUT_MS', '300000');
    vi.stubEnv('BRAIN_V2_PROVIDER_IDLE_TIMEOUT_MS', 'invalid');
    vi.stubEnv('BRAIN_V2_PROVIDER_TOTAL_TIMEOUT_MS', '2147483648');
    expect(providerTimeoutPolicy(provider, false, 9000)).toEqual({ firstChunkMs: 300_000, idleMs: 600_000, totalMs: 9000 });
  });

  it('reports first-chunk timeout precisely', () => {
    const attempt = createProviderAttemptSignal(provider);
    vi.advanceTimersByTime(599_999);
    expect(attempt.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(attempt.timeoutError()).toMatchObject({ kind: 'firstChunk', timeoutMs: 600_000 });
    expect(attempt.signal.reason.message).toContain('BRAIN_V2_PROVIDER_FIRST_CHUNK_TIMEOUT_MS');
    attempt.cleanup();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resets idle on activity for streams longer than ten minutes', () => {
    const attempt = createProviderAttemptSignal(provider);
    attempt.activity();
    for (let tick = 0; tick < 8; tick += 1) {
      vi.advanceTimersByTime(599_999);
      attempt.activity();
      expect(attempt.signal.aborted).toBe(false);
    }
    vi.advanceTimersByTime(600_000);
    expect(attempt.timeoutError()).toMatchObject({ kind: 'idle', timeoutMs: 600_000 });
    attempt.cleanup();
  });

  it('does not reset an explicit total deadline', () => {
    const attempt = createProviderAttemptSignal(provider, undefined, false, 100);
    attempt.activity();
    vi.advanceTimersByTime(90);
    attempt.activity();
    vi.advanceTimersByTime(10);
    expect(attempt.timeoutError()).toMatchObject({ kind: 'total', timeoutMs: 100 });
    attempt.cleanup();
  });

  it('preserves cancellation without reporting a timeout or leaking timers', () => {
    const parent = new AbortController();
    const attempt = createProviderAttemptSignal(provider, parent.signal);
    const reason = new Error('user stopped');
    parent.abort(reason);
    expect(attempt.signal.reason).toBe(reason);
    expect(attempt.timeoutError()).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    attempt.cleanup();
    attempt.activity();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('observes raw heartbeat and fragmented bytes and terminates on DONE', async () => {
    const activity = vi.fn();
    let closed = false;
    const body = { async *[Symbol.asyncIterator]() {
      try {
        for (const value of [': ping\n', 'data: {"choices":', '[{"delta":{"content":"Yes."}}]}\n', 'data: [DONE]\n']) yield new TextEncoder().encode(value);
        throw new Error('Must not read beyond DONE');
      } finally { closed = true; }
    } };
    const chunks = [];
    for await (const chunk of parseOpenAISSE(body, activity)) chunks.push(chunk);
    expect(activity).toHaveBeenCalledTimes(4);
    expect(chunks).toEqual([{ type: 'content', delta: 'Yes.' }]);
    expect(closed).toBe(true);
  });
});
