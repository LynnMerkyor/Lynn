import { describe, expect, it } from 'vitest';
import { consumeEditResendTarget, type EditResendTargetRef } from './edit-resend-target';

describe('edit resend target handling', () => {
  it('consumes the edit-resend target before prompt submission can fail', () => {
    const ref: EditResendTargetRef = { current: { messageId: 'user-1718000000000', sessionKey: 'session-a' } };

    const target = consumeEditResendTarget(ref, 'prompt', 'session-a');

    expect(target).toBe('user-1718000000000');
    expect(ref.current).toBeNull();
    expect(consumeEditResendTarget(ref, 'prompt', 'session-a')).toBeNull();
  });

  it('clears stale edit targets for non-prompt modes without returning them', () => {
    const ref: EditResendTargetRef = { current: { messageId: 'user-1718000000000', sessionKey: 'session-a' } };

    const target = consumeEditResendTarget(ref, 'steer', 'session-a');

    expect(target).toBeNull();
    expect(ref.current).toBeNull();
  });

  it.each(['session-b', '__new__'])('does not edit an old message after moving to %s', (sessionKey) => {
    const ref: EditResendTargetRef = { current: { messageId: 'old-message', sessionKey: 'session-a' } };
    expect(consumeEditResendTarget(ref, 'prompt', sessionKey)).toBeNull();
    expect(ref.current).toBeNull();
    expect(consumeEditResendTarget(ref, 'prompt', 'session-a')).toBeNull();
  });
});
