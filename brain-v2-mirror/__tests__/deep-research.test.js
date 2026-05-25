// Brain v2 · deep-research module unit tests
// Tests config logic. Does NOT call real LLMs (those are in scripts/deep-research-smoke.mjs).
import { describe, it, expect } from 'vitest';
import { _internals } from '../deep-research.js';

const {
  DEFAULT_CANDIDATES,
} = _internals;

describe('deep-research config', () => {
  it('has sane defaults', () => {
    expect(DEFAULT_CANDIDATES.length).toBeGreaterThanOrEqual(3);
    expect(DEFAULT_CANDIDATES.length).toBeLessThanOrEqual(6);
  });
  it('default candidates are registered providers', async () => {
    const { getProvider } = await import('../provider-registry.js');
    for (const id of DEFAULT_CANDIDATES) {
      expect(getProvider(id), `provider ${id} should be registered`).toBeTruthy();
    }
  });
});
