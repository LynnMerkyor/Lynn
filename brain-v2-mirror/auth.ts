// Brain v2 · HMAC sign verification (compatible with brain v1)
// 复用 brain v1 device store: /opt/lobster-brain/data/devices/<agentKey>.json
// 模式:relaxed — missing headers → log warn, 允许通过(兼容旧客户端 / OpenHanako)
import crypto from 'node:crypto';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import type { HmacSignaturePayload, LogFn } from './types.js';

const DEVICE_AUTH_WINDOW_MS = Number(process.env.DEVICE_AUTH_WINDOW_MS || 5 * 60 * 1000);
const DEVICE_NONCE_TTL_MS = Number(process.env.DEVICE_NONCE_TTL_MS || 10 * 60 * 1000);
const DEVICES_DIR = process.env.LOBSTER_DEVICES_DIR || '/opt/lobster-brain/data/devices';
const USER_DEVICES_DIR = path.join(os.homedir(), '.lynn', 'brain-devices');

// 2026-05-25 P2-3: nonce cache memory DoS 防护。
// Map 默认无大小限制,未授权攻击者可在 device-lookup 前 spray 100k nonces/sec 撑爆内存。
// 加 LRU cap:超过 NONCE_CACHE_MAX 时按 insertion order evict 最早的。
// 上限按 100 req/s × 600s TTL = 60k 计,默认 100k 留余量,可 env 调。
const NONCE_CACHE_MAX = Number(process.env.DEVICE_NONCE_CACHE_MAX || 100_000);
const _nonceCache = new Map<string, number>(); // `${agentKey}:${nonce}` → expiresAt

type Device = {
  key?: string;
  secret?: string;
  disabled?: boolean;
  lastSeenAt?: string;
  clientVersion?: string;
  clientPlatform?: string;
  updatedAt?: string;
};

type SignedRequestOptions = {
  pathname?: string;
  method?: string;
  log?: LogFn;
};

function deviceDirs(): string[] {
  return [...new Set([DEVICES_DIR, USER_DEVICES_DIR].filter(Boolean))];
}

async function loadDeviceRecord(key: string): Promise<{ device: Device; filePath: string } | null> {
  for (const dir of deviceDirs()) {
    const filePath = path.join(dir, `${key}.json`);
    try {
      const raw = await fsp.readFile(filePath, 'utf8');
      return { device: JSON.parse(raw) as Device, filePath };
    } catch (e) {
      if (e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT') continue;
      throw e;
    }
  }
  return null;
}

export async function loadDevice(key: string): Promise<Device | null> {
  return (await loadDeviceRecord(key))?.device || null;
}

export function buildClientSignaturePayload({ method = 'POST', pathname = '/chat/completions', timestamp, nonce, agentKey }: HmacSignaturePayload): string {
  const normalizedMethod = String(method || 'POST').toUpperCase();
  const normalizedPath = String(pathname || '/chat/completions').trim() || '/chat/completions';
  return [
    'v1',
    normalizedMethod,
    normalizedPath,
    String(timestamp),
    String(nonce || ''),
    String(agentKey || ''),
  ].join('\n');
}

export function timingSafeEqualHex(expectedHex: string, actualHex: string): boolean {
  if (!expectedHex || !actualHex || expectedHex.length !== actualHex.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expectedHex, 'hex'), Buffer.from(actualHex, 'hex'));
  } catch { return false; }
}

function cleanupNonces(now = Date.now()): void {
  for (const [k, expiresAt] of _nonceCache.entries()) {
    if (expiresAt <= now) _nonceCache.delete(k);
  }
}

// 2026-05-25 P2-3: LRU 限流。当 cache 达到 NONCE_CACHE_MAX 时,evict 最早入的条目
// (Map 的迭代顺序就是 insertion order)。结合 cleanupNonces 的 expiry-based 清理,
// 双层防御对抗 nonce-spray DoS。
function evictOldestIfFull(): void {
  while (_nonceCache.size >= NONCE_CACHE_MAX) {
    const oldestKey = _nonceCache.keys().next().value;
    if (oldestKey === undefined) break;
    _nonceCache.delete(oldestKey);
  }
}

export function rememberNonce(agentKey: string, nonce: string, now = Date.now()): boolean {
  cleanupNonces(now);
  const k = `${agentKey}:${nonce}`;
  if (_nonceCache.has(k)) return false;
  evictOldestIfFull();
  _nonceCache.set(k, now + DEVICE_NONCE_TTL_MS);
  return true;
}

export class AuthError extends Error {
  status: number;

  constructor(status: number, message: string) { super(message); this.status = status; }
}

/**
 * Verify request signature. Returns device or null.
 * Throws AuthError(401|403) for invalid/expired signatures from devices that DID sign.
 * Returns null (allowed) for missing-header relaxed mode.
 */
export async function verifySignedRequest(req: IncomingMessage, { pathname = '/v2/chat/completions', method = 'POST', log }: SignedRequestOptions = {}): Promise<Device | null> {
  const h = req.headers || {};
  const agentKey = String(h['x-agent-key'] || '').trim();
  const timestamp = String(h['x-lynn-timestamp'] || '').trim();
  const nonce = String(h['x-lynn-nonce'] || '').trim();
  const signatureHeader = String(h['x-lynn-signature'] || '').trim();

  // 2026-05-24 C2 hardening: production 拒绝缺 header / 重放; dev 仍 relaxed-allow 以兼容老客户端。
  // 默认值 strict — 设 LYNN_BRAIN_V2_AUTH_MODE=relaxed 才回到旧行为 (本地 dev / smoke / 老客户端调试)。
  const authMode = String(process.env.LYNN_BRAIN_V2_AUTH_MODE || 'strict').toLowerCase();
  const strict = authMode !== 'relaxed';

  if (!agentKey || !timestamp || !nonce || !signatureHeader) {
    const peer = h['x-agent-key'] || (req.socket?.remoteAddress) || '?';
    if (strict) {
      log && log('warn', 'auth missing headers from ' + peer + ' — strict reject');
      throw new AuthError(401, 'missing device signature headers');
    }
    log && log('warn', 'auth missing headers from ' + peer + ' — relaxed allow (LYNN_BRAIN_V2_AUTH_MODE=relaxed)');
    return null;
  }

  const parsedTs = Number(timestamp);
  if (!Number.isFinite(parsedTs)) throw new AuthError(401, 'invalid device timestamp');
  if (Math.abs(Date.now() - parsedTs) > DEVICE_AUTH_WINDOW_MS) throw new AuthError(401, 'device signature expired');

  // 2026-05-25 P2-3: 把 device existence check 移到 rememberNonce 之前。
  // 未授权 agentKey spray nonces 时,直接在 loadDevice 阶段 reject,不会污染 _nonceCache。
  // 已注册 agent 的 nonce 仍正常 dedupe。
  const deviceRecord = await loadDeviceRecord(agentKey);
  const device = deviceRecord?.device;
  if (!device?.secret) throw new AuthError(401, 'device not registered');

  if (!rememberNonce(agentKey, nonce)) {
    if (strict) {
      log && log('warn', 'auth nonce replayed for ' + agentKey + ' — strict reject');
      throw new AuthError(401, 'device nonce replayed');
    }
    log && log('warn', 'auth nonce replayed for ' + agentKey + ' — relaxed allow');
  }


  if (device.disabled) throw new AuthError(403, 'device disabled');

  const [version, actualSig = ''] = signatureHeader.split(':', 2);
  if (version !== 'v1' || !actualSig) throw new AuthError(401, 'invalid signature version');

  const expected = crypto
    .createHmac('sha256', device.secret)
    .update(buildClientSignaturePayload({ method, pathname, timestamp: parsedTs, nonce, agentKey }))
    .digest('hex');

  if (!timingSafeEqualHex(expected, actualSig)) throw new AuthError(401, 'invalid device signature');

  // Update lastSeenAt async (best effort)
  device.lastSeenAt = new Date().toISOString();
  device.clientVersion = String(h['x-lynn-client-version'] || device.clientVersion || '');
  device.clientPlatform = String(h['x-lynn-client-platform'] || device.clientPlatform || '');
  device.updatedAt = device.lastSeenAt;
  // Don't await: best-effort persistence shouldn't block the request
  if (deviceRecord?.filePath) {
    fsp.writeFile(deviceRecord.filePath, JSON.stringify(device, null, 2), "utf8").catch(() => {});
  }

  return device;
}

// for tests
export const __testing__ = { _nonceCache };
