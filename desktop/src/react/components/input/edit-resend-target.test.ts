import { describe, expect, it } from 'vitest';
import { consumeEditResendTarget } from './edit-resend-target';

describe('edit resend target handling', () => {
  it('consumes the edit-resend target before prompt submission can fail', () => {
    const ref = { current: 'user-1718000000000' };

    const target = consumeEditResendTarget(ref, 'prompt');

    expect(target).toBe('user-1718000000000');
    expect(ref.current).toBeNull();
    expect(consumeEditResendTarget(ref, 'prompt')).toBeNull();
  });

  it('clears stale edit targets for non-prompt modes without returning them', () => {
    const ref = { current: 'user-1718000000000' };

    const target = consumeEditResendTarget(ref, 'steer');

    expect(target).toBeNull();
    expect(ref.current).toBeNull();
  });
});
