import { describe, expect, it } from 'vitest';
import { checkpointAgent, _internals } from '../agent-checkpoint.js';

describe('agent-checkpoint BYOK-equality shim', () => {
  it('never calls a reviewer model and always continues', async () => {
    const result = await checkpointAgent({
      userPrompt: 'anything',
      trajectory: [{ step: 1, action: 'x', observation: 'y' }],
    });

    expect(_internals.disabled).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.verdict).toBe('continue');
    expect(result.reason).toBe('disabled_by_byok_equality');
  });
});
