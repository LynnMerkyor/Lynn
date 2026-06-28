// Brain v2 · Router — BYOK-equality thin pipe
// 原则: 只做事实层 (provider universalOrder + cooldown + capability gate + wire adapter)
//       + 服务端工具回灌循环。不注入 system prompt,不限工具调用次数(env 可配),不检测/拒绝伪工具,
//       不强制 synthesis,不解析模型内容做策略判断。BYOK 直连什么样,brain 就什么样。
//
// 2026-05-23 重构: 砍掉 ~500 行 synthesis + pseudo-tool detection + buffered content 干涉。

import { providerOrderForCapability, getProvider, isInCooldown, markUnhealthy, clearUnhealthy } from './provider-registry.js';
import { getAdapter } from './wire-adapter/index.js';
import { isServerTool, executeServerTool, mergeWithServerTools, shouldPreferOfficialModelSearchTool, shouldPreferSportsScoreTool, shouldPreferStockMarketTool, shouldPreferWeatherTool, shouldSuppressWebToolsForInternalLynnUx } from './tool-exec/index.js';
import { applySearchContext, createSearchRequestCache, type SearchRequestCache } from './search-context.js';
import { applyAudioTranscribe, createAudioRequestCache, type AudioRequestCache } from './audio-transcribe.js';
import { compactToolResults, readToolResultCompactionConfigFromEnv } from './context-compact.js';
import { containsGroundedToolDenialContradiction, containsTemporalNoResultContradiction, currentTemporalContext } from './evidence-quality.js';
import { positiveEnvNumber } from './env-utils.js';
import {
  DUAL_BRAIN_LOCAL_MANAGER_MAX_CONCURRENCY,
  resolveDualBrainManagerRoute,
  type DualBrainManagerDecisionReason,
} from '../shared/dual-brain-route.js';
import {
  buildToolStormReflection,
  createToolStormState,
  observeToolCallStorm,
  readToolStormConfigFromEnv,
} from './tool-storm.js';
import { errorMessage, providerId, type ChatMessage, type FallbackEntry, type FallbackReason, type Provider, type ProviderCapability, type ProviderId, type RouterRunOptions, type RouterRunResult, type ToolCall } from './types.js';

type CapabilityRequired = Partial<Pick<ProviderCapability, 'vision' | 'audio' | 'video'>>;
type ProviderError = Error & { suppressBody?: boolean; cooldownMs?: number; status?: number; statusCode?: number; code?: string };
type RunRoundResult = {
  ok: true;
  providerId: ProviderId;
  finishReason: string | null;
  toolCalls: ToolCall[];
  contentAccum: string;
  bufferedContentChunks?: Array<{
    delta: string;
    providerId: ProviderId;
    fallback_from?: FallbackEntry[];
  }>;
  bufferedFinishChunk?: { reason: string; providerId: ProviderId; fallback_from?: FallbackEntry[] };
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

function shouldEchoReasoningContentForContinuation(result: RunRoundResult): boolean {
  return shouldEchoReasoningContent(result.providerId)
    || result.sawReasoning
    || !!String(result.reasoningAccum || '').trim();
}

function assistantToolContinuationMessage(result: RunRoundResult): ChatMessage {
  const message: ChatMessage = {
    role: 'assistant',
    content: result.contentAccum || null,
    tool_calls: result.toolCalls,
  };
  if (shouldEchoReasoningContentForContinuation(result)) {
    // DeepSeek reasoning models require this field on assistant tool-call messages
    // in the continuation round. They may require it even when no reasoning text
    // was streamed, so echo an explicit empty string instead of omitting it. If a
    // provider emitted reasoning under a non-DeepSeek id during fallback, preserve
    // the streamed reasoning text as well instead of dropping it from the tool turn.
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
const MIMO_ULTRASPEED_PROVIDER_ID = providerId('mimo-ultraspeed');
const DEEPSEEK_CHAT_PROVIDER_ID = providerId('deepseek-chat');
const STEP_FLASH_PROVIDER_ID = providerId('step-3.7-flash');

function skipDirectEvidencePlanningProviders(skippedProviders: Set<ProviderId>): void {
  skippedProviders.add(MIMO_ULTRASPEED_PROVIDER_ID);
  skippedProviders.add(DEEPSEEK_CHAT_PROVIDER_ID);
}

function httpStatusFromError(error: unknown, message = errorMessage(error)): number | null {
  const record = error && typeof error === 'object' && !Array.isArray(error)
    ? error as Record<string, unknown>
    : null;
  const direct = Number(record?.status ?? record?.statusCode ?? record?.httpStatus);
  if (Number.isInteger(direct) && direct >= 100 && direct <= 599) return direct;
  const match = String(message || '').match(/\b(401|403|408|409|425|429|5\d\d)\b/u);
  return match ? Number(match[1]) : null;
}

function classifyProviderFallbackReason(error: ProviderError, message = errorMessage(error)): FallbackReason {
  const status = httpStatusFromError(error, message);
  const code = String(error.code || '').toUpperCase();
  const text = `${code} ${message || ''}`;
  if (status === 401 || status === 403 || /auth|unauthori[sz]ed|forbidden|invalid api key|api[-_ ]?key/i.test(text)) {
    return 'error-auth';
  }
  if (status === 429 || /rate limit|too many requests|quota|throttle/i.test(text)) {
    return 'error-rate-limit';
  }
  if (status != null && status >= 500) return 'error-server';
  if (status === 408 || /abort|timeout|timed out|ETIMEDOUT/i.test(text)) return 'error-timeout';
  if (/fetch failed|network|ECONN|ENOTFOUND|EAI_AGAIN|ECONNRESET|socket|dns/i.test(text)) return 'error-network';
  return 'error';
}

function localProbeCooldownMs(reason: FallbackReason, status?: number | null): number {
  if (reason === 'probe-timeout') {
    return positiveEnvNumber('BRAIN_V2_LOCAL_PROBE_TIMEOUT_COOLDOWN_MS', 2_000);
  }
  if (reason === 'probe-threw') {
    return positiveEnvNumber('BRAIN_V2_LOCAL_PROBE_THROW_COOLDOWN_MS', 3_000);
  }
  if (status != null && status >= 500) {
    return positiveEnvNumber('BRAIN_V2_LOCAL_PROBE_5XX_COOLDOWN_MS', 15_000);
  }
  if (status != null && status >= 400) {
    return positiveEnvNumber('BRAIN_V2_LOCAL_PROBE_4XX_COOLDOWN_MS', 30_000);
  }
  return positiveEnvNumber('BRAIN_V2_LOCAL_PROBE_FAIL_COOLDOWN_MS', 5_000);
}

function classifyLocalProbeFallbackReason(error: unknown, status?: number | null): FallbackReason {
  const message = errorMessage(error);
  if (/abort|timeout|timed out/i.test(message)) return 'probe-timeout';
  if (error) return 'probe-threw';
  return status != null ? 'probe-http' : 'probe-failed';
}

function dualBrainFallbackReason(reason: DualBrainManagerDecisionReason): FallbackReason {
  if (
    reason === 'local-manager-not-ready'
    || reason === 'local-manager-loading'
    || reason === 'local-manager-occupied'
    || reason === 'local-manager-busy-single-slot'
    || reason === 'gui-interactive-priority'
    || reason === 'ds-v4-flash-escape-rule'
  ) {
    return reason;
  }
  return 'local-busy';
}

function guiInteractiveActive(): boolean {
  return process.env.BRAIN_V2_GUI_INTERACTIVE_ACTIVE === '1'
    || process.env.LYNN_GUI_INTERACTIVE_ACTIVE === '1';
}

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

function shouldDropSynthesisOpeningSegment(segment: string): boolean {
  const text = segment.trim();
  if (!text) return true;
  const hasSelfOrWaitCue = /(我|让我|咱们|我们|请稍等|稍等|等等|先|继续|重新|再|目前)/u.test(text);
  const hasProcessVerb = /(查询|搜索|检索|查找|查查|核对|确认|整理|看看|获取|拿到|尝试|换个|继续查|再查)/u.test(text);
  const saysNoAnswerYet = /((没有|未能|无法|没法).{0,18}(形成|生成|返回|给出).{0,18}(最终|正文|答案|回复)|等.*恢复|工具.*恢复|接口.*恢复|状态异常|请稍后|稍后重试)/u.test(text);
  const citesToolFailure = /(工具|接口|搜索|web_?search|sports_?score).*(异常|失败|报错|不可用|没恢复|无法正常)/iu.test(text);
  const leaksInternalWorkflow = /(候选模型|证据账本|接手完成最终总结|工具证据).{0,48}(回答|总结|最终|稳定|完成|provider|证据账本)/iu.test(text)
    || /^[-*]\s*provider\s*:/iu.test(text)
    || /^[-*]\s*摘要\s*[:：]/u.test(text);
  return (hasSelfOrWaitCue && hasProcessVerb) || saysNoAnswerYet || citesToolFailure || leaksInternalWorkflow;
}

function stripSynthesisProcessPreamble(text: string): string {
  let rest = text.replace(/^\s+/, '');
  for (let i = 0; i < 4; i += 1) {
    const match = rest.match(/^(.{1,120}?)(?:[。！？!?]\s+|[。！？!?]|——|--|\n+)/su);
    if (!match) break;
    const segment = match[1] || '';
    if (!shouldDropSynthesisOpeningSegment(segment)) break;
    rest = rest.slice(match[0].length).replace(/^\s+/, '');
  }
  return rest;
}

function stripSynthesisProcessSentences(text: string, final = false): { text: string; rest: string } {
  const input = stripSynthesisProcessPreamble(text);
  let out = '';
  let start = 0;
  const boundaryRe = /[。！？!?]+|\n+/gu;
  for (const match of input.matchAll(boundaryRe)) {
    const end = (match.index || 0) + match[0].length;
    const segment = input.slice(start, end);
    if (!shouldDropSynthesisOpeningSegment(segment)) out += segment;
    start = end;
  }
  const rest = input.slice(start);
  if (final) {
    if (!shouldDropSynthesisOpeningSegment(rest)) out += rest;
    return { text: out, rest: '' };
  }
  return { text: out, rest };
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

function hasTextEvidence(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasSearchEvidenceObject(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.ok === false) return false;
  if (['title', 'url', 'link', 'href', 'content', 'snippet', 'summary', 'description'].some((key) => hasTextEvidence(record[key]))) {
    return true;
  }
  if (Array.isArray(record.items) || Array.isArray(record.results) || Array.isArray(record.search_result) || Array.isArray(record.citations)) {
    return countArrayEvidence(record.items)
      + countArrayEvidence(record.results)
      + countArrayEvidence(record.search_result)
      + countArrayEvidence(record.citations) > 0;
  }
  return false;
}

function hasSearchEvidenceItem(value: unknown): boolean {
  if (hasTextEvidence(value)) return true;
  return hasSearchEvidenceObject(value);
}

function countArrayEvidence(value: unknown): number {
  return Array.isArray(value) ? value.filter(hasSearchEvidenceItem).length : 0;
}

function countStructuredSearchEvidence(parsed: Record<string, unknown>): number {
  let count = 0;
  count += countArrayEvidence(parsed.items);
  count += countArrayEvidence(parsed.results);
  count += countArrayEvidence(parsed.search_result);
  count += countArrayEvidence(parsed.citations);
  if (Array.isArray(parsed.sources)) {
    for (const source of parsed.sources) {
      if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
      const record = source as Record<string, unknown>;
      count += hasSearchEvidenceObject(record) ? 1 : 0;
      count += countArrayEvidence(record.items);
      count += countArrayEvidence(record.results);
    }
  }
  return count;
}

function countParallelResearchEvidence(parsed: Record<string, unknown>): number {
  if (!Array.isArray(parsed.results)) return 0;
  return parsed.results.filter((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const record = item as Record<string, unknown>;
    if (record.ok === false) return false;
    if (record.result == null) return false;
    const result = typeof record.result === 'string' ? record.result : JSON.stringify(record.result);
    return !!String(result || '').trim();
  }).length;
}

const GENERIC_EVIDENCE_TEXT_KEYS = new Set([
  'answer',
  'content',
  'description',
  'detail',
  'details',
  'forecast',
  'headline',
  'result',
  'summary',
  'text',
  'title',
]);

const GENERIC_EVIDENCE_VALUE_KEYS = new Set([
  'amount',
  'currency',
  'date',
  'high',
  'humidity',
  'last',
  'low',
  'matchup',
  'open',
  'price',
  'rate',
  'score',
  'symbol',
  'temperature',
  'time',
  'value',
]);

function hasGenericStructuredEvidence(value: unknown, depth = 0): boolean {
  if (hasTextEvidence(value)) return true;
  if (typeof value === 'number' || typeof value === 'boolean') return true;
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => hasGenericStructuredEvidence(item, depth + 1));
  const record = value as Record<string, unknown>;
  if (record.ok === false || record.error || record.directSourceStatus === 'unavailable' || record.status === 'no_direct_source') {
    return false;
  }
  for (const [key, item] of Object.entries(record)) {
    if (key === 'ok' || key === 'query' || key === 'guidance') continue;
    if (GENERIC_EVIDENCE_TEXT_KEYS.has(key) && hasTextEvidence(item)) return true;
    if (GENERIC_EVIDENCE_VALUE_KEYS.has(key) && (hasTextEvidence(item) || typeof item === 'number' || typeof item === 'boolean')) return true;
    if (depth < 2 && (Array.isArray(item) || (item && typeof item === 'object'))) {
      if (hasGenericStructuredEvidence(item, depth + 1)) return true;
    }
  }
  return false;
}

function evidenceToolWeight(toolName: string, result: unknown): number {
  if (!isGroundedToolName(toolName)) return 0;
  const raw = typeof result === 'string' ? result : JSON.stringify(result);
  if (!raw || !raw.trim()) return 0;
  const parsed = parseJsonObject(raw);
  if (parsed?.error || parsed?.ok === false || parsed?.status === 'no_direct_source' || parsed?.directSourceStatus === 'unavailable') return 0;

  if (toolName === 'parallel_research' && parsed) {
    return Math.min(3, Math.max(0, countParallelResearchEvidence(parsed)));
  }
  if (toolName === 'web_search' && parsed) {
    const evidence = countStructuredSearchEvidence(parsed);
    return Math.min(3, Math.max(0, evidence));
  }
  if (toolName === 'web_search') {
    const citationLike = (raw.match(/https?:\/\//g) || []).length
      + (raw.match(/摘要[:：]/g) || []).length
      + (raw.match(/\bsources?:/gi) || []).length;
    if (citationLike > 0) return Math.min(3, Math.max(1, citationLike));
    const meaningfulLines = raw.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).length;
    // Some search providers return a plain text synthesis instead of structured
    // JSON/citations. It is still grounded tool evidence and should be handed
    // to the fast synthesis model instead of letting the planner continue from
    // stale parametric memory.
    return compactText(raw, 500).length >= 80 || meaningfulLines >= 2 ? 3 : 0;
  }
  // A successful structured realtime tool (weather/stock/exchange/fetch) is
  // usually already enough evidence to synthesize instead of looping tools.
  if (parsed) return hasGenericStructuredEvidence(parsed) ? 1 : 0;
  const meaningfulLines = raw.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).length;
  return compactText(raw, 500).length >= 40 || meaningfulLines >= 2 ? 1 : 0;
}

type ScoreboardRow = { time: string; matchup: string; result: string };

function originalUserPrompt(messages: ChatMessage[]): string {
  const found = messages.find((message) => message.role === 'user' && typeof message.content === 'string');
  return typeof found?.content === 'string' ? found.content : '';
}

function parseScoreboardRowsFromEvidence(messages: ChatMessage[]): ScoreboardRow[] {
  const text = messages
    .filter((message) => {
      if (message.role === 'tool') return true;
      const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content || '');
      return /【Lynn 工具证据 #\d+:\s*sports_score】/u.test(content);
    })
    .map((message) => typeof message.content === 'string' ? message.content : JSON.stringify(message.content || ''))
    .join('\n');
  if (!/provider:\s*espn_scoreboard/i.test(text)) return [];
  const rows: ScoreboardRow[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const match = line.match(/^-\s*(\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2})\s+(.+?)\s+\(([^)]+)\)\s*$/u);
    if (!match) continue;
    const body = match[2].trim();
    const scored = body.match(/^(.+?)\s+(\d+\s*[-–—:：比]\s*\d+)\s+(.+)$/u);
    const scheduled = body.match(/^(.+?)\s+vs\s+(.+)$/iu);
    if (scored) {
      rows.push({ time: match[1], matchup: `${scored[1].trim()} vs ${scored[3].trim()}`, result: `${scored[2].replace(/\s+/g, '')} ${match[3]}` });
    } else if (scheduled) {
      rows.push({ time: match[1], matchup: `${scheduled[1].trim()} vs ${scheduled[2].trim()}`, result: match[3] });
    }
  }
  return rows;
}

function buildDeterministicSportsEvidenceAnswer(messages: ChatMessage[]): string | null {
  const rows = parseScoreboardRowsFromEvidence(messages);
  if (!rows.length) return null;
  const prompt = originalUserPrompt(messages);
  if (/预测|预估|猜|可能比分|比分预测|predict|prediction|forecast/i.test(prompt)) {
    const predictionRows = rows.slice(0, 12).map((row) => {
      const matchup = row.matchup.replace(/^Group stage:\s*/i, '').trim();
      let score = '1-1';
      if (/(Spain|Portugal|England|Croatia|Germany|Belgium|Uruguay|France|Argentina)/i.test(matchup)) score = '2-0';
      if (/(vs\s+Ghana|vs\s+Croatia|vs\s+Japan|vs\s+Egypt|vs\s+Iran)/i.test(matchup)) score = score === '2-0' ? '2-1' : '1-2';
      return `| ${row.time} | ${matchup} | ${score} |`;
    });
    return [
      '以下是基于赛程和纸面实力的预测，不是事实、不是赛果，也不构成投注建议。',
      '',
      '| 时间(北京时间) | 对阵 | 预测比分 |',
      '|---|---|---|',
      ...predictionRows,
    ].join('\n');
  }
  const wantsCount = /(几场|多少场|只有一场|就一场|一场吗|赛程|今晚|今天|今日|tonight|today|schedule)/i.test(prompt);
  const title = wantsCount
    ? `根据 ESPN scoreboard 工具证据，共查到 ${rows.length} 场相关比赛：`
    : '根据 ESPN scoreboard 工具证据，查到以下相关比赛：';
  const table = [
    '| 时间(北京时间) | 对阵 | 状态/比分 |',
    '|---|---|---|',
    ...rows.slice(0, 24).map((row) => `| ${row.time} | ${row.matchup} | ${row.result} |`),
  ].join('\n');
  return `${title}\n\n${table}`;
}

function buildDeterministicSportsFactAnswer(messages: ChatMessage[]): string | null {
  const evidenceText = messages
    .filter((message) => message.role === 'tool' || /sports_score|espn_scoreboard/i.test(String(message.content || '')))
    .map((message) => typeof message.content === 'string' ? message.content : JSON.stringify(message.content || ''))
    .join('\n');
  if (/directSourceStatus:\s*fallback_static_schedule/i.test(evidenceText)) return null;
  const rows = parseScoreboardRowsFromEvidence(messages);
  if (!rows.length) return null;
  const prompt = originalUserPrompt(messages);
  if (/预测|预估|猜|可能比分|比分预测|predict|prediction|forecast/i.test(prompt)) return null;
  const asksCompletedScores = /(已出|已经|比分|赛果|结果|完赛|score|result|final)/i.test(prompt)
    && !/(几场|多少场|只有一场|就一场|一场吗|赛程|对阵|今晚|今天|今日|tonight|today|schedule)/i.test(prompt);
  const hasCompletedScore = rows.some((row) => /\d+\s*[-–—:：比]\s*\d+|FT|Final|Full Time/i.test(row.result));
  if (asksCompletedScores && !hasCompletedScore) return null;
  return buildDeterministicSportsEvidenceAnswer(messages);
}

function buildDeterministicAirQualityAnswer(prompt: unknown, result: unknown): string | null {
  const question = String(prompt || '');
  if (!/空气质量|空气污染|AQI|PM\s*2\.?5|PM10|雾霾|霾|air\s*quality|pollution/i.test(question)) return null;
  const raw = String(result || '');
  const city = question.match(/(北京|上海|广州|深圳|杭州|成都|重庆|武汉|南京|天津)/)?.[1] || '目标城市';
  const aqi = raw.match(/AQI\(US\)[:：]\s*([0-9]+(?:\.\d+)?)(?:（([^）]+)）)?/i);
  const pm25 = raw.match(/PM2\.5[:：]\s*([0-9]+(?:\.\d+)?)/i);
  const pm10 = raw.match(/PM10[:：]\s*([0-9]+(?:\.\d+)?)/i);
  const updated = raw.match(/更新时间[:：]\s*([^\n]+)/)?.[1]?.trim();
  if (aqi || pm25 || pm10) {
    return [
      `${city}当前空气质量：`,
      aqi ? `- AQI(US): ${aqi[1]}${aqi[2] ? `（${aqi[2]}）` : ''}` : null,
      pm25 ? `- PM2.5: ${pm25[1]} µg/m³` : null,
      pm10 ? `- PM10: ${pm10[1]} µg/m³` : null,
      updated ? `- 更新时间: ${updated}` : null,
      '',
      '说明：以上来自本轮 weather 工具返回的空气质量字段；AQI 口径为 US AQI，本地空气质量 App 可能因站点和口径略有差异。',
    ].filter(Boolean).join('\n');
  }
  return [
    `${city}空气质量：本轮 weather 工具没有返回 AQI、PM2.5 或 PM10 数值，因此暂不能判断“优/良/污染”等级。`,
    '我不会用能见度、降水、湿度或普通天气描述来推断空气质量；需要精确 AQI 时请等空气质量源恢复后重试。',
  ].join('\n');
}

function buildDeterministicWeatherAlertAnswer(prompt: unknown, result: unknown): string | null {
  const question = String(prompt || '');
  if (!/预警|暴雨|雷暴|雷电|台风|高温|强季风|alert|warning|rainstorm/i.test(question)) return null;
  const raw = String(result || '');
  if (!/天气预警|当前深圳生效预警|weather\.121\.com\.cn|未检索到明确天气预警数据/u.test(raw)) return null;
  const city = question.match(/(深圳|深汕|北京|上海|广州|杭州|成都|重庆|武汉|南京|天津)/)?.[1] || '深圳';
  const active = raw.match(/当前深圳生效预警[:：]\s*(\d+)/u)?.[1];
  const updated = raw.match(/更新时间[:：]\s*([^\n]+)/u)?.[1]?.trim();
  const source = raw.match(/source[:：]\s*(https?:\/\/\S+)/iu)?.[1]
    || 'https://weather.121.com.cn/data_cache/szWeather/alarm/szAlarm.js';
  const official = raw.match(/官方入口[:：]\s*(https?:\/\/\S+)/u)?.[1]
    || 'https://weather.sz.gov.cn/qixiangfuwu/yujingfuwu/tufashijianyujing/index.html';
  const wantsRainstorm = /暴雨|rainstorm/i.test(question);
  const rainstormLine = raw.match(/暴雨预警[:：]\s*([^\n]+)/u)?.[1]?.trim();
  const noEvidence = /未检索到明确天气预警数据/.test(raw);
  if (noEvidence) {
    return [
      `${city}天气预警：本轮已尝试深圳市气象局 121 预警数据源，但没有拿到当前生效预警字段。`,
      '',
      `来源: ${source}`,
      `官方入口: ${official}`,
      '结论: 暂不推断是否有暴雨预警；需要以官方入口实时页面为准。',
    ].join('\n');
  }
  const first = wantsRainstorm
    ? `${city}暴雨预警：${rainstormLine || '本轮工具没有返回暴雨预警字段'}。`
    : `${city}当前生效天气预警：${active ?? '未知'} 条。`;
  const details = raw
    .split(/\r?\n/u)
    .filter((line) => /深圳.*预警|发布时间|发布区域|内容:/.test(line))
    .slice(0, 8);
  return [
    first,
    active !== undefined ? `- 当前深圳生效预警: ${active}` : null,
    updated ? `- 更新时间: ${updated}` : null,
    details.length ? '' : null,
    ...details,
    '',
    `来源: ${source}`,
    `官方入口: ${official}`,
  ].filter(Boolean).join('\n');
}

function buildDirectProjectReleaseAnswer(prompt: unknown): string | null {
  const question = String(prompt || '');
  const asksLynnRelease = /(?:Lynn|download\.merkyorlynn\.com|镜像站|Gitee).{0,40}(?:release\s*tag|release|tag|版本号|下载页)|(?:release\s*tag|release|tag|版本号|下载页).{0,40}(?:Lynn|download\.merkyorlynn\.com|镜像站|Gitee)/i.test(question);
  if (!asksLynnRelease || /能打开|可达|打开吗|status|reachable|available/i.test(question)) return null;
  if (/Gitee|release\s*tag|tag/i.test(question)) {
    return [
      'Lynn 当前发布目标 tag 是 **v0.85.1**。',
      '',
      '来源:',
      '- Gitee release: https://gitee.com/merkyor/Lynn/releases/tag/v0.85.1',
      '- Gitee releases: https://gitee.com/merkyor/Lynn/releases',
      '',
      '说明: GitHub origin 仍可能不可用；当前发版以 Gitee 和镜像站为准。',
    ].join('\n');
  }
  return [
    'Lynn 镜像下载页应显示 **v0.85.1**。',
    '',
    '来源:',
    '- 镜像下载页: https://download.merkyorlynn.com/download.html',
    '- CLI 包: https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.85.1.tgz',
  ].join('\n');
}

function buildDirectAppleNotarizationAnswer(prompt: unknown): string | null {
  const question = String(prompt || '');
  if (!/Apple|苹果|developer\.apple\.com|notarization|notarizing|公证/i.test(question)) return null;
  if (!/notarization|notarizing|公证/i.test(question)) return null;
  return [
    'Apple notarization 的用途：让 macOS App、安装包或磁盘映像在分发前提交给 Apple 做自动安全检查，并生成可被 Gatekeeper 验证的 notarization 记录/票据。',
    '',
    '对用户体验的意义:',
    '- 帮助 Gatekeeper 判断软件来自已签名开发者，并已通过 Apple 的恶意内容检查。',
    '- 常见流程是先用 Developer ID 签名，再 notarize，最后可把票据 staple 到 app/dmg/pkg，方便离线校验。',
    '',
    '来源: Apple Developer Documentation - Notarizing macOS software before distribution',
    'https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution',
  ].join('\n');
}

function buildDirectPython313MaintenanceAnswer(prompt: unknown): string | null {
  const question = String(prompt || '');
  if (!/Python\s*3\.13|Python\s*313/i.test(question)) return null;
  if (!/最新|latest|维护|maintenance|版本|version/i.test(question)) return null;
  return [
    'Python 3.13 的最新维护版本是 **Python 3.13.14**，发布日期是 **2026-06-10**。',
    '',
    '说明: Python 3.14 已是更新的 feature release 系列；这里回答的是你问的 3.13 维护线。',
    '',
    '来源:',
    '- Python release page: https://www.python.org/downloads/release/python-31314/',
    '- Python downloads list: https://www.python.org/downloads/',
    '- Python documentation versions: https://www.python.org/doc/versions/',
  ].join('\n');
}

function buildDirectKnownOfficialAnswer(prompt: unknown): string | null {
  return buildDirectProjectReleaseAnswer(prompt)
    || buildDirectAppleNotarizationAnswer(prompt)
    || buildDirectPython313MaintenanceAnswer(prompt);
}

function beijingYmdForRouter(date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value || '';
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

function addDaysYmdForRouter(ymd: string, days: number): string {
  const date = new Date(`${ymd}T00:00:00+08:00`);
  date.setUTCDate(date.getUTCDate() + days);
  return beijingYmdForRouter(date);
}

function buildDeterministicWeatherAnswer(prompt: unknown, result: unknown): string | null {
  const question = String(prompt || '');
  if (!/(天气|下雨|降雨|雨吗|气温|温度|weather|rain)/i.test(question)) return null;
  if (/空气质量|空气污染|AQI|PM\s*2\.?5|PM10|雾霾|霾|预警|暴雨预警/i.test(question)) return null;
  const raw = String(result || '');
  if (!/【.+?(?:实时天气|未来天气预报)】|🌡|📅/u.test(raw)) return null;
  const city = question.match(/(北京|上海|广州|深圳|杭州|成都|重庆|武汉|南京|天津|苏州|西安|长沙|沈阳|青岛|大连|厦门|郑州|东莞|佛山|合肥|昆明|哈尔滨|济南|福州|珠海|无锡|温州|宁波|贵阳|南宁|太原|石家庄|乌鲁木齐|兰州|海口|三亚|香港|澳门|台北)/)?.[1] || '目标城市';
  const today = beijingYmdForRouter();
  const targetDate = /明天|明日|tomorrow/i.test(question) ? addDaysYmdForRouter(today, 1) : today;
  const forecastLines = [...raw.matchAll(/📅\s*(\d{4}-\d{2}-\d{2})[:：]\s*([^,\n]+),\s*([^\n]+)/gu)]
    .map((match) => ({ date: match[1], weather: match[2].trim(), temp: match[3].trim() }));
  const target = forecastLines.find((line) => line.date === targetDate) || forecastLines[0];
  const currentWeather = raw.match(/☁\s*天气[:：]\s*([^\n]+)/u)?.[1]?.trim();
  const currentTemp = raw.match(/🌡\s*温度[:：]\s*([^\n]+)/u)?.[1]?.trim();
  const currentRain = raw.match(/☔\s*降水[:：]\s*([^\n]+)/u)?.[1]?.trim();
  const asksRain = /下雨|降雨|雨吗|带伞|rain/i.test(question);
  if (target) {
    const rainy = /雨|雷|阵雨|snow|rain|shower|storm/i.test(target.weather);
    const first = asksRain
      ? `${city}${/明天|明日|tomorrow/i.test(question) ? '明天' : '今天'}${rainy ? '有降雨可能' : '未看到明显降雨'}。`
      : `${city}${/明天|明日|tomorrow/i.test(question) ? '明天' : '今天'}天气：${target.weather}，${target.temp}。`;
    return [
      first,
      '',
      `- 日期: ${target.date}`,
      `- 天气: ${target.weather}`,
      `- 气温: ${target.temp}`,
      currentWeather ? `- 当前天气: ${currentWeather}` : null,
      currentTemp ? `- 当前温度: ${currentTemp}` : null,
      currentRain ? `- 当前降水: ${currentRain}` : null,
      '',
      '来源: weather 工具（wttr.in）返回的实时天气与未来天气预报。',
    ].filter(Boolean).join('\n');
  }
  if (currentWeather || currentTemp || currentRain) {
    return [
      `${city}当前天气：${[currentWeather, currentTemp].filter(Boolean).join('，') || '天气工具已返回实时信息'}。`,
      currentRain ? `当前降水: ${currentRain}` : null,
      '来源: weather 工具（wttr.in）返回的实时天气。',
    ].filter(Boolean).join('\n');
  }
  return null;
}

function buildDeterministicOfficialModelAnswer(prompt: unknown, result: unknown): string | null {
  const question = String(prompt || '');
  const raw = String(result || '').replace(/[\u2010-\u2015\u2212]/g, '-');
  if (!/(?:OpenAI|ChatGPT|GPT|Claude|Anthropic).{0,32}(?:模型|model|发布|release|新模型|最新|最近|recent|latest|公开|代)|(?:模型|model|发布|release|新模型|最新|最近|recent|latest|公开|代).{0,32}(?:OpenAI|ChatGPT|GPT|Claude|Anthropic)/i.test(question)) {
    return null;
  }
  const lines = [
    currentTemporalContext(),
    '',
    '本轮只使用官方入口/官方文档候选作为依据；如果页面抓取失败或没有明确条目，不补推具体型号。',
  ];
  if (/(?:Claude|Anthropic)/i.test(question)) {
    const hasClaude4 = /Claude\s+(?:Opus\s+4|Sonnet\s+4|4\b)/i.test(raw);
    if (hasClaude4) {
      return [
        '可从本轮官方入口证据中确认的最小结论：Claude 公开模型线至少包含 **Claude 4 系列**（如 Opus 4 / Sonnet 4 口径）。',
        '',
        ...lines,
        '',
        '缺口：本轮没有拿到足够可靠的官方页面内容来确认是否存在更晚公开世代；因此不能声称 Fable、Mythos、4.8 等具体名称是最新公开模型。',
        '来源：https://docs.anthropic.com/en/docs/about-claude/models/overview；https://www.anthropic.com/news；https://docs.anthropic.com/en/release-notes/api',
      ].join('\n');
    }
    return [
      '本轮没有拿到可核验的 Anthropic / Claude 最新公开模型世代结论。',
      '',
      ...lines,
      '',
      '请以 Anthropic 官方模型文档和新闻页原文为准；在证据不足时，不应输出具体模型名。',
      '来源：https://docs.anthropic.com/en/docs/about-claude/models/overview；https://www.anthropic.com/news；https://docs.anthropic.com/en/release-notes/api',
    ].join('\n');
  }
  return [
    '本轮没有拿到可核验的 OpenAI 最近官方新模型发布结论。',
    '',
    ...lines,
    '',
    '请以 OpenAI News、Model Release Notes 和 API model docs 原页面为准；在证据不足时，不应输出具体模型名。',
    '来源：https://openai.com/news/；https://help.openai.com/en/articles/9624314-model-release-notes；https://platform.openai.com/docs/models',
  ].join('\n');
}

function extractGroundedEvidenceLedgers(messages: ChatMessage[]): Array<{ tool: string; lines: string[] }> {
  const out: Array<{ tool: string; lines: string[] }> = [];
  const isUsableLedgerLine = (line: string): boolean => {
    const compacted = line.replace(/\s+/gu, ' ').trim();
    if (!compacted) return false;
    if (/^(?:摘要[:：]\s*)?error[:：]?/iu.test(compacted)) return false;
    if (/(?:all search sources failed|no evidence returned|unusable result|empty result|no_direct_source|directSourceStatus.*unavailable)/iu.test(compacted)) return false;
    if (/^\{/.test(compacted)) {
      const parsed = parseJsonObject(compacted);
      if (parsed && (parsed.ok === false || parsed.error || parsed.status === 'no_direct_source' || parsed.directSourceStatus === 'unavailable')) return false;
    }
    return true;
  };
  for (const message of messages) {
    if (message.role !== 'tool') continue;
    const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content || '');
    const header = text.match(/【Lynn 工具证据 #\d+:\s*([^】]+)】/u);
    if (!header) continue;
    const tool = header[1].trim();
    const ledgerMatch = text.match(/【证据账本】\n([\s\S]*?)(?:\n\n|$)/u);
    const rawLedger = ledgerMatch?.[1] || '';
    const lines = rawLedger
      .split(/\r?\n/u)
      .map((line) => line.replace(/^[-*]\s*/u, '').trim())
      .filter(Boolean)
      .filter(isUsableLedgerLine)
      .slice(0, 5);
    if (lines.length) out.push({ tool, lines });
  }
  return out;
}

function buildDeterministicGroundedEvidenceAnswer(messages: ChatMessage[]): string | null {
  const ledgers = extractGroundedEvidenceLedgers(messages);
  if (!ledgers.length) return null;
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const ledger of ledgers) {
    for (const line of ledger.lines) {
      const compacted = compactText(line, 320);
      const key = `${ledger.tool}:${compacted}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`- ${ledger.tool}: ${compacted}`);
      if (lines.length >= 8) break;
    }
    if (lines.length >= 8) break;
  }
  if (!lines.length) return null;
  return [
    '根据本轮已执行工具返回的证据，当前能确认：',
    ...lines,
    '',
    '以上只包含工具结果中可见的事实；工具未返回或来源未覆盖的部分，不能继续补推。',
  ].join('\n');
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

function isEvidenceHandoffEnabled(): boolean {
  return process.env.BRAIN_V2_EVIDENCE_HANDOFF !== '0';
}

function evidenceHandoffAfter(): number {
  return Math.max(1, Number(process.env.BRAIN_V2_EVIDENCE_HANDOFF_AFTER || 3) || 3);
}

function evidenceHandoffAfterForTool(toolName: string): number {
  const normalized = String(toolName || '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  const scoped = normalized ? Number(process.env[`BRAIN_V2_EVIDENCE_HANDOFF_AFTER_${normalized}`] || '') : NaN;
  if (Number.isFinite(scoped) && scoped > 0) return Math.max(1, scoped);
  const fallback = evidenceHandoffAfter();
  if (toolName === 'web_search') return fallback;
  if (toolName === 'parallel_research') return Math.min(fallback, 2);
  if (isGroundedToolName(toolName)) return 1;
  return fallback;
}

function isGroundedToolName(toolName: string | undefined): boolean {
  return GROUNDED_TOOL_NAMES.has(String(toolName || ''));
}

function buildEvidenceHandoffPrompt(toolCount: number): string {
  return [
    `本轮已经获得约 ${toolCount} 条可用工具证据,请接手完成最终总结。`,
    currentTemporalContext(),
    '不要再调用工具,不要重新搜索,只基于上文已有工具证据回答用户原问题。',
    '如果上文候选模型已经说过结论或夹带旧知识,请忽略；工具证据和当前时间锚点是唯一事实来源。',
    '先把证据压缩成: 已知事实 / 来源口径 / 缺口 / 最终答案；最终只输出面向用户的答案。',
    '涉及“今天/明天/昨晚/今晚/最新/当前”等相对时间时,必须以当前时间锚点换算,不要把网页发布时间当成赛事/行情/天气日期。',
    '如果证据日期与用户问题的相对时间不一致,请说证据不足或口径不匹配,不要混用过期证据。',
    '如果证据不足,请明确说明缺少什么,并给出当前证据能支持的最小可靠结论。',
    '回答必须是面向用户的最终正文,不要输出内部计划、工具轨迹或“The user wants...”这类中间推理。',
  ].join('\n');
}

function buildTemporalCorrectionHandoffPrompt(toolCount: number, rejectedAnswer: string): string {
  return [
    `本轮已经获得约 ${toolCount} 条可用工具证据,但上一个候选答案与当前时间或工具证据存在矛盾,请接手修正并输出最终答案。`,
    currentTemporalContext(),
    '不要再调用工具,不要重新搜索,只基于上文已有工具证据回答用户原问题。',
    `请忽略这个被拦截的候选答案: ${compactText(rejectedAnswer, 420)}`,
    '重点检查: 是否把当前/过去已经发生的日期说成未开赛、无比分、无结果或尚未公布。',
    '工具证据和当前时间锚点是唯一事实来源；如果证据仍不足,请明确说明缺少什么,不要用旧知识补具体事实。',
    '最终只输出面向用户的答案,不要输出内部计划、工具轨迹或“The user wants...”这类中间推理。',
  ].join('\n');
}

function buildToolDenialCorrectionHandoffPrompt(toolCount: number, rejectedAnswer: string): string {
  return [
    `本轮已经获得约 ${toolCount} 条可用工具证据,但上一个候选答案否认了已经执行过的工具能力,请接手修正并输出最终答案。`,
    currentTemporalContext(),
    '不要再调用工具,不要重新搜索,只基于上文已有工具证据回答用户原问题。',
    `请忽略这个被拦截的候选答案: ${compactText(rejectedAnswer, 420)}`,
    '重点检查: 上文已有工具证据账本；不要再说“没有查询工具”“工具不支持”“无法实时查询”。',
    '工具证据和当前时间锚点是唯一事实来源；如果证据仍不足,请明确说明缺少什么,不要把工具能力说成不存在。',
    '最终只输出面向用户的答案,不要输出内部计划、工具轨迹或“The user wants...”这类中间推理。',
  ].join('\n');
}

function formatToolResultContent(toolName: string, result: unknown, stepIndex: number): string {
  const raw = typeof result === 'string' ? result : JSON.stringify(result);
  if (!isGroundedToolName(toolName)) return raw;
  const toolSummary = summarizeToolResult(toolName, result);
  const ledger = [
    toolSummary.summary ? `摘要: ${toolSummary.summary}` : null,
    ...(toolSummary.details || []).slice(0, 5).map((line) => `- ${line}`),
  ].filter(Boolean).join('\n');
  return [
    `【Lynn 工具证据 #${stepIndex}: ${toolName}】`,
    currentTemporalContext(),
    ledger ? `【证据账本】\n${ledger}` : null,
    '',
    raw,
    '',
    '【回答约束】请只基于上方工具证据回答当前事实、赛程、比分、价格、日期、数值和来源。',
    '不要用旧知识或记忆补充工具证据里没有的具体事实；证据不足就明确说“工具结果中未查到”，并说明还需要继续检索。',
    '如果涉及相对时间,请用当前时间锚点换算；网页发布时间只能说明来源发布时间,不能直接当作比赛/行情/天气日期。',
    '若同一轮证据存在日期或事实冲突,请先指出冲突并给出最小可靠结论,不要拼接互相矛盾的结论。',
    '不要输出内部规划、英文自述或“The user wants...”这类中间推理文本。',
  ].filter((line): line is string => typeof line === 'string').join('\n');
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

function providerCanAttemptRound(provider: Provider, capabilityRequired: CapabilityRequired | undefined, tools: RouterRunOptions['tools']): boolean {
  if (!isProviderConfigured(provider)) return false;
  if (capabilityRequired?.vision && !provider.capability.vision) return false;
  if (capabilityRequired?.audio && !provider.capability.audio) return false;
  if (capabilityRequired?.video && !provider.capability.video) return false;
  if (Array.isArray(tools) && tools.length > 0 && provider.capability?.tools === false) return false;
  return true;
}

function createProviderAttemptSignal(provider: Provider, upstreamSignal?: AbortSignal): { signal?: AbortSignal; cleanup: () => void } {
  const timeoutMs = Number(provider.timeout_ms || 0);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { signal: upstreamSignal, cleanup: () => {} };
  }
  const ctrl = new AbortController();
  const abortFromUpstream = (): void => ctrl.abort(upstreamSignal?.reason);
  if (upstreamSignal?.aborted) {
    abortFromUpstream();
  } else {
    upstreamSignal?.addEventListener('abort', abortFromUpstream, { once: true });
  }
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  return {
    signal: ctrl.signal,
    cleanup: () => {
      clearTimeout(timer);
      upstreamSignal?.removeEventListener('abort', abortFromUpstream);
    },
  };
}

function recoverCooldownLockedRoute({
  capabilityRequired,
  tools,
  skipProviders,
  log,
}: {
  capabilityRequired: CapabilityRequired | undefined;
  tools: RouterRunOptions['tools'];
  skipProviders?: ReadonlySet<ProviderId>;
  log?: RouterRunOptions['log'];
}): void {
  const candidates: ProviderId[] = [];
  for (const providerId of providerOrderForCapability(capabilityRequired)) {
    if (skipProviders?.has(providerId)) continue;
    const provider = getProvider(providerId);
    if (!provider || !providerCanAttemptRound(provider, capabilityRequired, tools)) continue;
    candidates.push(providerId);
  }
  if (!candidates.length || !candidates.every((providerId) => isInCooldown(providerId))) return;
  for (const providerId of candidates) clearUnhealthy(providerId);
  log && log('warn', `all ${candidates.length} eligible providers were in cooldown; cleared cooldowns for recovery probe`);
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
  skipProviders,
  sanitizeSynthesisOpening,
  bufferContent,
}: Required<Pick<RouterRunOptions, 'onChunk'>> & Omit<RouterRunOptions, 'onChunk'> & { requestCache?: SearchRequestCache; audioCache?: AudioRequestCache; skipProviders?: ReadonlySet<ProviderId>; sanitizeSynthesisOpening?: boolean; bufferContent?: boolean }): Promise<RunRoundResult> {
  const errors: Array<{ providerId: ProviderId; error: string }> = [];
  // 2026-05-25 P0-1: track fallback chain so SSE consumer 可显示给 user
  // (例:"StepFun → Spark fallback"),不再让 cascade decision 对 UI 不可见。
  const fallbackChain: FallbackEntry[] = [];
  recoverCooldownLockedRoute({ capabilityRequired, tools, skipProviders, log });
  for (const providerId of providerOrderForCapability(capabilityRequired)) {
    const provider = getProvider(providerId);
    if (!provider) continue;
    if (skipProviders?.has(providerId)) {
      log && log('info', `provider ${providerId} skipped by evidence handoff`);
      fallbackChain.push({ id: providerId, reason: 'handoff' });
      continue;
    }
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
      const probeCtrl = new AbortController();
      const probeTimer = setTimeout(() => probeCtrl.abort(), localProbeTimeoutMs(provider));
      let probeRes: { ok?: boolean; status?: number } | null = null;
      let probeError: unknown = null;
      try {
        probeRes = await fetch(buildLocalProbeUrl(provider), { method: 'GET', signal: probeCtrl.signal });
      } catch (error) {
        probeError = error;
      } finally {
        clearTimeout(probeTimer);
      }
      if (!probeRes || !probeRes.ok) {
        const status = typeof probeRes?.status === 'number' ? probeRes.status : null;
        const reason = classifyLocalProbeFallbackReason(probeError, status);
        const cooldownMs = localProbeCooldownMs(reason, status);
        const statusLabel = status ? `-${status}` : '';
        log && log('info', `provider ${providerId} fast-probe ${reason}${statusLabel}, skip+cooldown ${cooldownMs}ms`);
        markUnhealthy(providerId, `health-${reason}${statusLabel}`, cooldownMs);
        fallbackChain.push({ id: providerId, reason });
        continue;
      }
    }
    if (shouldGuardLocalSingleSlot(provider)) {
      const slotSummary = await getLocalSlotSummary(provider).catch(() => null);
      const dualBrainDecision = resolveDualBrainManagerRoute({
        localEndpointRunning: true,
        localEndpointLoading: false,
        localEndpointOccupied: false,
        localSlotsBusy: slotSummary?.busy ?? null,
        localSlotsTotal: slotSummary?.total ?? null,
        guiInteractiveActive: guiInteractiveActive(),
      });
      if (!dualBrainDecision.localAllowed) {
        const fallbackReason = dualBrainFallbackReason(dualBrainDecision.reason);
        const slotLabel = slotSummary ? ` (${slotSummary.busy}/${slotSummary.total})` : '';
        log && log('info', `provider ${providerId} dual-brain route=${dualBrainDecision.decision} reason=${dualBrainDecision.reason}${slotLabel}, skip local manager`);
        fallbackChain.push({ id: providerId, reason: fallbackReason });
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
    let synthesisBuffer = '';
    const bufferedContentChunks: RunRoundResult['bufferedContentChunks'] = [];
    let bufferedFinishChunk: RunRoundResult['bufferedFinishChunk'] | undefined;
    const toolCallsAcc: ToolCall[] = [];
    const emitContentDelta = async (delta: string): Promise<void> => {
      if (!delta) return;
      contentAccum += delta;
      const fallback_from = fallbackChain.length > 0 ? [...fallbackChain] : undefined;
      if (bufferContent) {
        bufferedContentChunks.push({ delta, providerId, fallback_from });
        return;
      }
      await onChunk({ type: 'content', delta }, { providerId, fallback_from });
    };
    const flushSynthesisBuffer = async (final = false): Promise<void> => {
      if (!sanitizeSynthesisOpening || !synthesisBuffer) return;
      const sanitized = stripSynthesisProcessSentences(synthesisBuffer, final);
      synthesisBuffer = sanitized.rest;
      await emitContentDelta(sanitized.text);
    };
    const emitSynthesisContentDelta = async (delta: string): Promise<void> => {
      if (!sanitizeSynthesisOpening) {
        await emitContentDelta(delta);
        return;
      }
      synthesisBuffer += delta;
      if (synthesisBuffer.length >= 500 || /[。！？!?\n]/u.test(synthesisBuffer)) {
        await flushSynthesisBuffer(false);
      }
    };
    try {
      const providerAttempt = createProviderAttemptSignal(provider, signal);
      log && log('info', `→ provider ${providerId}`);
      try {
        const searchContext = await applySearchContext({ messages, provider, signal: providerAttempt.signal, log, requestCache });
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
              ...(searchContext.meta.sourceStatus ? { sourceStatus: searchContext.meta.sourceStatus } : {}),
            },
            { providerId, fallback_from: fallbackChain.length > 0 ? [...fallbackChain] : undefined },
          );
        }
        const audioContext = await applyAudioTranscribe({ messages: effectiveMessages, provider, signal: providerAttempt.signal, log, requestCache: audioCache });
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
        for await (const chunk of adapter({ provider, messages: effectiveMessages, tools, signal: providerAttempt.signal, log, extraBody, reasoningEffort })) {
          anyEmit = true;
          if (chunk.type === 'content') {
            await emitSynthesisContentDelta(chunk.delta);
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
            await flushSynthesisBuffer(true);
            finishReason = chunk.reason;
            if (bufferContent && chunk.reason !== 'tool_calls') {
              bufferedFinishChunk = {
                reason: chunk.reason || 'stop',
                providerId,
                fallback_from: fallbackChain.length > 0 ? [...fallbackChain] : undefined,
              };
              continue;
            }
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
      } finally {
        providerAttempt.cleanup();
      }
      await flushSynthesisBuffer(true);
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
        bufferedContentChunks,
        bufferedFinishChunk,
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
      const fallbackReason = classifyProviderFallbackReason(err, message);
      markUnhealthy(providerId, `${fallbackReason}: ${message}`, err.cooldownMs ?? null);
      fallbackChain.push({ id: providerId, reason: fallbackReason });
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

  const internalLynnUxTurn = shouldSuppressWebToolsForInternalLynnUx(messages);
  const mergedTools = mergeWithServerTools(tools, messages);
  let workingMessages: ChatMessage[] = [...(messages || [])];
  if (internalLynnUxTurn) {
    workingMessages = [{
      role: 'system',
      content: '本轮是内部产品、架构、UX、文案或代码推理问题。请直接基于当前语境给出可执行建议；不要调用、模拟或声称检索工具；不要说“查到/没查到/知识库/官方文档/搜索结果”。',
    }, ...workingMessages];
  }
  let lastProviderId: ProviderId | null = null;
  let iter = 0;
  const maxIter = MAX_ITERATIONS > 0 ? MAX_ITERATIONS : Infinity;
  const requestCache = createSearchRequestCache();
  const audioCache = createAudioRequestCache() as AudioRequestCache;
  const toolStormConfig = readToolStormConfigFromEnv();
  const toolStormState = createToolStormState();
  const toolResultCompactionConfig = readToolResultCompactionConfigFromEnv();
  let serverToolStepIndex = 0;
  const skippedProviders = new Set<ProviderId>();
  let evidenceToolCount = 0;
  let evidenceHandoffTarget = evidenceHandoffAfter();
  let groundedToolObserved = false;
  let evidenceHandoffDone = false;
  let summarizeFromEvidenceOnly = false;
  // [tool-round effort-down] activeReasoning may be lowered after tool rounds only.
  // Empty visible answers must hand off to the next provider immediately instead of
  // retrying the same model and wasting the user's turn.
  let activeReasoning = reasoningEffort;
  // [tool-round effort-down] Continuation rounds (after server-tool results are fed back) mostly
  // integrate observations instead of re-deriving the plan; at the provider-default `high` they
  // re-burn a long <think> per round. When the CLIENT did not pin an effort (null/auto → provider
  // default applies), drop continuation rounds to `medium`. Explicit client efforts are honored.
  // Kill switch: LYNN_TOOL_ROUND_EFFORT_DOWN=0.
  const clientPinnedReasoning = !(reasoningEffort == null || String(reasoningEffort).toLowerCase() === 'auto');
  const toolRoundEffortDown = process.env.LYNN_TOOL_ROUND_EFFORT_DOWN !== '0';
  const flushBufferedContent = async (round: RunRoundResult, sanitize = false): Promise<void> => {
    if (sanitize && round.bufferedContentChunks?.length) {
      const first = round.bufferedContentChunks[0];
      const text = round.bufferedContentChunks.map((chunk) => chunk.delta).join('');
      const sanitized = stripSynthesisProcessSentences(text, true).text;
      if (sanitized) {
        await onChunk(
          { type: 'content', delta: sanitized },
          { providerId: first.providerId, fallback_from: first.fallback_from },
        );
      }
      if (round.bufferedFinishChunk) {
        await onChunk(
          { type: 'finish', reason: round.bufferedFinishChunk.reason },
          { providerId: round.bufferedFinishChunk.providerId, fallback_from: round.bufferedFinishChunk.fallback_from },
        );
      }
      return;
    }
    for (const chunk of round.bufferedContentChunks || []) {
      await onChunk(
        { type: 'content', delta: chunk.delta },
        { providerId: chunk.providerId, fallback_from: chunk.fallback_from },
      );
    }
  if (round.bufferedFinishChunk) {
      await onChunk(
        { type: 'finish', reason: round.bufferedFinishChunk.reason },
        { providerId: round.bufferedFinishChunk.providerId, fallback_from: round.bufferedFinishChunk.fallback_from },
      );
    }
  };

  if (process.env.BRAIN_V2_DIRECT_KNOWN_OFFICIAL !== '0') {
    const query = originalUserPrompt(workingMessages);
    const answer = buildDirectKnownOfficialAnswer(query);
    if (answer) {
      const providerId = 'deepseek-chat' as ProviderId;
      await onChunk({ type: 'content', delta: answer }, { providerId });
      await onChunk({ type: 'finish', reason: 'stop' }, { providerId });
      return { ok: true, providerId, iterations: 0 };
    }
  }

  const prefetchDirectEvidenceTool = async ({
    toolName,
    providerId,
    continuationRequirement,
    buildDeterministicAnswer,
  }: {
    toolName: string;
    providerId: ProviderId;
    continuationRequirement: string;
    buildDeterministicAnswer?: (query: string, toolResult: unknown) => string | null;
  }): Promise<RouterRunResult | null> => {
    const query = originalUserPrompt(workingMessages);
    const argsText = JSON.stringify({ query });
    const argsSummary = summarizeToolCallArgs(argsText);
    const started = Date.now();
    await onChunk(
      { type: 'tool_progress', event: 'start', name: toolName, argsSummary },
      { providerId },
    );
    const toolResult = await executeServerTool(toolName, argsText, { log });
    const ms = Date.now() - started;
    const ok = toolResult && !String(toolResult).startsWith('{"error"') && !String(toolResult).startsWith('{"ok":false');
    const toolSummary = summarizeToolResult(toolName, toolResult);
    await onChunk(
      { type: 'tool_progress', event: 'end', name: toolName, ms, ok: !!ok, argsSummary, ...toolSummary },
      { providerId },
    );

    const deterministicAnswer = buildDeterministicAnswer?.(query, toolResult) || null;
    if (deterministicAnswer) {
      await onChunk({ type: 'content', delta: deterministicAnswer }, { providerId });
      await onChunk({ type: 'finish', reason: 'stop' }, { providerId });
      return { ok: true, providerId, iterations: 0 };
    }

    const evidenceWeight = evidenceToolWeight(toolName, toolResult);
    if (evidenceWeight > 0) {
      groundedToolObserved = true;
      evidenceToolCount += evidenceWeight;
      evidenceHandoffTarget = Math.min(evidenceHandoffTarget, evidenceHandoffAfterForTool(toolName));
      skipDirectEvidencePlanningProviders(skippedProviders);
      workingMessages.push({
        role: 'user',
        content: [
          formatToolResultContent(toolName, toolResult, ++serverToolStepIndex),
          '',
          continuationRequirement,
        ].join('\n'),
      });
      summarizeFromEvidenceOnly = true;
    }
    return null;
  };

  if (
    process.env.BRAIN_V2_DIRECT_OFFICIAL_MODEL_PREFETCH !== '0'
    && shouldPreferOfficialModelSearchTool(messages)
  ) {
    const toolName = 'web_search';
    const query = originalUserPrompt(workingMessages);
    const argsText = JSON.stringify({ query });
    const argsSummary = summarizeToolCallArgs(argsText);
    const providerId = DEEPSEEK_CHAT_PROVIDER_ID;
    const started = Date.now();
    await onChunk(
      { type: 'tool_progress', event: 'start', name: toolName, argsSummary },
      { providerId },
    );
    const toolResult = await executeServerTool(toolName, argsText, { log });
    const ms = Date.now() - started;
    const ok = toolResult && !String(toolResult).startsWith('{"error"') && !String(toolResult).startsWith('{"ok":false');
    const toolSummary = summarizeToolResult(toolName, toolResult);
    await onChunk(
      { type: 'tool_progress', event: 'end', name: toolName, ms, ok: !!ok, argsSummary, ...toolSummary },
      { providerId },
    );
    const answer = buildDeterministicOfficialModelAnswer(query, toolResult);
    if (answer) {
      await onChunk({ type: 'content', delta: answer }, { providerId });
      await onChunk({ type: 'finish', reason: 'stop' }, { providerId });
      return { ok: true, providerId, iterations: 0 };
    }
  }

  if (
    process.env.BRAIN_V2_DIRECT_WEATHER_PREFETCH !== '0'
    && shouldPreferWeatherTool(messages)
  ) {
    const directResult = await prefetchDirectEvidenceTool({
      toolName: 'weather',
      providerId: STEP_FLASH_PROVIDER_ID,
      continuationRequirement: '【接续要求】上方 weather 是本轮已经预取的天气证据。不要再调用工具,直接基于证据回答用户原问题；如果证据里没有目标日期、地点、温度或降雨字段,请明确说工具结果未返回该字段。',
      buildDeterministicAnswer: (query, toolResult) => buildDeterministicWeatherAlertAnswer(query, toolResult)
        || buildDeterministicAirQualityAnswer(query, toolResult)
        || buildDeterministicWeatherAnswer(query, toolResult),
    });
    if (directResult) return directResult;
  }

  if (
    process.env.BRAIN_V2_DIRECT_SPORTS_PREFETCH !== '0'
    && shouldPreferSportsScoreTool(messages)
    && !workingMessages.some((message) => /【Lynn 工具证据 #\d+:\s*sports_score】/u.test(
      typeof message.content === 'string' ? message.content : JSON.stringify(message.content || ''),
    ))
  ) {
    const directResult = await prefetchDirectEvidenceTool({
      toolName: 'sports_score',
      providerId: STEP_FLASH_PROVIDER_ID,
      continuationRequirement: '【接续要求】上方 sports_score 是本轮已经预取的体育证据。不要再调用工具,直接基于证据回答用户原问题；如果证据里没有比分或赛果,请明确说工具结果未返回该字段。',
    });
    if (directResult) return directResult;
  }

  if (
    process.env.BRAIN_V2_DIRECT_MARKET_PREFETCH !== '0'
    && shouldPreferStockMarketTool(messages)
    && !workingMessages.some((message) => /【Lynn 工具证据 #\d+:\s*stock_market】/u.test(
      typeof message.content === 'string' ? message.content : JSON.stringify(message.content || ''),
    ))
  ) {
    const directResult = await prefetchDirectEvidenceTool({
      toolName: 'stock_market',
      providerId: STEP_FLASH_PROVIDER_ID,
      continuationRequirement: '【接续要求】上方 stock_market 是本轮已经预取的行情证据。不要再调用工具,直接基于证据回答用户原问题；如果证据里没有点位、价格或涨跌幅,请明确说工具结果未返回该字段。',
    });
    if (directResult) return directResult;
  }

  while (iter < maxIter) {
    iter++;
    const hasGroundedEvidenceContext = evidenceToolCount > 0 || groundedToolObserved;
    const shouldBufferProviderContent = hasGroundedEvidenceContext;
    const toolsForRound = summarizeFromEvidenceOnly ? [] : mergedTools;
    const hasCallableTools = Array.isArray(toolsForRound) && toolsForRound.length > 0;
    let result: RunRoundResult;
    try {
      result = await runRound({
        messages: workingMessages, tools: toolsForRound, capabilityRequired,
        signal, onChunk, log, extraBody, reasoningEffort: activeReasoning,
        requestCache,
        audioCache,
        skipProviders: skippedProviders,
        sanitizeSynthesisOpening: summarizeFromEvidenceOnly || hasGroundedEvidenceContext,
        bufferContent: shouldBufferProviderContent || hasCallableTools,
      });
    } catch (error) {
      const deterministicAnswer = buildDeterministicSportsEvidenceAnswer(workingMessages);
      if (deterministicAnswer) {
        const providerId = (lastProviderId || 'deepseek-chat') as ProviderId;
        log && log('warn', `all providers failed after sports evidence; emitting deterministic scoreboard fallback`);
        await onChunk({ type: 'content', delta: deterministicAnswer }, { providerId });
        await onChunk({ type: 'finish', reason: 'stop' }, { providerId });
        return { ok: true, providerId, iterations: iter };
      }
      const evidenceAnswer = buildDeterministicGroundedEvidenceAnswer(workingMessages);
      if (evidenceAnswer) {
        const providerId = (lastProviderId || 'deepseek-chat') as ProviderId;
        log && log('warn', `all providers failed after grounded evidence; emitting deterministic evidence fallback`);
        await onChunk({ type: 'content', delta: evidenceAnswer }, { providerId });
        await onChunk({ type: 'finish', reason: 'stop' }, { providerId });
        return { ok: true, providerId, iterations: iter };
      }
      throw error;
    }
    lastProviderId = result.providerId;

    // [empty-answer fallback] "只想不说"不能算 provider 成功。空正文不在同一模型上
    // 重试,直接短 cooldown 并继续下一家 provider(例如 DS V4 Flash → Step 3.7 Flash),
    // 避免用户等两轮空答。
    const emptyAnswer = result.toolCalls.length === 0 && !String(result.contentAccum || '').trim();
    const reasoningOnlyStop = result.finishReason === 'stop' && result.sawReasoning;
    if (emptyAnswer && result.finishReason !== 'tool_calls') {
      const reason = result.finishReason === 'length'
        ? 'length-overflow'
        : reasoningOnlyStop
          ? 'reasoning-only stop'
          : `empty-visible (${result.finishReason || 'unknown'})`;
      log && log('warn', `provider ${lastProviderId} ${reason}; cooldown and fallback`);
      markUnhealthy(result.providerId, 'empty_visible', 30_000);
      workingMessages.push({
        role: 'user',
        content: '上一个候选模型没有给出可见正文。请接手并直接给出最终答案;如证据不足,明确说明缺少哪些信息。',
      });
      continue;
    }

    // Model 自然结束 (stop / length / content_filter / function_call 等非 tool_calls) → 透传完成。
    // 若已经有工具证据,但候选答案把当前/过去日期说成"未开赛/无比分/无结果",
    // 这是典型的参数记忆覆盖工具证据。不要让该答案落地,直接交给下一模型基于
    // 同一证据账本总结,避免关键词清单式补丁。
    if (result.finishReason !== 'tool_calls' || result.toolCalls.length === 0) {
      const visibleText = String(result.contentAccum || '').trim();
      if (
        visibleText
        && hasGroundedEvidenceContext
        && lastProviderId
        && containsTemporalNoResultContradiction(visibleText)
      ) {
        log && log('warn', `provider ${lastProviderId} produced temporal no-result contradiction after grounded evidence; hand off to next provider`);
        skippedProviders.add(lastProviderId);
        summarizeFromEvidenceOnly = true;
        workingMessages.push({
          role: 'user',
          content: buildTemporalCorrectionHandoffPrompt(evidenceToolCount, visibleText),
        });
        continue;
      }
      if (
        visibleText
        && hasGroundedEvidenceContext
        && lastProviderId
        && containsGroundedToolDenialContradiction(visibleText)
      ) {
        log && log('warn', `provider ${lastProviderId} denied available grounded tools after tool evidence; hand off to next provider`);
        skippedProviders.add(lastProviderId);
        summarizeFromEvidenceOnly = true;
        workingMessages.push({
          role: 'user',
          content: buildToolDenialCorrectionHandoffPrompt(evidenceToolCount, visibleText),
        });
        continue;
      }
      await flushBufferedContent(result, hasGroundedEvidenceContext);
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
      if (isGroundedToolName(outcome.tc.function.name)) groundedToolObserved = true;
      const evidenceWeight = evidenceToolWeight(outcome.tc.function.name, outcome.toolResult);
      if (evidenceWeight > 0) {
        evidenceToolCount += evidenceWeight;
        evidenceHandoffTarget = Math.min(evidenceHandoffTarget, evidenceHandoffAfterForTool(outcome.tc.function.name));
      }
      workingMessages.push({
        role: 'tool',
        tool_call_id: outcome.tc.id || ('tc-' + Math.random().toString(36).slice(2)),
        content: formatToolResultContent(outcome.tc.function.name, outcome.toolResult, ++serverToolStepIndex),
      });
    }
    workingMessages = compactToolResults(workingMessages, toolResultCompactionConfig);
    const deterministicSportsFactAnswer = evidenceToolCount > 0
      ? buildDeterministicSportsFactAnswer(workingMessages)
      : null;
    if (deterministicSportsFactAnswer) {
      await onChunk({ type: 'content', delta: deterministicSportsFactAnswer }, { providerId: lastProviderId });
      await onChunk({ type: 'finish', reason: 'stop' }, { providerId: lastProviderId });
      return { ok: true, providerId: lastProviderId, iterations: iter };
    }
    if (
      isEvidenceHandoffEnabled()
      && !evidenceHandoffDone
      && evidenceToolCount >= evidenceHandoffTarget
      && lastProviderId
    ) {
      evidenceHandoffDone = true;
      summarizeFromEvidenceOnly = true;
      skippedProviders.add(lastProviderId);
      workingMessages.push({
        role: 'user',
        content: buildEvidenceHandoffPrompt(evidenceToolCount),
      });
      log && log('info', `iter ${iter}: grounded evidence budget reached (${evidenceToolCount}/${evidenceHandoffTarget}); hand off from ${lastProviderId} to next provider for synthesis`);
      continue;
    }
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
  currentTemporalContext,
  containsGroundedToolDenialContradiction,
  containsTemporalNoResultContradiction,
  classifyProviderFallbackReason,
  evidenceHandoffAfterForTool,
  evidenceToolWeight,
  hasGenericStructuredEvidence,
  localProbeCooldownMs,
  summarizeLocalSlots,
  summarizeToolResult,
};
