import type { Provider } from './types.js';

type TimeoutKind = 'firstChunk' | 'idle' | 'total';
const MAX_TIMEOUT_MS = 2_147_483_647;

function configuredTimeout(name: string, fallback: number, allowZero = false): number {
  const raw = process.env[name];
  const value = raw?.trim() ? Number(raw) : NaN;
  return Number.isInteger(value) && value >= (allowZero ? 0 : 1) && value <= MAX_TIMEOUT_MS ? value : fallback;
}

export function providerTimeoutPolicy(provider: Provider, multimodal = false, totalCapMs?: number) {
  const first = 600_000;
  const totalMs = configuredTimeout('BRAIN_V2_PROVIDER_TOTAL_TIMEOUT_MS', 0, true);
  return {
    firstChunkMs: configuredTimeout('BRAIN_V2_PROVIDER_FIRST_CHUNK_TIMEOUT_MS', multimodal
      ? Math.max(first, configuredTimeout('BRAIN_V2_MULTIMODAL_PROVIDER_TIMEOUT_MS', 60_000)) : first),
    idleMs: configuredTimeout('BRAIN_V2_PROVIDER_IDLE_TIMEOUT_MS', 600_000),
    totalMs: totalCapMs && Number.isFinite(totalCapMs) && totalCapMs > 0
      ? Math.min(totalMs || totalCapMs, totalCapMs) : totalMs,
  };
}

export function createProviderAttemptSignal(provider: Provider, upstream?: AbortSignal, multimodal = false, totalCapMs?: number) {
  const policy = providerTimeoutPolicy(provider, multimodal, totalCapMs);
  const controller = new AbortController();
  let phaseTimer: ReturnType<typeof setTimeout> | undefined;
  let totalTimer: ReturnType<typeof setTimeout> | undefined;
  let failure: Error | undefined;
  let cleaned = false;
  const clearTimers = () => { clearTimeout(phaseTimer); clearTimeout(totalTimer); };
  const abortUpstream = () => { clearTimers(); controller.abort(upstream?.reason); };
  const expire = (kind: TimeoutKind, duration: number) => {
    if (cleaned || controller.signal.aborted) return;
    const variable = { firstChunk: 'BRAIN_V2_PROVIDER_FIRST_CHUNK_TIMEOUT_MS', idle: 'BRAIN_V2_PROVIDER_IDLE_TIMEOUT_MS', total: 'BRAIN_V2_PROVIDER_TOTAL_TIMEOUT_MS' }[kind];
    failure = Object.assign(new Error(`Brain provider ${provider.id} ${kind} timeout after ${duration}ms; check ${variable}${kind === 'total' && totalCapMs ? ' and the explicit recovery deadline' : ''}`), { name: 'ProviderTimeoutError', kind, timeoutMs: duration });
    clearTimers();
    upstream?.removeEventListener('abort', abortUpstream);
    controller.abort(failure);
  };
  const armPhase = (kind: 'firstChunk' | 'idle') => {
    if (cleaned || controller.signal.aborted) return;
    clearTimeout(phaseTimer);
    const duration = kind === 'firstChunk' ? policy.firstChunkMs : policy.idleMs;
    phaseTimer = setTimeout(() => expire(kind, duration), duration);
  };
  if (upstream?.aborted) abortUpstream();
  else {
    upstream?.addEventListener('abort', abortUpstream, { once: true });
    armPhase('firstChunk');
    if (policy.totalMs > 0) totalTimer = setTimeout(() => expire('total', policy.totalMs), policy.totalMs);
  }
  return {
    signal: controller.signal,
    policy,
    start: () => armPhase('firstChunk'),
    activity: () => armPhase('idle'),
    timeoutError: () => failure,
    cleanup: () => { cleaned = true; clearTimers(); upstream?.removeEventListener('abort', abortUpstream); },
  };
}
