import { describe, expect, it } from 'vitest';
import { getProviderSummaryStatus } from '../../store';
import type { ProviderSnapshot } from '../../../../../../shared/provider-state.js';

function snapshot(overrides: Partial<ProviderSnapshot> = {}): ProviderSnapshot {
  return {
    id: 'local-qwen35-9b-q4km-imatrix',
    displayName: '本地 Qwen3.5-9B',
    selectedModel: null,
    state: 'ready',
    auth: { required: false, status: 'not_required' },
    health: { status: 'healthy' },
    fallback: { active: false, chain: [] },
    cooldown: { active: false },
    safeReason: 'Provider is ready.',
    ...overrides,
  };
}

describe('provider summary status', () => {
  it('falls back to the old missing-key signal without a state snapshot', () => {
    expect(getProviderSummaryStatus({
      type: 'api-key',
      has_credentials: false,
      supports_oauth: false,
    })).toEqual({ tone: 'warning', label: '缺 Key' });
  });

  it('marks a ready local provider from state snapshot as ready', () => {
    expect(getProviderSummaryStatus({
      type: 'none',
      has_credentials: true,
      supports_oauth: false,
      stateSnapshot: snapshot(),
    })).toEqual({ tone: 'ready', label: '已就绪' });
  });

  it('surfaces cooldown and error states before credential fallback', () => {
    expect(getProviderSummaryStatus({
      type: 'api-key',
      has_credentials: true,
      supports_oauth: false,
      stateSnapshot: snapshot({
        state: 'cooldown',
        cooldown: { active: true, reason: 'rate-limit' },
      }),
    })).toEqual({ tone: 'warm', label: '冷却' });

    expect(getProviderSummaryStatus({
      type: 'api-key',
      has_credentials: true,
      supports_oauth: false,
      stateSnapshot: snapshot({
        state: 'error',
        health: { status: 'error', safeReason: 'Probe failed.' },
      }),
    })).toEqual({ tone: 'error', label: '错误' });
  });
});
