import { describe, expect, it, vi } from 'vitest';
import { isLocalAddress, startLocalQwen35Setup } from '../local-qwen35-setup.mjs';

describe('local Qwen3.5-9B setup bridge', () => {
  it('requires explicit user authorization before install/download/start', () => {
    const result = startLocalQwen35Setup({ authorized: false });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('missing_user_authorization');
  });

  it('treats only loopback clients as local', () => {
    expect(isLocalAddress('127.0.0.1')).toBe(true);
    expect(isLocalAddress('::1')).toBe(true);
    expect(isLocalAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLocalAddress('192.168.1.10')).toBe(false);
  });
});
