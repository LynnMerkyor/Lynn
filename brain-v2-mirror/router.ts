// Brain v2 · Router — BYOK-equality thin pipe
// 原则: 只做事实层 (provider universalOrder + cooldown + capability gate + wire adapter)
//       + 服务端工具回灌循环。不注入 system prompt,不限工具调用次数(env 可配),不检测/拒绝伪工具,
//       不强制 synthesis,不解析模型内容做策略判断。BYOK 直连什么样,brain 就什么样。
//
// 2026-05-23 重构: 砍掉 ~500 行 synthesis + pseudo-tool detection + buffered content 干涉。

import { providerOrderForCapability, getProvider, isInCooldown, markUnhealthy } from './provider-registry.js';
import { getAdapter } from './wire-adapter/index.js';
import { isServerTool, executeServerTool, mergeWithServerTools } from './tool-exec/index.js';
import { applySearchContext, createSearchRequestCache, type SearchRequestCache } from './search-context.js';
import { applyAudioTranscribe, createAudioRequestCache, type AudioRequestCache } from './audio-transcribe.js';
import { compactToolResults, readToolResultCompactionConfigFromEnv } from './context-compact.js';
import {
  buildToolStormReflection,
  createToolStormState,
  observeToolCallStorm,
  readToolStormConfigFromEnv,
} from './tool-storm.js';
import { errorMessage, type ChatMessage, type FallbackEntry, type Provider, type ProviderCapability, type ProviderId, type RouterRunOptions, type RouterRunResult, type ToolCall } from './types.js';
const DUAL_BRAIN_LOCAL_MANAGER_MAX_CONCURRENCY = 1;

type CapabilityRequired = Partial<Pick<ProviderCapability, 'vision' | 'audio' | 'video'>>;
type ProviderError = Error & { suppressBody?: boolean; cooldownMs?: number };
type RunRoundResult = {
  ok: true;
  providerId: ProviderId;
  finishReason: string | null;
  toolCalls: ToolCall[];
  contentAccum: string;
  reasoningAccum: string;
  /** 本轮是否流出过 reasoning(reasoning-only 空答重试的判据)。 */
  sawReasoning: boolean;
};

function isProviderConfigured(provider: Provider | null): boolean {
  if (!provider) return false;
  if (provider.apiKey && provider.apiKey !== '') return true;
  if (provider.apiKey === 'none') return true;
  if (provider.authType === 'none') return true;
  return false;
}

function shouldEchoReasoningContent(providerId: ProviderId | null | undefined): boolean {
  return /deepseek/i.test(String(providerId || ''));
}

function assistantToolContinuationMessage(result: RunRoundResult): ChatMessage {
  const message: ChatMessage = {
    role: 'assistant',
    content: result.contentAccum || null,
    tool_calls: result.toolCalls,
  };
  if (shouldEchoReasoningContent(result.providerId)) {
    // DeepSeek reasoning models require this field on assistant tool-call messages
    // in the continuation round. They may require it even when no reasoning text
    // was streamed, so echo an explicit empty string instead of omitting it.
    message.reasoning_content = result.reasoningAccum || '';
  }
  return message;
}

// Tool loop guard. Default raised to 50 — long research / agentic chains need 20-30 turns.
// Set BRAIN_V2_MAX_ITERATIONS=0 for unlimited (only abort on real errors).
const MAX_ITERATIONS = Number(process.env.BRAIN_V2_MAX_ITERATIONS || 50);
// P1#4: empty_response 不立即 cooldown。短期 cooldown,需累计 ≥ 2 次 transport-empty(零 SSE chunks)
// 注: 此判断只看 transport 层 anyEmit,不窥探 content。一个 finish_reason=stop+空 content 不会触发。
const EMPTY_RESPONSE_COOLDOWN_MS = Number(process.env.BRAIN_V2_EMPTY_COOLDOWN_MS || 30_000);
const EMPTY_THRESHOLD = Number(process.env.BRAIN_V2_EMPTY_THRESHOLD || 2);
const _emptyCounters = new Map<ProviderId, number>();
// Local provider fast probe (cold-start race avoidance). Opt-out via env.
const LOCAL_HEALTH_PROBE_ENABLED = process.env.BRAIN_V2_LOCAL_HEALTH_PROBE !== '0';
const DEFAULT_LOCAL_HEALTH_PROBE_MS = Number(process.env.BRAIN_V2_LOCAL_HEALTH_PROBE_MS || 1_500);
const LOCAL_SINGLE_SLOT_GUARD_ENABLED = process.env.BRAIN_V2_LOCAL_SINGLE_SLOT_GUARD !== '0';

function _bumpEmpty(providerId: ProviderId): number {
  const n = (_emptyCounters.get(providerId) || 0) + 1;
  _emptyCounters.set(providerId, n);
  return n;
}
function _resetEmpty(providerId: ProviderId): void {
  _emptyCounters.delete(providerId);
}

function isLocalEndpoint(endpoint: string): boolean {
  return typeof endpoint === 'string' && /^https?:\/\/(127\.0\.0\.1|localhost)/i.test(endpoint);
}

function buildLocalProbeUrl(provider: Provider): string {
  const endpointUrl = new URL(provider.endpoint);
  const healthPath = provider.health_path || '/models';
  if (/^https?:\/\//i.test(healthPath)) return healthPath;
  if (healthPath.startsWith('/')) {
    const url = new URL(endpointUrl.origin);
    url.pathname = healthPath;
    return url.toString();
  }
  const base = provider.endpoint.endsWith('/') ? provider.endpoint : provider.endpoint + '/';
  return new URL(healthPath, base).toString();
}

function buildLocalSlotsUrl(provider: Provider): string {
  const endpointUrl = new URL(provider.endpoint);
  const url = new URL(endpointUrl.origin);
  url.pathname = '/slots';
  return url.toString();
}

function localProbeTimeoutMs(provider: Provider): number {
  const configured = Number(provider.health_probe_ms || DEFAULT_LOCAL_HEALTH_PROBE_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 1_500;
}

function compactText(value: string, max = 220): string {
  const singleLine = value.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= max) return singleLine;
  return singleLine.slice(0, Math.max(1, max - 1)).trimEnd() + '…';
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function compactMaybe(value: unknown, max = 220): string | null {
  if (typeof value !== 'string') return null;
  const compacted = compactText(value, max);
  return compacted ? compacted : null;
}

function slotsFromPayload(payload: unknown): Array<Record<string, unknown>> | null {
  if (Array.isArray(payload)) {
    return payload.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item));
  }
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    if (Array.isArray(record.slots)) {
      return record.slots.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item));
    }
  }
  return null;
}

function slotIsBusy(slot: Record<string, unknown>): boolean {
  if (slot.is_processing === true || slot.processing === true || slot.busy === true) return true;
  const state = String(slot.state || slot.status || '').toLowerCase();
  return !!state && state !== 'idle' && state !== 'available' && state !== 'ready';
}

export function summarizeLocalSlots(payload: unknown): { total: number; busy: number } | null {
  const slots = slotsFromPayload(payload);
  if (!slots || slots.length === 0) return null;
  return {
    total: slots.length,
    busy: slots.filter(slotIsBusy).length,
  };
}

async function getLocalSlotSummary(provider: Provider): Promise<{ total: number; busy: number } | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), localProbeTimeoutMs(provider));
  try {
    const res = await fetch(buildLocalSlotsUrl(provider), { method: 'GET', signal: ctrl.signal }).catch(() => null);
    if (!res || !res.ok) return null;
    return summarizeLocalSlots(await res.json().catch(() => null));
  } finally {
    clearTimeout(timer);
  }
}

function shouldGuardLocalSingleSlot(provider: Provider): boolean {
  return LOCAL_SINGLE_SLOT_GUARD_ENABLED
    && String(provider.id) === 'apex-spark-i-balanced'
    && isLocalEndpoint(provider.endpoint);
}

function searchCitationFromItem(item: unknown): string | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const record = item as Record<string, unknown>;
  const title = compactMaybe(record.title ?? record.name ?? record.label, 120);
  const url = compactMaybe(record.url ?? record.link ?? record.href, 260);
  if (!title || !url) return null;
  const snippet = compactMaybe(record.snippet ?? record.summary ?? record.content ?? record.description, 260) || '';
  return `[${title}](${url}): ${snippet}`;
}

function structuredSearchSummary(parsed: Record<string, unknown>): { summary?: string; details?: string[] } | null {
  const summaries: string[] = [];
  const details: string[] = [];
  const addSummary = (value: unknown, prefix = '') => {
    const compacted = compactMaybe(value, 220);
    if (compacted) summaries.push(prefix ? `${prefix}: ${compacted}` : compacted);
  };
  const addCitation = (item: unknown) => {
    const citation = searchCitationFromItem(item);
    if (citation) details.push(citation);
  };

  addSummary(parsed.summary);
  if (Array.isArray(parsed.items)) parsed.items.forEach(addCitation);
  if (Array.isArray(parsed.results)) parsed.results.forEach(addCitation);

  if (Array.isArray(parsed.sources)) {
    for (const source of parsed.sources) {
      if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
      const record = source as Record<string, unknown>;
      const name = compactMaybe(record.name ?? record.source ?? record.provider, 80) || 'source';
      addSummary(record.summary, name);
      if (Array.isArray(record.items)) record.items.forEach(addCitation);
      if (Array.isArray(record.results)) record.results.forEach(addCitation);
      if (record.ok === false && record.error) {
        const error = compactMaybe(record.error, 160);
        if (error) details.push(`${name}: error: ${error}`);
      }
    }
  }

  const uniqueDetails = Array.from(new Set(details)).slice(0, 8);
  const picked = [
    ...summaries.slice(0, 2),
    ...uniqueDetails.slice(0, 2).map((line) => line.replace(/^\[([^\]]+)\]\([^)]+\):\s*/, '$1: ')),
  ];
  if (!picked.length && !uniqueDetails.length) return null;
  return {
    summary: picked.length ? compactText(picked.join(' · ')) : undefined,
    details: [
      ...summaries.map((line) => '摘要: ' + line),
      ...uniqueDetails,
    ].slice(0, 8).map((line) => compactText(line, 500)),
  };
}

function numberedSearchCitations(lines: string[]): string[] {
  const citations: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^\d+[.)、]\s*(.+)$/);
    if (!match) continue;
    const title = match[1].trim();
    const url = lines[i + 1]?.trim();
    if (!/^https?:\/\//.test(url || '')) continue;
    const snippet = lines[i + 2]?.trim() || '';
    citations.push(`[${title}](${url}): ${snippet}`);
  }
  return citations;
}

function summarizeToolResult(toolName: string, result: unknown): { summary?: string; details?: string[] } {
  const raw = typeof result === 'string' ? result : JSON.stringify(result);
  if (!raw || !raw.trim()) return {};

  const parsed = parseJsonObject(raw);
  if (parsed?.error) return { summary: compactText('error: ' + String(parsed.error), 180), details: [compactText(raw, 500)] };

  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^──.+──$/.test(line) && line !== '搜索结果:');

  if (toolName === 'web_search') {
    if (parsed) {
      const structured = structuredSearchSummary(parsed);
      if (structured) return structured;
    }
    const summaries = lines
      .filter((line) => /^摘要[:：]/.test(line))
      .map((line) => line.replace(/^摘要[:：]\s*/, ''))
      .filter(Boolean);
    const citations = [
      ...lines
      .filter((line) => /^\[[^\]]+\]\([^)]+\):/.test(line))
        .filter(Boolean),
      ...numberedSearchCitations(lines),
    ];
    const citationSummaries = citations
      .map((line) => line.replace(/^\[([^\]]+)\]\([^)]+\):\s*/, '$1: '))
      .filter(Boolean);
    const picked = [...summaries.slice(0, 2), ...citationSummaries.slice(0, 2)];
    if (picked.length) {
      return {
        summary: compactText(picked.join(' · ')),
        details: [...summaries.map((line) => '摘要: ' + line), ...citations].slice(0, 8).map((line) => compactText(line, 500)),
      };
    }
  }

  const firstMeaningful = lines.find((line) => !line.startsWith('{')) || raw;
  return {
    summary: compactText(firstMeaningful, 180),
    details: lines.slice(0, 6).map((line) => compactText(line, 500)),
  };
}

const GROUNDED_TOOL_NAMES = new Set([
  'web_search',
  'web_fetch',
  'live_news',
  'sports_score',
  'stock_market',
  'weather',
  'exchange_rate',
  'parallel_research',
]);

function formatToolResultContent(toolName: string, result: unknown, stepIndex: number): string {
  const raw = typeof result === 'string' ? result : JSON.stringify(result);
  if (!GROUNDED_TOOL_NAMES.has(toolName)) return raw;
  return [
    `【Lynn 工具证据 #${stepIndex}: ${toolName}】`,
    raw,
    '',
    '【回答约束】请只基于上方工具证据回答当前事实、赛程、比分、价格、日期、数值和来源。',
    '不要用旧知识或记忆补充工具证据里没有的具体事实；证据不足就明确说“工具结果中未查到”，并说明还需要继续检索。',
    '如果涉及时间，请保留工具证据中的日期/时区口径，换算时要说明换算依据。',
    '不要输出内部规划、英文自述或“The user wants...”这类中间推理文本。',
  ].join('\n');
}

function summarizeToolCallArgs(argsText: string | undefined): string | undefined {
  const parsed = parseJsonObject(argsText || '');
  if (!parsed) return undefined;
  const preferred = [
    parsed.query,
    parsed.q,
    parsed.url,
    parsed.city,
    parsed.location,
    parsed.code,
    parsed.name,
    parsed.title,
  ].find((value) => typeof value === 'string' && value.trim());
  if (typeof preferred === 'string') return compactText(preferred, 96);
  const pairs = Object.entries(parsed)
    .filter(([, value]) => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    .slice(0, 3)
    .map(([key, value]) => `${key}=${String(value)}`);
  return pairs.length ? compactText(pairs.join(' '), 96) : undefined;
}

async function runRound({
  messages,
  tools,
  capabilityRequired,
  signal,
  onChunk,
  log,
  extraBody,
  reasoningEffort,
  requestCache,
  audioCache,
}: Required<Pick<RouterRunOptions, 'onChunk'>> & Omit<RouterRunOptions, 'onChunk'> & { requestCache?: SearchRequestCache; audioCache?: AudioRequestCache }): Promise<RunRoundResult> {
  const errors: Array<{ providerId: ProviderId; error: string }> = [];
  // 2026-05-25 P0-1: track fallback chain so SSE consumer 可显示给 user
  // (例:"StepFun → Spark fallback"),不再让 cascade decision 对 UI 不可见。
  const fallbackChain: FallbackEntry[] = [];
  for (const providerId of providerOrderForCapability(capabilityRequired)) {
    const provider = getProvider(providerId);
    if (!provider) continue;
    if (!isProviderConfigured(provider)) {
      log && log('info', `provider ${providerId} has no credential, skip`);
      continue;
    }
    if (capabilityRequired?.vision && !provider.capability.vision) continue;
    if (capabilityRequired?.audio && !provider.capability.audio) continue;
    if (capabilityRequired?.video && !provider.capability.video) continue;
    // Capability check only: providers that declare no tool support are skipped for tool-attached requests.
    if (Array.isArray(tools) && tools.length > 0 && provider.capability && provider.capability.tools === false) {
      log && log('info', `provider ${providerId} skipped: tool-call request but capability.tools=false`);
      continue;
    }
    if (isInCooldown(providerId)) {
      log && log('info', `provider ${providerId} in cooldown, skip`);
      fallbackChain.push({ id: providerId, reason: 'cooldown' });
      continue;
    }
    // 本地 provider 快速探针 (避免 cold-start race + 1s ECONNREFUSED)。BRAIN_V2_LOCAL_HEALTH_PROBE=0 关
    if (LOCAL_HEALTH_PROBE_ENABLED && isLocalEndpoint(provider.endpoint)) {
      try {
        const probeCtrl = new AbortController();
        const probeTimer = setTimeout(() => probeCtrl.abort(), localProbeTimeoutMs(provider));
        const probeRes = await fetch(buildLocalProbeUrl(provider), { method: 'GET', signal: probeCtrl.signal })
          .catch(() => null);
        clearTimeout(probeTimer);
        if (!probeRes || !probeRes.ok) {
          log && log('info', `provider ${providerId} fast-probe failed, skip+cooldown`);
          markUnhealthy(providerId, 'health-probe-failed', 5000);
          fallbackChain.push({ id: providerId, reason: 'probe-failed' });
          continue;
        }
      } catch {
        log && log('info', `provider ${providerId} fast-probe threw, skip+cooldown`);
        markUnhealthy(providerId, 'health-probe-threw', 5000);
        fallbackChain.push({ id: providerId, reason: 'probe-threw' });
        continue;
      }
    }
    if (shouldGuardLocalSingleSlot(provider)) {
      const slotSummary = await getLocalSlotSummary(provider).catch(() => null);
      if (slotSummary && slotSummary.busy >= DUAL_BRAIN_LOCAL_MANAGER_MAX_CONCURRENCY) {
        log && log('info', `provider ${providerId} local single-slot busy (${slotSummary.busy}/${slotSummary.total}), skip`);
        fallbackChain.push({ id: providerId, reason: 'local-busy' });
        continue;
      }
    }

    const adapter = getAdapter(provider.wire);
    let anyEmit = false;
    let lastUsage: unknown = null;
    let sawReasoning = false;
    let finishReason: string | null = null;
    let contentAccum = '';
    let reasoningAccum = '';
    const toolCallsAcc: ToolCall[] = [];
    try {
      log && log('info', `→ provider ${providerId}`);
      const searchContext = await applySearchContext({ messages, provider, signal, log, requestCache });
      let effectiveMessages = searchContext.messages || messages;
      if (searchContext.meta.applied) {
        await onChunk(
          {
            type: 'pre_search',
            source: searchContext.meta.source,
            query: searchContext.meta.query,
            hit: searchContext.meta.hit,
            ms: searchContext.meta.ms,
            cached: searchContext.meta.cached,
          },
          { providerId, fallback_from: fallbackChain.length > 0 ? [...fallbackChain] : undefined },
        );
      }
      const audioContext = await applyAudioTranscribe({ messages: effectiveMessages, provider, signal, log, requestCache: audioCache });
      effectiveMessages = audioContext.messages || effectiveMessages;
      if (audioContext.meta?.applied) {
        await onChunk(
          {
            type: 'audio_fallback',
            source: String(audioContext.meta.source ?? 'whisper'),
            transcripts: Number(audioContext.meta.transcripts ?? 0),
            total: Number(audioContext.meta.total ?? 0),
            ms: Number(audioContext.meta.ms ?? 0),
          },
          { providerId, fallback_from: fallbackChain.length > 0 ? [...fallbackChain] : undefined },
        );
      }
      for await (const chunk of adapter({ provider, messages: effectiveMessages, tools, signal, log, extraBody, reasoningEffort })) {
        anyEmit = true;
        if (chunk.type === 'content') {
          contentAccum += chunk.delta;
          await onChunk(chunk, { providerId, fallback_from: fallbackChain.length > 0 ? [...fallbackChain] : undefined });
          continue;
        }
        if (chunk.type === 'tool_call_delta') {
          for (const d of (chunk.delta || [])) {
            const idx = d.index ?? 0;
            if (!toolCallsAcc[idx]) toolCallsAcc[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
            if (d.id) toolCallsAcc[idx].id = d.id;
            if (d.function?.name) toolCallsAcc[idx].function.name += d.function.name;
            if (d.function?.arguments) toolCallsAcc[idx].function.arguments += d.function.arguments;
          }
          await onChunk(chunk, { providerId, fallback_from: fallbackChain.length > 0 ? [...fallbackChain] : undefined });
          continue;
        }
        if (chunk.type === 'finish') {
          finishReason = chunk.reason;
          await onChunk(chunk, { providerId, fallback_from: fallbackChain.length > 0 ? [...fallbackChain] : undefined });
          continue;
        }
        if (chunk.type === 'usage') {
          lastUsage = (chunk as { usage?: unknown }).usage;
        }
        if (chunk.type === 'reasoning') {
          sawReasoning = true;
          reasoningAccum += String((chunk as { delta?: unknown }).delta || '');
        }
        await onChunk(chunk, { providerId, fallback_from: fallbackChain.length > 0 ? [...fallbackChain] : undefined });
      }
      // [prefix-cache 埋点] StepFun 流式 usage 的中途帧恒报 cached_tokens=0,只有最终帧带真值
      // (2026-06-10 实测)。这里只记最终帧,prod 日志可直接观测真实命中率。
      if (lastUsage && typeof lastUsage === 'object') {
        const u = lastUsage as Record<string, unknown>;
        const details = u.prompt_tokens_details as Record<string, unknown> | undefined;
        const cached = (typeof details?.cached_tokens === 'number' ? details.cached_tokens : undefined)
          ?? (typeof u.cached_tokens === 'number' ? u.cached_tokens : undefined);
        if (typeof u.prompt_tokens === 'number' && cached !== undefined) {
          const pct = u.prompt_tokens > 0 ? Math.round((cached / u.prompt_tokens) * 100) : 0;
          log && log('info', `provider ${providerId} usage: prompt=${u.prompt_tokens} completion=${u.completion_tokens ?? '?'} prefix-cache=${cached} (${pct}%)`);
        }
      }
      // anyEmit=false 表示 transport 层零 SSE chunks (真正 wire 失败)。
      // 注意: 这不是检测 "content 为空" — 一个 finish_reason=stop+空 content 仍算正常,因为 chunks≥1。
      if (!anyEmit) {
        const n = _bumpEmpty(providerId);
        log && log('warn', `provider ${providerId} transport-empty (${n}/${EMPTY_THRESHOLD})`);
        if (n >= EMPTY_THRESHOLD) {
          log && log('warn', `provider ${providerId} reached empty threshold, ${EMPTY_RESPONSE_COOLDOWN_MS}ms cooldown`);
          markUnhealthy(providerId, 'empty_response_threshold', EMPTY_RESPONSE_COOLDOWN_MS);
        }
        fallbackChain.push({ id: providerId, reason: 'empty' });
        continue;
      }
      _resetEmpty(providerId);
      return {
        ok: true,
        providerId,
        finishReason,
        toolCalls: toolCallsAcc.filter(Boolean),
        contentAccum,
        reasoningAccum,
        sawReasoning,
      };
    } catch (e) {
      const err = e as ProviderError;
      const message = errorMessage(e);
      errors.push({ providerId, error: message });
      const logMsg = err.suppressBody
        ? `provider ${providerId} failed: HTTP-auth (suppressed), fallback`
        : `provider ${providerId} failed: ${message}, fallback`;
      log && log('warn', logMsg);
      markUnhealthy(providerId, message, err.cooldownMs ?? null); // variable cooldown for auth fail
      fallbackChain.push({ id: providerId, reason: 'error' });
      continue;
    }
  }
  const err = new Error('all providers failed') as Error & { errors: typeof errors };
  err.errors = errors;
  throw err;
}

export async function run({ messages, tools, capabilityRequired, signal, onChunk, log, extraBody, reasoningEffort }: RouterRunOptions): Promise<RouterRunResult> {
  // Capability pre-flight — vision/audio/video capability gate, friendly error if no provider supports
  if (capabilityRequired && (capabilityRequired.vision || capabilityRequired.audio || capabilityRequired.video)) {
    const anySupports = providerOrderForCapability(capabilityRequired).some((id) => {
      const p = getProvider(id);
      if (!p) return false;
      if (capabilityRequired.vision && !p.capability.vision) return false;
      if (capabilityRequired.audio && !p.capability.audio) return false;
      if (capabilityRequired.video && !p.capability.video) return false;
      return true;
    });
    if (!anySupports) {
      const missing = [
        capabilityRequired.vision && 'vision',
        capabilityRequired.audio && 'audio',
        capabilityRequired.video && 'video',
      ].filter(Boolean).join('+');
      const err = new Error(`CAPABILITY_NOT_SUPPORTED: no provider supports ${missing} in current build`) as Error & { code: string };
      err.code = 'CAPABILITY_NOT_SUPPORTED';
      throw err;
    }
  }

  const mergedTools = mergeWithServerTools(tools, messages);
  let workingMessages: ChatMessage[] = [...(messages || [])];
  let lastProviderId: ProviderId | null = null;
  let iter = 0;
  const maxIter = MAX_ITERATIONS > 0 ? MAX_ITERATIONS : Infinity;
  const requestCache = createSearchRequestCache();
  const audioCache = createAudioRequestCache() as AudioRequestCache;
  const toolStormConfig = readToolStormConfigFromEnv();
  const toolStormState = createToolStormState();
  const toolResultCompactionConfig = readToolResultCompactionConfigFromEnv();
  let serverToolStepIndex = 0;
  // [overflow-retry] activeReasoning can be stepped down once if a reasoning model blows past
  // max_tokens mid-<think> (finish_reason=length with no usable answer), so the answer fits.
  let activeReasoning = reasoningEffort;
  let lengthRetried = false;
  // [tool-round effort-down] Continuation rounds (after server-tool results are fed back) mostly
  // integrate observations instead of re-deriving the plan; at the provider-default `high` they
  // re-burn a long <think> per round. When the CLIENT did not pin an effort (null/auto → provider
  // default applies), drop continuation rounds to `medium`. Explicit client efforts are honored.
  // Kill switch: LYNN_TOOL_ROUND_EFFORT_DOWN=0.
  const clientPinnedReasoning = !(reasoningEffort == null || String(reasoningEffort).toLowerCase() === 'auto');
  const toolRoundEffortDown = process.env.LYNN_TOOL_ROUND_EFFORT_DOWN !== '0';
  const stepDownReasoning = (effort: string | null | undefined): string => {
    const e = String(effort || 'high').toLowerCase();
    if (e === 'medium') return 'low';
    if (e === 'low' || e === 'off' || e === 'none' || e === 'disabled') return 'low';
    return 'medium'; // high / xhigh / auto / null → medium
  };

  while (iter < maxIter) {
    iter++;
    const result = await runRound({
      messages: workingMessages, tools: mergedTools, capabilityRequired,
      signal, onChunk, log, extraBody, reasoningEffort: activeReasoning,
      requestCache,
      audioCache,
    });
    lastProviderId = result.providerId;

    // [empty-answer retry] 两种"只想不说"的空答形态,各重试一次(共用一次配额):
    //  a) finish=length:reasoning 撑爆 max_tokens,正文没出来(StepFun 高档思考的老问题);
    //  b) finish=stop + sawReasoning:模型思考完就正常收流,一个字正文都没给 ——
    //     2026-06-10 用户实测(工具轮后"有授权卡片但最后没有反馈"的上游根因)。
    // 都是降一档 reasoning + 直答 nudge 重试,不编造内容。
    const emptyAnswer = result.toolCalls.length === 0 && !String(result.contentAccum || '').trim();
    const reasoningOnlyStop = result.finishReason === 'stop' && result.sawReasoning;
    if (
      emptyAnswer
      && !lengthRetried
      && (result.finishReason === 'length' || reasoningOnlyStop)
    ) {
      lengthRetried = true;
      activeReasoning = stepDownReasoning(activeReasoning);
      log && log('warn', `provider ${lastProviderId} ${result.finishReason === 'length' ? 'length-overflow' : 'reasoning-only stop'} with empty answer; retry once with reasoning=${activeReasoning}`);
      workingMessages.push({
        role: 'user',
        content: '上一次回答没有给出可见的正文答案。请基于已有的上下文和工具结果,直接、简洁地给出最终答案,不要再展开完整的思考过程。',
      });
      continue;
    }

    // Model 自然结束 (stop / length / content_filter / function_call 等非 tool_calls) → 透传完成
    if (result.finishReason !== 'tool_calls' || result.toolCalls.length === 0) {
      return { ok: true, providerId: lastProviderId, iterations: iter };
    }

    const serverCalls = result.toolCalls.filter((tc) => isServerTool(tc.function?.name));
    const clientCalls = result.toolCalls.filter((tc) => !isServerTool(tc.function?.name));

    // 客户端工具 (client 自己执行) → 透传 tool_calls 到客户端,loop 退出
    if (clientCalls.length > 0) {
      log && log('info', `iter ${iter}: ${clientCalls.length} client-side tool_calls forwarded, stop loop`);
      return {
        ok: true, providerId: lastProviderId, iterations: iter,
        forwardedToClient: true, clientToolCalls: clientCalls.length,
        toolCalls: result.toolCalls,
        bufferedContentChunks: [],
        bufferedFinishChunk: { type: 'finish', reason: 'tool_calls' },
      };
    }

    // 服务端工具 → brain 代执行,结果回灌 messages,下一轮再问 model
    log && log('info', `iter ${iter}: ${serverCalls.length} server-side tool_calls, executing...`);
    workingMessages.push(assistantToolContinuationMessage(result));
    // Phase 1 (serial): storm verdicts. Storm counting is order-dependent on the CALL sequence
    // only (name+args repetition), never on execution results, so verdicts are decided up front.
    // Hitting the storm ceiling aborts the round before executing the remaining tools.
    let stormLimitHit: ReturnType<typeof observeToolCallStorm> | null = null;
    const runnable: Array<{ tc: ToolCall; order: number }> = [];
    for (const tc of serverCalls) {
      const stormVerdict = observeToolCallStorm(toolStormState, tc, toolStormConfig);
      if (!stormVerdict.storm) {
        runnable.push({ tc, order: runnable.length });
        continue;
      }
      log && log('warn', `tool storm suppressed: ${stormVerdict.toolName} repeat=${stormVerdict.seen} storms=${stormVerdict.stormCount}/${toolStormConfig.maxStorms}`);
      const argsSummary = summarizeToolCallArgs(tc.function.arguments);
      await onChunk(
        { type: 'tool_progress', event: 'start', name: tc.function.name, argsSummary },
        { providerId: lastProviderId }
      );
      await onChunk(
        { type: 'tool_progress', event: 'end', name: tc.function.name, ms: 0, ok: false, argsSummary },
        { providerId: lastProviderId }
      );
      workingMessages.push({
        role: 'tool',
        tool_call_id: tc.id || ('tc-' + Math.random().toString(36).slice(2)),
        content: buildToolStormReflection(stormVerdict),
      });
      if (stormVerdict.maxStormsReached) {
        stormLimitHit = stormVerdict;
        break;
      }
    }
    if (stormLimitHit) {
      await onChunk(
        { type: 'error', error: 'tool_storm_limit', tool: stormLimitHit.toolName, storms: stormLimitHit.stormCount },
        { providerId: lastProviderId }
      );
      return {
        ok: false,
        providerId: lastProviderId,
        iterations: iter,
        error: 'tool_storm_limit',
      };
    }
    // Phase 2 (parallel): independent server tools run concurrently (cap via
    // BRAIN_V2_TOOL_PARALLEL, default 4, 1 = serial). Progress chunks emit in real time as each
    // tool starts/ends; tool RESULT messages are appended in the model's original call order so
    // the conversation stays deterministic.
    const toolParallel = Math.max(1, Number(process.env.BRAIN_V2_TOOL_PARALLEL || 4) || 1);
    const toolOutcomes: Array<{ tc: ToolCall; toolResult: string } | null> = new Array(runnable.length).fill(null);
    // A round that produced tool_calls always has an active provider; capture it as non-null for
    // the worker closures (let-narrowing does not flow into async closures).
    const roundProviderId = lastProviderId as ProviderId;
    let nextRunnable = 0;
    const runToolWorker = async (): Promise<void> => {
      for (;;) {
        const slot = nextRunnable;
        if (slot >= runnable.length) return;
        nextRunnable += 1;
        const { tc, order } = runnable[slot];
        const argsSummary = summarizeToolCallArgs(tc.function.arguments);
        const t0 = Date.now();
        // 工具进度通过自定义 chunk type 表达,不污染 content stream (F5 fix)
        // Lynn UI 消费 type=tool_progress;非 Lynn 客户端 ignored。
        await onChunk(
          { type: 'tool_progress', event: 'start', name: tc.function.name, argsSummary },
          { providerId: roundProviderId }
        );
        const toolResult = await executeServerTool(tc.function.name, tc.function.arguments || '{}', { log });
        const ms = Date.now() - t0;
        const ok = toolResult && !String(toolResult).startsWith('{"error"') && !String(toolResult).startsWith('{"ok":false');
        const toolSummary = summarizeToolResult(tc.function.name, toolResult);
        await onChunk(
          { type: 'tool_progress', event: 'end', name: tc.function.name, ms, ok: !!ok, argsSummary, ...toolSummary },
          { providerId: roundProviderId }
        );
        toolOutcomes[order] = { tc, toolResult };
      }
    };
    await Promise.all(Array.from({ length: Math.min(toolParallel, runnable.length) }, () => runToolWorker()));
    for (const outcome of toolOutcomes) {
      if (!outcome) continue;
      workingMessages.push({
        role: 'tool',
        tool_call_id: outcome.tc.id || ('tc-' + Math.random().toString(36).slice(2)),
        content: formatToolResultContent(outcome.tc.function.name, outcome.toolResult, ++serverToolStepIndex),
      });
    }
    workingMessages = compactToolResults(workingMessages, toolResultCompactionConfig);
    if (toolRoundEffortDown && !clientPinnedReasoning) {
      const e = String(activeReasoning || 'auto').toLowerCase();
      if (e === 'auto' || e === 'high' || e === 'xhigh') {
        activeReasoning = 'medium';
        log && log('info', `iter ${iter}: tool continuation round → reasoning=medium (was ${e}; set LYNN_TOOL_ROUND_EFFORT_DOWN=0 to disable)`);
      }
    }
  }
  // 达 MAX_ITERATIONS 上限 → emit 显式 error chunk (不再撒谎成 finish:stop)
  log && log('warn', `hit MAX_ITERATIONS=${MAX_ITERATIONS}, emit error chunk`);
  if (lastProviderId) {
    await onChunk(
      { type: 'error', error: 'max_iterations_reached', limit: MAX_ITERATIONS, iterations: iter },
      { providerId: lastProviderId }
    );
  }
  return {
    ok: false,
    providerId: lastProviderId,
    iterations: iter,
    hitMaxIterations: true,
    error: 'max_iterations_reached',
  };
}

export function detectCapability(messages?: ChatMessage[]): CapabilityRequired {
  const result = { vision: false, audio: false, video: false };
  for (const m of (messages || [])) {
    const c = m.content;
    if (!Array.isArray(c)) continue;
    for (const part of c) {
      if (!part || typeof part !== 'object') continue;
      const typedPart = part as { type?: string };
      if (typedPart.type === 'image_url' || typedPart.type === 'input_image') result.vision = true;
      if (typedPart.type === 'input_audio' || typedPart.type === 'audio_url') result.audio = true;
      if (typedPart.type === 'input_video' || typedPart.type === 'video_url') result.video = true;
    }
  }
  return result;
}

export const __testing__ = {
  _emptyCounters,
  buildLocalProbeUrl,
  buildLocalSlotsUrl,
  isLocalEndpoint,
  localProbeTimeoutMs,
  summarizeLocalSlots,
  summarizeToolResult,
};
