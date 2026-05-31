import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Use isolated tmp devices dir
const TMP_DIR = path.join(os.tmpdir(), 'brain-v2-auth-test-' + Date.now());
process.env.LOBSTER_DEVICES_DIR = TMP_DIR;

const auth = await import('../auth.js');
const { verifySignedRequest, registerDevice, buildClientSignaturePayload, timingSafeEqualHex, rememberNonce, AuthError, __testing__ } = auth;

const TEST_KEY = 'ak_test123';
const TEST_SECRET = 'aabbccdd11223344';
const REGISTER_KEY = 'ak_0123456789abcdef0123456789abcdef';
const REGISTER_SECRET = 'aabbccdd11223344aabbccdd11223344';

async function setupDevice({ disabled = false } = {}) {
  await fsp.mkdir(TMP_DIR, { recursive: true });
  await fsp.writeFile(
    path.join(TMP_DIR, TEST_KEY + '.json'),
    JSON.stringify({ key: TEST_KEY, secret: TEST_SECRET, disabled }, null, 2),
  );
}

function makeReq({ ts = Date.now(), nonce = 'n-' + Math.random(), key = TEST_KEY, secret = TEST_SECRET, pathname = '/v2/chat/completions', method = 'POST', omit = [] } = {}) {
  const payload = buildClientSignaturePayload({ method, pathname, timestamp: ts, nonce, agentKey: key });
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const headers = {
    'x-agent-key': key,
    'x-lynn-timestamp': String(ts),
    'x-lynn-nonce': nonce,
    'x-lynn-signature': 'v1:' + sig,
  };
  for (const k of omit) delete headers[k];
  return { headers, socket: { remoteAddress: '127.0.0.1' } };
}

beforeEach(async () => {
  __testing__._nonceCache.clear();
  try { await fsp.rm(TMP_DIR, { recursive: true, force: true }); } catch {}
});

describe('buildClientSignaturePayload', () => {
  it('builds canonical payload joined by newlines', () => {
    const p = buildClientSignaturePayload({ method: 'post', pathname: '/x', timestamp: 1, nonce: 'n', agentKey: 'k' });
    expect(p).toBe('v1\nPOST\n/x\n1\nn\nk');
  });
  it('uppercases method and trims pathname', () => {
    const p = buildClientSignaturePayload({ method: 'post', pathname: ' /a ', timestamp: 1, nonce: 'n', agentKey: 'k' });
    expect(p).toContain('POST');
    expect(p).toContain('/a');
  });
});

describe('timingSafeEqualHex', () => {
  it('matches identical hex', () => expect(timingSafeEqualHex('aabb', 'aabb')).toBe(true));
  it('rejects different lengths', () => expect(timingSafeEqualHex('aabb', 'aabbcc')).toBe(false));
  it('rejects different values', () => expect(timingSafeEqualHex('aabb', 'aacc')).toBe(false));
  it('rejects empty', () => expect(timingSafeEqualHex('', '')).toBe(false));
  it('rejects different-length hex inputs', () => expect(timingSafeEqualHex('aa', 'aabb')).toBe(false));
});

describe('rememberNonce', () => {
  it('first call returns true (nonce unique)', () => expect(rememberNonce('a', 'n1')).toBe(true));
  it('replay returns false', () => {
    rememberNonce('a', 'n1');
    expect(rememberNonce('a', 'n1')).toBe(false);
  });
  it('different keys with same nonce both succeed', () => {
    expect(rememberNonce('a', 'shared')).toBe(true);
    expect(rememberNonce('b', 'shared')).toBe(true);
  });
  it('checks replay before LRU eviction at the cache boundary', async () => {
    const previousMax = process.env.DEVICE_NONCE_CACHE_MAX;
    process.env.DEVICE_NONCE_CACHE_MAX = '2';
    try {
      const isolated = await import('../auth.js?nonce-lru-boundary');
      isolated.__testing__._nonceCache.clear();
      expect(isolated.rememberNonce('a', 'n1')).toBe(true);
      expect(isolated.rememberNonce('a', 'n2')).toBe(true);
      expect(isolated.rememberNonce('a', 'n1')).toBe(false);
      expect(isolated.__testing__._nonceCache.has('a:n1')).toBe(true);
    } finally {
      if (previousMax === undefined) delete process.env.DEVICE_NONCE_CACHE_MAX;
      else process.env.DEVICE_NONCE_CACHE_MAX = previousMax;
    }
  });
});

describe('verifySignedRequest (happy path)', () => {
  it('registers a CLI device and accepts its signature', async () => {
    await registerDevice({
      key: REGISTER_KEY,
      secret: REGISTER_SECRET,
      clientVersion: '0.80.0',
      clientPlatform: 'darwin',
    });
    const req = makeReq({ key: REGISTER_KEY, secret: REGISTER_SECRET });
    const device = await verifySignedRequest(req);
    expect(device).toMatchObject({
      key: REGISTER_KEY,
      clientVersion: '0.80.0',
      clientPlatform: 'darwin',
    });
  });

  it('refuses to overwrite a registered key with a different secret', async () => {
    await registerDevice({ key: REGISTER_KEY, secret: REGISTER_SECRET });
    await expect(registerDevice({ key: REGISTER_KEY, secret: 'bbbbcccc11223344bbbbcccc11223344' })).rejects.toThrowError(/already registered/);
  });

  it('rejects malformed device registration input', async () => {
    await expect(registerDevice({ key: '../bad', secret: TEST_SECRET })).rejects.toThrowError(/invalid device key/);
    await expect(registerDevice({ key: REGISTER_KEY, secret: 'short' })).rejects.toThrowError(/invalid device secret/);
  });

  it('returns device on valid signature', async () => {
    await setupDevice();
    const req = makeReq();
    const device = await verifySignedRequest(req);
    expect(device.key).toBe(TEST_KEY);
  });

  it('relaxed mode: returns null when no headers (missing-headers allow)', async () => {
    const prev = process.env.LYNN_BRAIN_V2_AUTH_MODE;
    process.env.LYNN_BRAIN_V2_AUTH_MODE = 'relaxed';
    try {
      const req = { headers: {}, socket: { remoteAddress: '1.2.3.4' } };
      const device = await verifySignedRequest(req, { log: () => {} });
      expect(device).toBe(null);
    } finally {
      if (prev === undefined) delete process.env.LYNN_BRAIN_V2_AUTH_MODE;
      else process.env.LYNN_BRAIN_V2_AUTH_MODE = prev;
    }
  });

  it('strict mode (default): rejects missing headers with 401', async () => {
    // No env override — strict is default.
    const req = { headers: {}, socket: { remoteAddress: '1.2.3.4' } };
    await expect(verifySignedRequest(req, { log: () => {} })).rejects.toThrowError(/missing device signature/);
  });
});

describe('verifySignedRequest (failure modes)', () => {
  it('throws 401 on expired timestamp (>5min drift)', async () => {
    await setupDevice();
    const req = makeReq({ ts: Date.now() - 10 * 60 * 1000 });
    await expect(verifySignedRequest(req)).rejects.toThrowError(/expired/);
  });

  it('throws 401 on invalid (non-numeric) timestamp', async () => {
    await setupDevice();
    const req = makeReq();
    req.headers['x-lynn-timestamp'] = 'bogus';
    await expect(verifySignedRequest(req)).rejects.toThrowError(/invalid device timestamp/);
  });

  it('throws 401 when device not registered', async () => {
    // no device file exists
    const req = makeReq({ key: 'ak_unknown' });
    await expect(verifySignedRequest(req)).rejects.toThrowError(/not registered/);
  });

  it('throws 403 when device disabled', async () => {
    await setupDevice({ disabled: true });
    const req = makeReq();
    await expect(verifySignedRequest(req)).rejects.toThrowError(/disabled/);
  });

  it('throws 401 on signature version mismatch', async () => {
    await setupDevice();
    const req = makeReq();
    req.headers['x-lynn-signature'] = 'v2:badsig';
    await expect(verifySignedRequest(req)).rejects.toThrowError(/invalid signature version/);
  });

  it('throws 401 on signature mismatch', async () => {
    await setupDevice();
    const req = makeReq();
    req.headers['x-lynn-signature'] = 'v1:0000000000000000000000000000000000000000000000000000000000000000';
    await expect(verifySignedRequest(req)).rejects.toThrowError(/invalid device signature/);
  });

  it('relaxed mode: nonce replay allowed (logs only)', async () => {
    const prev = process.env.LYNN_BRAIN_V2_AUTH_MODE;
    process.env.LYNN_BRAIN_V2_AUTH_MODE = 'relaxed';
    try {
      await setupDevice();
      const req1 = makeReq({ nonce: 'replay-test-relaxed' });
      await verifySignedRequest(req1);
      await new Promise(r => setTimeout(r, 80));  // wait for fire-and-forget device writeFile
      const req2 = makeReq({ nonce: 'replay-test-relaxed' });
      const device = await verifySignedRequest(req2, { log: () => {} });
      expect(device.key).toBe(TEST_KEY);  // relaxed: still allowed
    } finally {
      if (prev === undefined) delete process.env.LYNN_BRAIN_V2_AUTH_MODE;
      else process.env.LYNN_BRAIN_V2_AUTH_MODE = prev;
    }
  });

  it('strict mode (default): rejects nonce replay with 401', async () => {
    await setupDevice();
    const req1 = makeReq({ nonce: 'replay-test-strict' });
    await verifySignedRequest(req1);
    await new Promise(r => setTimeout(r, 80));
    const req2 = makeReq({ nonce: 'replay-test-strict' });
    await expect(verifySignedRequest(req2, { log: () => {} })).rejects.toThrowError(/nonce replayed/);
  });
});

describe('AuthError', () => {
  it('carries status code', () => {
    const e = new AuthError(403, 'no');
    expect(e.status).toBe(403);
    expect(e.message).toBe('no');
  });
});
