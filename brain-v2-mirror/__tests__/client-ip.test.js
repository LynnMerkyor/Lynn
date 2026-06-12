import { describe, expect, it } from 'vitest';
import { normalizeClientIp, resolveClientIp } from '../client-ip.js';

function req(headers = {}, remoteAddress = '127.0.0.1') {
  return { headers, socket: { remoteAddress } };
}

describe('client IP resolution', () => {
  it('prefers X-Real-IP over proxy socket address', () => {
    expect(resolveClientIp(req({ 'x-real-ip': '203.0.113.9' }, '127.0.0.1'))).toBe('203.0.113.9');
  });

  it('falls back to the first X-Forwarded-For hop', () => {
    expect(resolveClientIp(req({ 'x-forwarded-for': '198.51.100.7, 10.0.0.2' }, '127.0.0.1'))).toBe('198.51.100.7');
  });

  it('falls back to the socket address when proxy headers are absent', () => {
    expect(resolveClientIp(req({}, '::ffff:192.0.2.10'))).toBe('192.0.2.10');
  });

  it('ignores spoofable proxy headers unless the socket is trusted', () => {
    const direct = req({ 'x-real-ip': '203.0.113.9' }, '198.51.100.7');
    expect(resolveClientIp(direct)).toBe('198.51.100.7');
    expect(resolveClientIp(direct, { trustProxyHeaders: true })).toBe('203.0.113.9');
  });

  it('normalizes common address forms', () => {
    expect(normalizeClientIp('::ffff:192.0.2.1')).toBe('192.0.2.1');
    expect(normalizeClientIp('192.0.2.1:54321')).toBe('192.0.2.1');
    expect(normalizeClientIp('[2001:db8::1]:443')).toBe('2001:db8::1');
    expect(normalizeClientIp('unknown')).toBe('');
  });
});
