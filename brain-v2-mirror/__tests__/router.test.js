// Brain v2 · Router tests (vi.mock provider-registry + wire-adapter for hermetic DI)
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// hoisted shared mock state
const mockState = vi.hoisted(() => ({
  cooldown: new Set(),
  unhealthy: [],
  providers: {},
  order: null,
  adapterFn: null,
  adapterCalls: [],
}));

vi.mock('../provider-registry.js', () => ({
  universalOrder: ['p-step', 'p-spark', 'p-cloud', 'p-vision'],
  providerOrderForCapability: (capabilityRequired) => mockState.order || (
    capabilityRequired?.vision || capabilityRequired?.audio || capabilityRequired?.video
      ? ['p-vision', 'p-step', 'p-spark', 'p-cloud']
      : ['p-step', 'p-spark', 'p-cloud', 'p-vision']
  ),
  getProvider: (id) => mockState.providers[id] || null,
  isInCooldown: (id) => mockState.cooldown.has(id),
  markUnhealthy: (id, reason, cooldownMs) => {
    mockState.cooldown.add(id);
    mockState.unhealthy.push({ id, reason, cooldownMs });
  },
  clearUnhealthy: (id) => mockState.cooldown.delete(id),
  PROVIDERS: mockState.providers,
}));

vi.mock('../wire-adapter/index.js', () => ({
  getAdapter: () => mockState.adapterFn,
  ADAPTERS: {},
}));

import { run, detectCapability, __testing__ } from '../router.js';
import { __testing__ as webSearchTesting } from '../tool-exec/web_search.js';
import { __testing__ as searchContextTesting } from '../search-context.js';

function makeProvider(id, capability = {}) {
  return {
    id, wire: 'mock', endpoint: 'http://mock', apiKey: 'k', model: 'm',
    capability: { vision: false, audio: false, video: false, tools: true, thinking: true, ...capability },
  };
}

async function* yieldChunks(...chunks) { for (const c of chunks) yield c; }

beforeEach(() => {
  mockState.cooldown.clear();
  mockState.providers = {
    'p-step':   makeProvider('p-step'),
    'p-spark':  makeProvider('p-spark'),
    'p-cloud':  makeProvider('p-cloud'),
    'p-vision': makeProvider('p-vision', { vision: true }),
  };
  mockState.order = null;
  mockState.adapterCalls = [];
  mockState.unhealthy = [];
  mockState.adapterFn = null;
  process.env.BRAIN_V2_DIRECT_SPORTS_PREFETCH = '0';
  process.env.BRAIN_V2_DIRECT_MARKET_PREFETCH = '0';
  process.env.BRAIN_V2_DIRECT_WEATHER_PREFETCH = '0';
  process.env.BRAIN_V2_DIRECT_OFFICIAL_MODEL_PREFETCH = '0';
  webSearchTesting.cache.clear();
  webSearchTesting.structuredCache.clear();
  searchContextTesting.clearCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.BRAIN_V2_PRE_SEARCH;
  delete process.env.MIMO_SEARCH_KEY;
  delete process.env.BRAIN_V2_STORM_DETECT;
  delete process.env.BRAIN_V2_STORM_THRESHOLD;
  delete process.env.BRAIN_V2_STORM_MAX;
  delete process.env.BRAIN_V2_TOOL_RESULT_CAP;
  delete process.env.BRAIN_V2_TOOL_RESULT_KEEP_LATEST;
  delete process.env.ZHIPU_KEY;
  delete process.env.MIMO_SEARCH_KEY;
  delete process.env.LYNN_TOOL_ROUND_EFFORT_DOWN;
  delete process.env.BRAIN_V2_DIRECT_OFFICIAL_MODEL_PREFETCH;
  delete process.env.BRAIN_V2_TOOL_PARALLEL;
  delete process.env.BRAIN_V2_EVIDENCE_HANDOFF;
  delete process.env.BRAIN_V2_EVIDENCE_HANDOFF_AFTER;
  delete process.env.BRAIN_V2_GUI_INTERACTIVE_ACTIVE;
  delete process.env.LYNN_GUI_INTERACTIVE_ACTIVE;
  delete process.env.BRAIN_V2_DIRECT_SPORTS_PREFETCH;
  delete process.env.BRAIN_V2_DIRECT_MARKET_PREFETCH;
  delete process.env.BRAIN_V2_DIRECT_WEATHER_PREFETCH;
  delete process.env.BRAIN_V2_LOCAL_PROBE_TIMEOUT_COOLDOWN_MS;
  delete process.env.BRAIN_V2_LOCAL_PROBE_THROW_COOLDOWN_MS;
  delete process.env.BRAIN_V2_LOCAL_PROBE_4XX_COOLDOWN_MS;
  delete process.env.BRAIN_V2_LOCAL_PROBE_5XX_COOLDOWN_MS;
  delete process.env.BRAIN_V2_LOCAL_PROBE_FAIL_COOLDOWN_MS;
  delete process.env.BRAIN_V2_LAST_CHANCE_RECOVERY;
  delete process.env.BRAIN_V2_LAST_CHANCE_TIMEOUT_MS;
});

function makeTwoToolThenContentAdapter(capturedRounds) {
  let adapterRuns = 0;
  return async function* ({ messages }) {
    adapterRuns += 1;
    capturedRounds.push(messages);
    if (adapterRuns === 1) {
      yield {
        type: 'tool_call_delta',
        delta: [
          { index: 0, id: 'tc-a', type: 'function', function: { name: 'web_search', arguments: '{"query":"alpha"}' } },
          { index: 1, id: 'tc-b', type: 'function', function: { name: 'web_search', arguments: '{"query":"beta"}' } },
        ],
      };
      yield { type: 'finish', reason: 'tool_calls' };
      return;
    }
    yield { type: 'content', delta: 'done' };
    yield { type: 'finish', reason: 'stop' };
  };
}

function stubSearchFetchOk() {
  process.env.ZHIPU_KEY = 'test-zhipu';
  process.env.MIMO_SEARCH_KEY = 'test-mimo';
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ search_result: [{ title: 'OpenAI search summary', link: 'https://search.example', content: 'OpenAI search summary' }] }),
    text: async () => '',
  }));
}

function beijingTonightMidnightEvent() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const utcDate = `${map.year}-${map.month}-${map.day}`;
  const bjtDate = new Date(`${utcDate}T16:00:00.000Z`);
  const bjtParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(bjtDate);
  const bjtMap = Object.fromEntries(bjtParts.map((part) => [part.type, part.value]));
  return {
    iso: `${utcDate}T16:00:00Z`,
    label: `${bjtMap.year}/${bjtMap.month}/${bjtMap.day} 00:00`,
  };
}

function makeToolThenContentAdapter(reasoningSeen) {
  let adapterRuns = 0;
  return async function* ({ reasoningEffort }) {
    adapterRuns += 1;
    reasoningSeen.push(reasoningEffort ?? null);
    if (adapterRuns === 1) {
      yield {
        type: 'tool_call_delta',
        delta: [{
          index: 0,
          id: 'tc-effort-down',
          type: 'function',
          function: { name: 'web_search', arguments: '{"query":"q"}' },
        }],
      };
      yield { type: 'finish', reason: 'tool_calls' };
      return;
    }
    yield { type: 'content', delta: 'done' };
    yield { type: 'finish', reason: 'stop' };
  };
}

describe('Router', () => {
  it('falls through to the next provider when a turn overflows (finish=length, empty answer)', async () => {
    const reasoningSeen = [];
    mockState.adapterFn = async function* ({ provider, reasoningEffort }) {
      mockState.adapterCalls.push(provider.id);
      reasoningSeen.push(`${provider.id}:${reasoningEffort ?? 'null'}`);
      if (provider.id === 'p-step') {
        // overflow mid-reasoning: reasoning streamed, no content, finish=length
        yield { type: 'reasoning', delta: 'thinking…' };
        yield { type: 'finish', reason: 'length' };
      } else {
        // next provider produces a real answer
        yield { type: 'content', delta: 'final answer' };
        yield { type: 'finish', reason: 'stop' };
      }
    };
    const chunks = [];
    const r = await run({
      messages: [{ role: 'user', content: 'hard q' }],
      tools: null,
      capabilityRequired: { vision: false, audio: false },
      reasoningEffort: 'high',
      onChunk: async (c) => chunks.push(c),
    });
    expect(r.ok).toBe(true);
    // length-overflow with empty answer → do not retry; fall through immediately
    expect(mockState.adapterCalls).toEqual(['p-step', 'p-spark']);
    expect(reasoningSeen).toEqual(['p-step:high', 'p-spark:high']);
    // the fallback provider's answer reached the client
    expect(chunks.some((c) => c.type === 'content' && c.delta === 'final answer')).toBe(true);
  });

  it('does not retry length-overflow when a visible answer was produced', async () => {
    let call = 0;
    mockState.adapterFn = async function* ({ provider }) {
      mockState.adapterCalls.push(provider.id);
      call += 1;
      yield { type: 'content', delta: 'partial but visible' };
      yield { type: 'finish', reason: 'length' };
    };
    const r = await run({
      messages: [{ role: 'user', content: 'q' }],
      tools: null,
      capabilityRequired: { vision: false, audio: false },
      reasoningEffort: 'high',
      onChunk: async () => {},
    });
    expect(r.ok).toBe(true);
    // truncated-but-visible → pass through, no retry
    expect(mockState.adapterCalls).toEqual(['p-step']);
    expect(call).toBe(1);
  });

  it('uses first provider on success', async () => {
    mockState.adapterFn = async function* ({ provider }) {
      mockState.adapterCalls.push(provider.id);
      yield { type: 'content', delta: 'hi' };
      yield { type: 'finish', reason: 'stop' };
    };
    const chunks = [];
    const r = await run({ messages: [{ role: 'user', content: 'q' }], tools: null, capabilityRequired: { vision: false, audio: false }, onChunk: async c => chunks.push(c) });
    expect(r.ok).toBe(true);
    expect(r.providerId).toBe('p-step');
    expect(mockState.adapterCalls).toEqual(['p-step']);
    expect(chunks.map(c => c.type)).toEqual(['content', 'finish']);
  });

  it('falls back on HTTP error (markUnhealthy + try next)', async () => {
    let callIdx = 0;
    mockState.adapterFn = async function* ({ provider }) {
      mockState.adapterCalls.push(provider.id);
      callIdx++;
      if (callIdx === 1) throw new Error('p-step HTTP 500 fail');
      yield { type: 'content', delta: 'fallback ok' };
    };
    const chunks = [];
    const r = await run({ messages: [{ role: 'user', content: 'q' }], onChunk: async c => chunks.push(c) });
    expect(r.providerId).toBe('p-spark');
    expect(mockState.adapterCalls).toEqual(['p-step', 'p-spark']);
    expect(mockState.cooldown.has('p-step')).toBe(true);  // HTTP error 2192 markUnhealthy
    expect(mockState.unhealthy[0]).toMatchObject({ id: 'p-step', reason: expect.stringContaining('error-server') });
  });

  it('recovers when every eligible provider is already in cooldown', async () => {
    mockState.cooldown.add('p-step');
    mockState.cooldown.add('p-spark');
    mockState.cooldown.add('p-cloud');
    mockState.cooldown.add('p-vision');
    const logs = [];
    mockState.adapterFn = async function* ({ provider }) {
      mockState.adapterCalls.push(provider.id);
      yield { type: 'content', delta: 'recovered' };
      yield { type: 'finish', reason: 'stop' };
    };

    const r = await run({
      messages: [{ role: 'user', content: 'q' }],
      onChunk: async () => {},
      log: (level, message) => logs.push({ level, message }),
    });

    expect(r.providerId).toBe('p-step');
    expect(mockState.adapterCalls).toEqual(['p-step']);
    expect(mockState.cooldown.size).toBe(0);
    expect(logs.some((entry) => entry.message.includes('cleared cooldowns for recovery probe'))).toBe(true);
  });

  it('falls back on HTTP 429 rate limit and cools down the limited provider', async () => {
    let callIdx = 0;
    const chunks = [];
    const metas = [];
    mockState.adapterFn = async function* ({ provider }) {
      mockState.adapterCalls.push(provider.id);
      callIdx++;
      if (callIdx === 1) throw new Error('p-step HTTP 429: rate limited');
      yield { type: 'content', delta: 'fallback after rate limit' };
      yield { type: 'finish', reason: 'stop' };
    };

    const r = await run({
      messages: [{ role: 'user', content: 'q' }],
      onChunk: async (c, meta) => {
        chunks.push(c);
        metas.push(meta);
      },
    });

    expect(r.providerId).toBe('p-spark');
    expect(mockState.adapterCalls).toEqual(['p-step', 'p-spark']);
    expect(mockState.cooldown.has('p-step')).toBe(true);
    expect(mockState.unhealthy[0]).toMatchObject({ id: 'p-step', reason: expect.stringContaining('error-rate-limit') });
    expect(chunks.find((c) => c.type === 'content')?.delta).toBe('fallback after rate limit');
    expect(metas.find((_, index) => chunks[index]?.type === 'content')?.fallback_from).toEqual([
      { id: 'p-step', reason: 'error-rate-limit' },
    ]);
  });

  it('empty-emit single hit: still tries next but no cooldown (P1#4 threshold=2)', async () => {
    let callIdx = 0;
    mockState.adapterFn = async function* ({ provider }) {
      mockState.adapterCalls.push(provider.id);
      callIdx++;
      if (callIdx === 1) {
        // empty: no yield
        return;
      }
      yield { type: 'content', delta: 'real answer' };
    };
    const chunks = [];
    const r = await run({ messages: [{ role: 'user', content: 'q' }], onChunk: async c => chunks.push(c) });
    expect(r.providerId).toBe('p-spark');
    expect(mockState.cooldown.has('p-step')).toBe(false);  // P1#4: 1st empty doesn't cooldown yet
  });

  it('skips providers in cooldown', async () => {
    mockState.cooldown.add('p-step');
    mockState.cooldown.add('p-spark');
    mockState.adapterFn = async function* ({ provider }) {
      mockState.adapterCalls.push(provider.id);
      yield { type: 'content', delta: 'cloud took it' };
    };
    const r = await run({ messages: [{ role: 'user', content: 'q' }], onChunk: async () => {} });
    expect(r.providerId).toBe('p-cloud');
    expect(mockState.adapterCalls).toEqual(['p-cloud']);
  });

  it('probes local providers through explicit health_path before fallback use', async () => {
    mockState.cooldown.add('p-step');
    mockState.providers['p-spark'] = {
      ...makeProvider('p-spark'),
      endpoint: 'http://127.0.0.1:18098/v1',
      health_path: '/health',
      health_probe_ms: 25,
    };
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    mockState.adapterFn = async function* ({ provider }) {
      mockState.adapterCalls.push(provider.id);
      yield { type: 'content', delta: 'spark ok' };
    };

    const r = await run({ messages: [{ role: 'user', content: 'q' }], onChunk: async () => {} });

    expect(r.providerId).toBe('p-spark');
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:18098/health', expect.any(Object));
    expect(mockState.adapterCalls).toEqual(['p-spark']);
  });

  it('skips the Spark A3B local manager when its single llama.cpp slot is busy', async () => {
    mockState.cooldown.add('p-step');
    mockState.providers['p-spark'] = {
      ...makeProvider('apex-spark-i-balanced'),
      endpoint: 'http://127.0.0.1:18098/v1',
      health_path: '/health',
      health_probe_ms: 25,
    };
    const fetchMock = vi.fn(async (url) => {
      if (String(url).endsWith('/slots')) {
        return { ok: true, json: async () => ([{ id: 0, is_processing: true }]) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    mockState.adapterFn = async function* ({ provider }) {
      mockState.adapterCalls.push(provider.id);
      yield { type: 'content', delta: 'cloud ok' };
      yield { type: 'finish', reason: 'stop' };
    };

    const metas = [];
    const r = await run({
      messages: [{ role: 'user', content: 'q' }],
      onChunk: async (_chunk, meta) => metas.push(meta),
    });

    expect(r.providerId).toBe('p-cloud');
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:18098/health', expect.any(Object));
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:18098/slots', expect.any(Object));
    expect(mockState.adapterCalls).toEqual(['p-cloud']);
    expect(metas[0].fallback_from).toEqual([
      { id: 'p-step', reason: 'cooldown' },
      { id: 'p-spark', reason: 'local-manager-busy-single-slot' },
    ]);
  });

  it('clears cooldown on successful provider run', async () => {
    mockState.cooldown.add('p-step');  // p-step was unhealthy
    mockState.adapterFn = async function* ({ provider }) {
      mockState.adapterCalls.push(provider.id);
      yield { type: 'content', delta: 'x' };
    };
    await run({ messages: [{ role: 'user', content: 'q' }], onChunk: async () => {} });
    // p-spark succeeded, cooldown cleared for p-spark (was not set anyway)
    // p-step's cooldown remains (we skipped it)
    expect(mockState.cooldown.has('p-step')).toBe(true);  // pre-set cooldown unchanged
    expect(mockState.cooldown.has('p-spark')).toBe(false);
  });

  it('capability gate skips providers without vision when vision required', async () => {
    mockState.adapterFn = async function* ({ provider }) {
      mockState.adapterCalls.push(provider.id);
      yield { type: 'content', delta: 'visioned ok' };
    };
    const r = await run({
      messages: [{ role: 'user', content: 'describe image' }],
      capabilityRequired: { vision: true, audio: false },
      onChunk: async () => {},
    });
    expect(r.providerId).toBe('p-vision');
    expect(mockState.adapterCalls).toEqual(['p-vision']);
  });

  it('routes audio + video requests to a multimodal-capable provider (CLI omni input is consumed)', async () => {
    // The omni provider gains audio/video so the capability gate can land on it.
    mockState.providers['p-vision'] = makeProvider('p-vision', { vision: true, audio: true, video: true });
    mockState.adapterFn = async function* ({ provider }) {
      mockState.adapterCalls.push(provider.id);
      yield { type: 'content', delta: 'omni ok' };
    };

    const audio = await run({ messages: [{ role: 'user', content: 'transcribe this' }], capabilityRequired: { audio: true }, onChunk: async () => {} });
    expect(audio.providerId).toBe('p-vision');

    mockState.adapterCalls = [];
    const video = await run({ messages: [{ role: 'user', content: 'watch this' }], capabilityRequired: { video: true }, onChunk: async () => {} });
    expect(video.providerId).toBe('p-vision');
    expect(mockState.adapterCalls).toEqual(['p-vision']);
  });

  it('errors loudly when an audio request has no audio-capable provider (no silent text fallback)', async () => {
    // None of the default mock providers support audio → the gate must refuse,
    // not quietly answer with a text-only model.
    mockState.adapterFn = async function* () { yield { type: 'content', delta: 'should not run' }; };
    await expect(
      run({ messages: [{ role: 'user', content: 'transcribe' }], capabilityRequired: { audio: true }, onChunk: async () => {} }),
    ).rejects.toThrow(/CAPABILITY_NOT_SUPPORTED/);
    expect(mockState.adapterCalls).toEqual([]);
  });

  it('throws when all providers fail with errors collected', async () => {
    mockState.adapterFn = async function* ({ provider }) {
      throw new Error(`${provider.id} dead`);
    };
    await expect(
      run({ messages: [{ role: 'user', content: 'q' }], onChunk: async () => {} })
    ).rejects.toThrow(/all providers failed/);
  });

  it('forwards onChunk meta with providerId', async () => {
    mockState.adapterFn = async function* () {
      yield { type: 'content', delta: 'a' };
      yield { type: 'content', delta: 'b' };
    };
    const metas = [];
    await run({ messages: [{ role: 'user', content: 'q' }], onChunk: async (c, meta) => metas.push(meta) });
    expect(metas.every(m => m.providerId === 'p-step')).toBe(true);
  });

  it('injects pre-search context before the selected non-native provider runs', async () => {
    process.env.BRAIN_V2_PRE_SEARCH = '1';
    process.env.ZHIPU_KEY = 'test-zhipu';
    mockState.cooldown.add('p-step');
    mockState.providers['p-spark'] = makeProvider('p-spark', { native_search: false });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({
        search_result: [{ title: '杭州天气', link: '', content: '杭州今日有小雨。', publish_date: '2026-06-13' }],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    let adapterMessages = null;
    mockState.adapterFn = async function* ({ messages }) {
      adapterMessages = messages;
      yield { type: 'content', delta: 'ok' };
    };

    const chunks = [];
    const metas = [];
    const result = await run({
      messages: [
        { role: 'system', content: 'persona must stay at prefix' },
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '你好' },
        { role: 'user', content: '今天天气怎么样 router-presearch-unique-20260613' },
      ],
      onChunk: async (chunk, meta) => {
        chunks.push(chunk);
        metas.push(meta);
      },
    });

    expect(result.providerId).toBe('p-spark');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(chunks.map(c => c.type)).toEqual(['pre_search', 'content']);
    expect(chunks[0]).toMatchObject({ source: 'glm', hit: true, cached: null });
    expect(metas[0].fallback_from).toEqual([{ id: 'p-step', reason: 'cooldown' }]);
    expect(adapterMessages).toHaveLength(5);
    expect(adapterMessages.map(m => m.role)).toEqual(['system', 'user', 'assistant', 'user', 'user']);
    expect(adapterMessages.filter(m => m.role === 'system')).toHaveLength(1);
    expect(adapterMessages[0].content).toBe('persona must stay at prefix');
    expect(adapterMessages[3].role).toBe('user');
    expect(String(adapterMessages[3].content)).toContain('<lynn_runtime_frame');
    expect(String(adapterMessages[3].content)).toContain('【实时信息上下文】');
    expect(adapterMessages[4].role).toBe('user');
    expect(adapterMessages[4].content).toBe('今天天气怎么样 router-presearch-unique-20260613');
  });

  it('suppresses repeated server tool calls when storm detection is enabled', async () => {
    process.env.BRAIN_V2_STORM_DETECT = '1';
    process.env.BRAIN_V2_STORM_THRESHOLD = '2';
    process.env.BRAIN_V2_STORM_MAX = '3';
    let adapterRuns = 0;
    mockState.adapterFn = async function* () {
      adapterRuns += 1;
      yield {
        type: 'tool_call_delta',
        delta: [{
          index: 0,
          id: `tc-${adapterRuns}`,
          type: 'function',
          function: { name: 'unit_convert', arguments: '{"query":"100公里"}' },
        }],
      };
      yield { type: 'finish', reason: 'tool_calls' };
    };

    const chunks = [];
    const result = await run({
      messages: [{ role: 'user', content: '重复换算测试' }],
      onChunk: async (chunk) => chunks.push(chunk),
    });

    expect(result).toMatchObject({
      ok: false,
      error: 'tool_storm_limit',
      providerId: 'p-step',
      iterations: 4,
    });
    expect(adapterRuns).toBe(4);
    expect(chunks.filter(c => c.type === 'error')).toEqual([
      expect.objectContaining({ error: 'tool_storm_limit', tool: 'unit_convert', storms: 3 }),
    ]);
    expect(chunks.filter(c => c.type === 'tool_progress' && c.event === 'end').map(c => c.ok))
      .toEqual([true, false, false, false]);
  });

  it('emits a compact server tool result summary for search cards', async () => {
    process.env.ZHIPU_KEY = 'test-zhipu';
    process.env.MIMO_SEARCH_KEY = 'test-mimo';
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          search_result: [{ title: 'A', link: 'https://a.example', content: 'Zhipu summary a snippet' }],
        }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: 'MiMo summary', annotations: [{ type: 'url_citation', title: 'B', url: 'https://b.example', summary: 'b snippet' }] } }],
        }),
        text: async () => '',
      }));

    let adapterRuns = 0;
    mockState.adapterFn = async function* () {
      adapterRuns += 1;
      if (adapterRuns === 1) {
        yield {
          type: 'tool_call_delta',
          delta: [{
            index: 0,
            id: 'tc-search-summary',
            type: 'function',
            function: { name: 'web_search', arguments: '{"query":"Lynn CLI"}' },
          }],
        };
        yield { type: 'finish', reason: 'tool_calls' };
        return;
      }
      yield { type: 'content', delta: 'done' };
      yield { type: 'finish', reason: 'stop' };
    };

    const chunks = [];
    const result = await run({
      messages: [{ role: 'user', content: 'search Lynn CLI' }],
      onChunk: async (chunk) => chunks.push(chunk),
    });

    expect(result).toMatchObject({ ok: true, iterations: 2 });
    const end = chunks.find((chunk) => chunk.type === 'tool_progress' && chunk.event === 'end');
    expect(end).toMatchObject({ name: 'web_search', ok: true, argsSummary: 'Lynn CLI' });
    expect(end.summary).toContain('Zhipu summary');
    expect(end.details).toEqual(expect.arrayContaining([
      expect.stringContaining('Zhipu summary'),
      expect.stringContaining('[A](https://a.example)'),
    ]));
  });

  it('falls through to the next provider when a round is reasoning-only with finish=stop (思考完不说话)', async () => {
    // 2026-06-19:空正文不能在同一模型上吊死。DS V4 Flash 一旦只出 reasoning
    // 且没有正文,必须立刻让下一个 provider(生产链路里就是 Step 3.7 Flash)接手。
    const reasoningSeen = [];
    mockState.adapterFn = async function* ({ provider, reasoningEffort }) {
      mockState.adapterCalls.push(provider.id);
      reasoningSeen.push(`${provider.id}:${reasoningEffort ?? 'null'}`);
      if (provider.id === 'p-step') {
        yield { type: 'reasoning', delta: '想了一大圈…' };
        yield { type: 'finish', reason: 'stop' }; // 不是 length —— 正常 stop 但零正文
        return;
      }
      yield { type: 'content', delta: '这是最终答案' };
      yield { type: 'finish', reason: 'stop' };
    };
    const chunks = [];
    const r = await run({
      messages: [{ role: 'user', content: '调研一下' }],
      reasoningEffort: 'high',
      onChunk: async (chunk) => chunks.push(chunk),
    });
    expect(r).toMatchObject({ ok: true, iterations: 2 });
    expect(mockState.adapterCalls).toEqual(['p-step', 'p-spark']);
    expect(reasoningSeen).toEqual(['p-step:high', 'p-spark:high']);
    expect(chunks.some((c) => c.type === 'content' && /最终答案/.test(c.delta))).toBe(true);
  });

  it('hands off a buffered half-sentence after long reasoning instead of closing the turn', async () => {
    mockState.adapterFn = async function* ({ provider }) {
      mockState.adapterCalls.push(provider.id);
      if (provider.id === 'p-step') {
        yield { type: 'reasoning', delta: '先规划人物背景、记忆缺口、行为矛盾和故事线。'.repeat(12) };
        yield { type: 'content', delta: '陈默，34岁，前结构工程师，现靠' };
        yield { type: 'finish', reason: 'stop' };
        return;
      }
      yield { type: 'content', delta: '陈默，34岁，前结构工程师。一次事故让他的记忆出现缺口，因此他只相信可验证的证据。' };
      yield { type: 'finish', reason: 'stop' };
    };
    const chunks = [];
    const result = await run({
      messages: [{ role: 'user', content: '写一个人物小传' }],
      tools: [{ type: 'function', function: { name: 'read_file' } }],
      onChunk: async (chunk) => chunks.push(chunk),
    });

    expect(result).toMatchObject({ ok: true, providerId: 'p-spark', iterations: 2 });
    expect(mockState.adapterCalls).toEqual(['p-step', 'p-spark']);
    const visible = chunks.filter((chunk) => chunk.type === 'content').map((chunk) => chunk.delta).join('');
    expect(visible).not.toContain('现靠');
    expect(visible).toContain('只相信可验证的证据');
    expect(mockState.unhealthy).not.toContainEqual(expect.objectContaining({ id: 'p-step', reason: 'incomplete_visible' }));
  });

  it('falls through on a plain empty stop without reasoning', async () => {
    mockState.adapterFn = async function* ({ provider }) {
      mockState.adapterCalls.push(provider.id);
      if (provider.id === 'p-step') {
        yield { type: 'finish', reason: 'stop' };
        return;
      }
      yield { type: 'content', delta: 'fallback answer' };
      yield { type: 'finish', reason: 'stop' }; // 无 reasoning 无 content —— 维持 BYOK 透传语义
    };
    const chunks = [];
    const r = await run({ messages: [{ role: 'user', content: 'x' }], onChunk: async (chunk) => chunks.push(chunk) });
    expect(r).toMatchObject({ ok: true, iterations: 2 });
    expect(mockState.adapterCalls).toEqual(['p-step', 'p-spark']);
    expect(chunks.some((c) => c.type === 'content' && c.delta === 'fallback answer')).toBe(true);
  });

  it('falls through when a provider exceeds its per-attempt timeout', async () => {
    mockState.providers['p-step'].timeout_ms = 5;
    mockState.adapterFn = async function* ({ provider, signal }) {
      mockState.adapterCalls.push(provider.id);
      if (provider.id === 'p-step') {
        await new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
        });
        return;
      }
      yield { type: 'content', delta: 'fallback answer' };
      yield { type: 'finish', reason: 'stop' };
    };
    const chunks = [];

    const result = await run({
      messages: [{ role: 'user', content: 'hello' }],
      onChunk: async (chunk, meta) => chunks.push({ ...chunk, meta }),
    });

    expect(result.ok).toBe(true);
    expect(result.providerId).toBe('p-spark');
    expect(mockState.adapterCalls).toEqual(['p-step', 'p-spark']);
    expect(mockState.unhealthy).toContainEqual(expect.objectContaining({
      id: 'p-step',
      reason: expect.stringContaining('timeout'),
      cooldownMs: 5_000,
    }));
    expect(chunks.some((c) => c.type === 'content' && c.delta === 'fallback answer')).toBe(true);
  });

  it('makes one bounded no-tool recovery probe when every provider times out', async () => {
    const attempts = new Map();
    mockState.adapterFn = async function* ({ provider }) {
      mockState.adapterCalls.push(provider.id);
      const count = (attempts.get(provider.id) || 0) + 1;
      attempts.set(provider.id, count);
      if (provider.id === 'p-step' && count === 2) {
        yield { type: 'content', delta: 'recovered answer' };
        yield { type: 'finish', reason: 'stop' };
        return;
      }
      throw new Error('timeout');
    };
    const chunks = [];

    const result = await run({
      messages: [{ role: 'user', content: '设计一个三幕式小说大纲' }],
      onChunk: async (chunk) => chunks.push(chunk),
    });

    expect(result).toMatchObject({ ok: true, providerId: 'p-step' });
    expect(mockState.adapterCalls).toEqual(['p-step', 'p-spark', 'p-cloud', 'p-vision', 'p-step']);
    expect(chunks.some((chunk) => chunk.type === 'content' && chunk.delta === 'recovered answer')).toBe(true);
  });

  it('drops tool continuation rounds to medium reasoning when client did not pin an effort', async () => {
    stubSearchFetchOk();
    const reasoningSeen = [];
    mockState.adapterFn = makeToolThenContentAdapter(reasoningSeen);

    const result = await run({
      messages: [{ role: 'user', content: 'search something' }],
      onChunk: async () => {},
    });

    expect(result).toMatchObject({ ok: true, iterations: 2 });
    // round 1 rides the provider default (client sent nothing); continuation round is medium
    expect(reasoningSeen).toEqual([null, 'medium']);
  });

  it('honors an explicitly pinned client effort across tool continuation rounds', async () => {
    stubSearchFetchOk();
    const reasoningSeen = [];
    mockState.adapterFn = makeToolThenContentAdapter(reasoningSeen);

    const result = await run({
      messages: [{ role: 'user', content: 'search something' }],
      reasoningEffort: 'high',
      onChunk: async () => {},
    });

    expect(result).toMatchObject({ ok: true, iterations: 2 });
    expect(reasoningSeen).toEqual(['high', 'high']);
  });

  it('keeps continuation rounds at the default effort when LYNN_TOOL_ROUND_EFFORT_DOWN=0', async () => {
    process.env.LYNN_TOOL_ROUND_EFFORT_DOWN = '0';
    stubSearchFetchOk();
    const reasoningSeen = [];
    mockState.adapterFn = makeToolThenContentAdapter(reasoningSeen);

    const result = await run({
      messages: [{ role: 'user', content: 'search something' }],
      onChunk: async () => {},
    });

    expect(result).toMatchObject({ ok: true, iterations: 2 });
    expect(reasoningSeen).toEqual([null, null]);
  });

  it('echoes reasoning_content on DeepSeek tool continuation even when no reasoning streamed', async () => {
    process.env.BRAIN_V2_EVIDENCE_HANDOFF = '0';
    stubSearchFetchOk();
    mockState.providers = { 'deepseek-chat': makeProvider('deepseek-chat') };
    mockState.order = ['deepseek-chat'];
    const capturedRounds = [];
    mockState.adapterFn = makeTwoToolThenContentAdapter(capturedRounds);

    const result = await run({
      messages: [{ role: 'user', content: 'search with deepseek' }],
      onChunk: async () => {},
    });

    expect(result).toMatchObject({ ok: true, iterations: 2 });
    const assistantContinuation = capturedRounds[1].find((message) => message.role === 'assistant' && Array.isArray(message.tool_calls));
    expect(assistantContinuation).toBeTruthy();
    expect(assistantContinuation).toHaveProperty('reasoning_content', '');
  });

  it('does not add reasoning_content to non-DeepSeek tool continuations', async () => {
    stubSearchFetchOk();
    const capturedRounds = [];
    mockState.adapterFn = makeTwoToolThenContentAdapter(capturedRounds);

    const result = await run({
      messages: [{ role: 'user', content: 'search with stepfun' }],
      onChunk: async () => {},
    });

    expect(result).toMatchObject({ ok: true, iterations: 2 });
    const assistantContinuation = capturedRounds[1].find((message) => message.role === 'assistant' && Array.isArray(message.tool_calls));
    expect(assistantContinuation).toBeTruthy();
    expect(assistantContinuation).not.toHaveProperty('reasoning_content');
  });

  it('preserves streamed reasoning_content on tool continuations even when provider id is not enough', async () => {
    stubSearchFetchOk();
    const capturedRounds = [];
    let adapterRuns = 0;
    mockState.adapterFn = async function* ({ messages }) {
      adapterRuns += 1;
      capturedRounds.push(messages);
      if (adapterRuns === 1) {
        yield { type: 'reasoning', delta: 'plan with tool' };
        yield {
          type: 'tool_call_delta',
          delta: [
            { index: 0, id: 'tc-a', type: 'function', function: { name: 'web_search', arguments: '{"query":"alpha"}' } },
          ],
        };
        yield { type: 'finish', reason: 'tool_calls' };
        return;
      }
      yield { type: 'content', delta: 'done' };
      yield { type: 'finish', reason: 'stop' };
    };

    const result = await run({
      messages: [{ role: 'user', content: 'search with streamed reasoning' }],
      onChunk: async () => {},
    });

    expect(result).toMatchObject({ ok: true, iterations: 2 });
    const assistantContinuation = capturedRounds[1].find((message) => message.role === 'assistant' && Array.isArray(message.tool_calls));
    expect(assistantContinuation).toBeTruthy();
    expect(assistantContinuation).toHaveProperty('reasoning_content', 'plan with tool');
  });

  it('runs independent server tools concurrently and feeds results back in original call order', async () => {
    process.env.ZHIPU_KEY = 'test-zhipu';
    process.env.MIMO_SEARCH_KEY = 'test-mimo';
    // Concurrency barrier: each web_search issues one default GLM fetch. With both tools
    // in flight at once there are 2 pending fetches; serial execution would stall at 1.
    const pending = [];
    let sawParallelBarrier = false;
    const okPayload = {
      ok: true,
      status: 200,
      json: async () => ({ search_result: [{ title: 'search summary', link: 'https://search.example', content: 'search summary' }] }),
      text: async () => '',
    };
    const flush = () => { while (pending.length) pending.shift()(okPayload); };
    const fallbackTimer = setTimeout(flush, 1500);
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => {
      pending.push(resolve);
      if (pending.length >= 2) {
        sawParallelBarrier = true;
        clearTimeout(fallbackTimer);
        flush();
      }
    })));

    const capturedRounds = [];
    mockState.adapterFn = makeTwoToolThenContentAdapter(capturedRounds);

    const chunks = [];
    const result = await run({
      messages: [{ role: 'user', content: 'search two things' }],
      onChunk: async (chunk) => chunks.push(chunk),
    });
    clearTimeout(fallbackTimer);

    expect(result).toMatchObject({ ok: true, iterations: 2 });
    expect(sawParallelBarrier).toBe(true);
    const starts = chunks.filter((c) => c.type === 'tool_progress' && c.event === 'start');
    const ends = chunks.filter((c) => c.type === 'tool_progress' && c.event === 'end');
    expect(starts).toHaveLength(2);
    expect(ends).toHaveLength(2);
    // Round-2 messages carry both tool results in the model's original call order.
    const round2Tools = capturedRounds[1].filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
    expect(round2Tools).toEqual(['tc-a', 'tc-b']);
  });

  it('adds grounding instructions to realtime evidence tool results before synthesis', async () => {
    process.env.ZHIPU_KEY = 'test-zhipu';
    process.env.MIMO_SEARCH_KEY = 'test-mimo';
    stubSearchFetchOk();
    const capturedRounds = [];
    mockState.adapterFn = makeTwoToolThenContentAdapter(capturedRounds);

    const result = await run({
      messages: [{ role: 'user', content: '世界杯最新赛程' }],
      onChunk: async () => {},
    });

    expect(result).toMatchObject({ ok: true, iterations: 2 });
    const toolMessages = capturedRounds[1].filter((m) => m.role === 'tool');
    expect(toolMessages).toHaveLength(2);
    for (const message of toolMessages) {
      expect(message.content).toContain('【Lynn 工具证据 #');
      expect(message.content).toContain('当前时间(Asia/Shanghai)');
      expect(message.content).toContain('【证据账本】');
      expect(message.content).toContain('请只基于上方工具证据回答当前事实');
      expect(message.content).toContain('不要用旧知识或记忆补充工具证据里没有的具体事实');
      expect(message.content).toContain('网页发布时间只能说明来源发布时间');
      expect(message.content).toContain('The user wants');
    }
  });

  it('weights structured evidence instead of counting every tool as one', () => {
    expect(__testing__.evidenceToolWeight('sports_score', JSON.stringify({
      status: 'no_direct_source',
      guidance: 'use web_search',
    }))).toBe(0);

    expect(__testing__.evidenceToolWeight('sports_score', JSON.stringify({
      ok: true,
      items: [],
    }))).toBe(0);

    expect(__testing__.evidenceToolWeight('sports_score', [
      'provider: espn_scoreboard',
      '- 2026/06/22 00:00 Spain vs Saudi Arabia (Scheduled)',
    ].join('\n'))).toBe(1);

    expect(__testing__.evidenceToolWeight('web_search', JSON.stringify({
      ok: true,
      items: [
        { title: 'A', url: 'https://a.example', snippet: 'a' },
        { title: 'B', url: 'https://b.example', snippet: 'b' },
        { title: 'C', url: 'https://c.example', snippet: 'c' },
        { title: 'D', url: 'https://d.example', snippet: 'd' },
      ],
    }))).toBe(3);

    expect(__testing__.evidenceToolWeight('web_search', JSON.stringify({
      ok: true,
      sources: [
        { ok: true, items: [] },
        { ok: true, results: [] },
      ],
    }))).toBe(0);

    expect(__testing__.evidenceToolWeight('web_search', JSON.stringify({
      ok: true,
      sources: [
        { ok: true, title: 'Official schedule', url: 'https://example.com/schedule' },
      ],
    }))).toBe(1);

    expect(__testing__.evidenceToolWeight(
      'web_search',
      '综合答案：这是搜索工具返回的长文本证据，虽然没有结构化 citations 字段，但包含足够的来源摘要和可核查事实，应当触发证据交接，让后续总结模型只基于工具证据回答，而不是继续调用工具或使用旧知识。'
    )).toBe(3);

    expect(__testing__.evidenceToolWeight('web_search', '空')).toBe(0);

    expect(__testing__.evidenceToolWeight('parallel_research', JSON.stringify({
      parallel: true,
      results: [
        { ok: true, result: 'source one' },
        { ok: true, result: { text: 'source two' } },
        { ok: false, error: 'failed' },
      ],
    }))).toBe(2);

    expect(__testing__.evidenceHandoffAfterForTool('sports_score')).toBe(1);
    expect(__testing__.evidenceHandoffAfterForTool('weather')).toBe(1);
    expect(__testing__.evidenceHandoffAfterForTool('parallel_research')).toBe(2);
    expect(__testing__.evidenceHandoffAfterForTool('web_search')).toBe(3);
  });

  it('exposes explicit Asia Shanghai date anchors for relative-date synthesis', () => {
    const context = __testing__.currentTemporalContext(new Date('2026-06-20T16:30:00.000Z'));
    expect(context).toContain('当前日期锚点(Asia/Shanghai): 今天=2026-06-21');
    expect(context).toContain('昨天=2026-06-20');
    expect(context).toContain('明天=2026-06-22');
    expect(context).toContain('当前时间(UTC): 2026-06-20T16:30:00.000Z');
  });

  it('detects no-result claims that contradict explicit past/current dates', () => {
    expect(__testing__.containsTemporalNoResultContradiction(
      '2026年世界杯正赛要到2026年6月11日—7月19日才举行，所以正赛目前还没有任何比分。',
      new Date('2026-06-21T00:00:00+08:00'),
    )).toBe(true);
    expect(__testing__.containsTemporalNoResultContradiction(
      '2026年7月10日半决赛尚未开打，暂时没有比分。',
      new Date('2026-06-21T00:00:00+08:00'),
    )).toBe(false);
  });

  it('hands off grounded evidence to the next provider instead of continuing tool loops', async () => {
    process.env.BRAIN_V2_EVIDENCE_HANDOFF_AFTER = '3';
    stubSearchFetchOk();
    mockState.order = ['p-step', 'p-spark', 'p-cloud'];

    const providerToolArgs = [];
    const providerMessages = [];
    let stepRuns = 0;
    mockState.adapterFn = async function* ({ provider, tools, messages }) {
      mockState.adapterCalls.push(provider.id);
      providerToolArgs.push({ provider: provider.id, toolCount: Array.isArray(tools) ? tools.length : -1 });
      providerMessages.push({ provider: provider.id, messages });
      if (provider.id === 'p-step') {
        stepRuns += 1;
        yield {
          type: 'tool_call_delta',
          delta: [{
            index: 0,
            id: `tc-handoff-${stepRuns}`,
            type: 'function',
            function: { name: 'web_search', arguments: `{"query":"q${stepRuns}"}` },
          }],
        };
        yield { type: 'finish', reason: 'tool_calls' };
        return;
      }
      yield { type: 'content', delta: 'summarized from evidence' };
      yield { type: 'finish', reason: 'stop' };
    };

    const chunks = [];
    const result = await run({
      messages: [{ role: 'user', content: '需要实时证据的问题' }],
      onChunk: async (chunk) => chunks.push(chunk),
    });

    expect(result).toMatchObject({ ok: true, providerId: 'p-spark', iterations: 3 });
    expect(mockState.adapterCalls).toEqual(['p-step', 'p-step', 'p-spark']);
    const sparkTools = providerToolArgs.find((entry) => entry.provider === 'p-spark');
    expect(sparkTools.toolCount).toBe(0);
    const sparkMessages = providerMessages.find((entry) => entry.provider === 'p-spark').messages;
    expect(sparkMessages.some((message) => (
      message.role === 'user'
      && String(message.content).includes('工具证据')
      && String(message.content).includes('不要再调用工具')
      && String(message.content).includes('工具证据和当前时间锚点是唯一事实来源')
      && String(message.content).includes('当前时间(Asia/Shanghai)')
      && String(message.content).includes('已知事实 / 来源口径 / 缺口 / 最终答案')
    ))).toBe(true);
    expect(chunks.some((chunk) => chunk.type === 'content' && chunk.delta === 'summarized from evidence')).toBe(true);
  });

  it('hands off stale no-result answers after grounded evidence to the next provider', async () => {
    process.env.BRAIN_V2_EVIDENCE_HANDOFF_AFTER = '99';
    stubSearchFetchOk();
    mockState.order = ['p-step', 'p-spark', 'p-cloud'];

    const providerMessages = [];
    let stepRuns = 0;
    mockState.adapterFn = async function* ({ provider, messages }) {
      mockState.adapterCalls.push(provider.id);
      providerMessages.push({ provider: provider.id, messages });
      if (provider.id === 'p-step') {
        stepRuns += 1;
        if (stepRuns === 1) {
          yield {
            type: 'tool_call_delta',
            delta: [{
              index: 0,
              id: 'tc-stale-evidence',
              type: 'function',
              function: { name: 'web_search', arguments: '{"query":"2026世界杯比分"}' },
            }],
          };
          yield { type: 'finish', reason: 'tool_calls' };
          return;
        }
        yield { type: 'content', delta: '2026年世界杯正赛要到2026年6月11日—7月19日才举行，所以正赛目前还没有任何比分。' };
        yield { type: 'finish', reason: 'stop' };
        return;
      }
      yield { type: 'content', delta: '已有比分：A 1-0 B。' };
      yield { type: 'finish', reason: 'stop' };
    };

    const chunks = [];
    const result = await run({
      messages: [{ role: 'user', content: '2026世界杯已经出的赛事比分' }],
      onChunk: async (chunk, meta) => chunks.push({ ...chunk, meta }),
    });

    expect(result).toMatchObject({ ok: true, providerId: 'p-spark', iterations: 3 });
    expect(mockState.adapterCalls).toEqual(['p-step', 'p-step', 'p-spark']);
    const sparkMessages = providerMessages.find((entry) => entry.provider === 'p-spark').messages;
    expect(sparkMessages.some((message) => (
      message.role === 'user'
      && String(message.content).includes('上一个候选答案')
      && String(message.content).includes('未开赛、无比分、无结果')
      && String(message.content).includes('不要再调用工具')
    ))).toBe(true);
    const visible = chunks.filter((chunk) => chunk.type === 'content').map((chunk) => chunk.delta).join('');
    expect(visible).toBe('已有比分：A 1-0 B。');
  });

  it('hands off tool-denial answers after grounded evidence to the next provider', async () => {
    process.env.BRAIN_V2_EVIDENCE_HANDOFF_AFTER = '99';
    stubSearchFetchOk();
    mockState.order = ['p-step', 'p-spark', 'p-cloud'];

    const providerMessages = [];
    let stepRuns = 0;
    mockState.adapterFn = async function* ({ provider, messages }) {
      mockState.adapterCalls.push(provider.id);
      providerMessages.push({ provider: provider.id, messages });
      if (provider.id === 'p-step') {
        stepRuns += 1;
        if (stepRuns === 1) {
          yield {
            type: 'tool_call_delta',
            delta: [{
              index: 0,
              id: 'tc-tool-denial-evidence',
              type: 'function',
              function: { name: 'web_search', arguments: '{"query":"深圳明天天气"}' },
            }],
          };
          yield { type: 'finish', reason: 'tool_calls' };
          return;
        }
        yield { type: 'content', delta: 'Lynn CLI 的工具集中暂未包含天气查询功能，请去天气网站查看。' };
        yield { type: 'finish', reason: 'stop' };
        return;
      }
      yield { type: 'content', delta: '深圳明天按查询结果为晴天。' };
      yield { type: 'finish', reason: 'stop' };
    };

    const chunks = [];
    const result = await run({
      messages: [{ role: 'user', content: '查深圳明天天气' }],
      onChunk: async (chunk) => chunks.push(chunk),
    });

    expect(result).toMatchObject({ ok: true, providerId: 'p-spark', iterations: 3 });
    expect(mockState.adapterCalls).toEqual(['p-step', 'p-step', 'p-spark']);
    const sparkMessages = providerMessages.find((entry) => entry.provider === 'p-spark').messages;
    expect(sparkMessages.some((message) => (
      message.role === 'user'
      && String(message.content).includes('否认了已经执行过的工具能力')
      && String(message.content).includes('不要再调用工具')
    ))).toBe(true);
    const visible = chunks.filter((chunk) => chunk.type === 'content').map((chunk) => chunk.delta).join('');
    expect(visible).toBe('深圳明天按查询结果为晴天。');
    expect(visible).not.toContain('工具集中暂未包含天气查询功能');
  });

  it('hands off stale no-result answers even when grounded tool output has zero evidence weight', async () => {
    process.env.BRAIN_V2_EVIDENCE_HANDOFF_AFTER = '99';
    process.env.ZHIPU_KEY = 'test-zhipu';
    process.env.MIMO_SEARCH_KEY = 'test-mimo';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
      text: async () => 'search down',
    }));
    mockState.order = ['p-step', 'p-spark', 'p-cloud'];

    let stepRuns = 0;
    mockState.adapterFn = async function* ({ provider }) {
      mockState.adapterCalls.push(provider.id);
      if (provider.id === 'p-step') {
        stepRuns += 1;
        if (stepRuns === 1) {
          yield {
            type: 'tool_call_delta',
            delta: [{
              index: 0,
              id: 'tc-weak-evidence',
              type: 'function',
              function: { name: 'web_search', arguments: '{"query":"2026世界杯比分"}' },
            }],
          };
          yield { type: 'finish', reason: 'tool_calls' };
          return;
        }
        yield { type: 'content', delta: '2026年世界杯正赛要到 **2026年6月11日~7月19日** 才开打，目前还没有任何正赛比分。' };
        yield { type: 'finish', reason: 'stop' };
        return;
      }
      yield { type: 'content', delta: '工具证据不足，未查到可核验比分。' };
      yield { type: 'finish', reason: 'stop' };
    };

    const chunks = [];
    const result = await run({
      messages: [{ role: 'user', content: '2026世界杯已经出的赛事比分' }],
      onChunk: async (chunk, meta) => chunks.push({ ...chunk, meta }),
    });

    expect(result).toMatchObject({ ok: true, providerId: 'p-spark', iterations: 3 });
    expect(mockState.adapterCalls).toEqual(['p-step', 'p-step', 'p-spark']);
    const visible = chunks.filter((chunk) => chunk.type === 'content').map((chunk) => chunk.delta).join('');
    expect(visible).toBe('工具证据不足，未查到可核验比分。');
    expect(visible).not.toContain('还没有任何正赛比分');
  });

  it('drops pre-tool process text when a provider ultimately calls tools', async () => {
    stubSearchFetchOk();
    mockState.order = ['p-step', 'p-spark'];

    let stepRuns = 0;
    mockState.adapterFn = async function* ({ provider }) {
      if (provider.id === 'p-step') {
        stepRuns += 1;
        if (stepRuns === 1) {
          yield { type: 'content', delta: '让我先查一下最新信息。' };
          yield {
            type: 'tool_call_delta',
            delta: [{
              index: 0,
              id: 'tc-pre-tool-process',
              type: 'function',
              function: { name: 'web_search', arguments: '{"query":"今晚赛程"}' },
            }],
          };
          yield { type: 'finish', reason: 'tool_calls' };
          return;
        }
        yield { type: 'content', delta: '根据证据，今晚有 4 场比赛。' };
        yield { type: 'finish', reason: 'stop' };
        return;
      }
      yield { type: 'content', delta: 'fallback answer' };
      yield { type: 'finish', reason: 'stop' };
    };

    const chunks = [];
    await run({
      messages: [{ role: 'user', content: '今晚有几场比赛' }],
      onChunk: async (chunk) => chunks.push(chunk),
    });

    const visible = chunks.filter((chunk) => chunk.type === 'content').map((chunk) => chunk.delta).join('');
    expect(visible).toContain('根据证据，今晚有 4 场比赛。');
    expect(visible).not.toContain('让我先查');
  });

  it('emits a deterministic scoreboard answer when providers fail after ESPN evidence', async () => {
    mockState.order = ['p-step', 'p-spark'];
    mockState.adapterFn = async function* ({ provider }) {
      mockState.adapterCalls.push(provider.id);
      if (provider.id === 'p-step') {
        yield {
          type: 'tool_call_delta',
          delta: [{
            index: 0,
            id: 'tc-espn-evidence',
            type: 'function',
            function: { name: 'sports_score', arguments: '{"query":"今晚世界杯有几场比赛"}' },
          }],
        };
        yield { type: 'finish', reason: 'tool_calls' };
        return;
      }
      throw new Error(`${provider.id} down`);
    };
    const eventTime = beijingTonightMidnightEvent();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        events: [{
          date: eventTime.iso,
          status: { type: { completed: false, shortDetail: 'Scheduled' } },
          competitions: [{ competitors: [
            { homeAway: 'home', score: '0', team: { displayName: 'Spain' } },
            { homeAway: 'away', score: '0', team: { displayName: 'Saudi Arabia' } },
          ] }],
        }],
      }),
    })));

    const chunks = [];
    const result = await run({
      messages: [{ role: 'user', content: '今晚世界杯有几场比赛' }],
      onChunk: async (chunk) => chunks.push(chunk),
    });

    expect(result.ok).toBe(true);
    const visible = chunks.filter((chunk) => chunk.type === 'content').map((chunk) => chunk.delta).join('');
    expect(visible).toContain('根据 ESPN scoreboard 工具证据');
    expect(visible).toContain(`| ${eventTime.label} | Spain vs Saudi Arabia | Scheduled |`);
  });

  it('closes factual ESPN web_search evidence without cascading across synthesis providers', async () => {
    mockState.order = ['p-step', 'p-spark', 'p-cloud'];
    const eventTime = beijingTonightMidnightEvent();
    mockState.adapterFn = async function* ({ provider }) {
      mockState.adapterCalls.push(provider.id);
      if (provider.id === 'p-step') {
        yield {
          type: 'tool_call_delta',
          delta: [{
            index: 0,
            id: 'tc-espn-web-search',
            type: 'function',
            function: { name: 'web_search', arguments: '{"query":"今晚世界杯只有一场吗？"}' },
          }],
        };
        yield { type: 'finish', reason: 'tool_calls' };
        return;
      }
      yield { type: 'content', delta: `${provider.id} should not synthesize` };
      yield { type: 'finish', reason: 'stop' };
    };
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        events: [{
          date: eventTime.iso,
          status: { type: { completed: false, shortDetail: 'Scheduled' } },
          competitions: [{ competitors: [
            { homeAway: 'home', score: '0', team: { displayName: 'South Africa' } },
            { homeAway: 'away', score: '0', team: { displayName: 'Canada' } },
          ] }],
        }],
      }),
    })));

    const chunks = [];
    const result = await run({
      messages: [{ role: 'user', content: '只有一场吗？' }],
      onChunk: async (chunk, meta) => chunks.push({ ...chunk, meta }),
    });

    expect(result).toMatchObject({ ok: true, providerId: 'p-step', iterations: 1 });
    expect(mockState.adapterCalls).toEqual(['p-step']);
    const visible = chunks.filter((chunk) => chunk.type === 'content').map((chunk) => chunk.delta).join('');
    expect(visible).toContain('根据 ESPN scoreboard 工具证据，共查到 1 场相关比赛');
    expect(visible).toContain(`| ${eventTime.label} | South Africa vs Canada | Scheduled |`);
    expect(visible).not.toContain('p-spark should not synthesize');
    expect(visible).not.toContain('p-cloud should not synthesize');
  });

  it('prefetches sports_score evidence for direct World Cup score prompts before provider synthesis', async () => {
    process.env.BRAIN_V2_DIRECT_SPORTS_PREFETCH = '1';
    mockState.providers = {
      'mimo-ultraspeed': makeProvider('mimo-ultraspeed'),
      'step-3.7-flash': makeProvider('step-3.7-flash'),
      'deepseek-chat': makeProvider('deepseek-chat'),
    };
    mockState.order = ['mimo-ultraspeed', 'step-3.7-flash', 'deepseek-chat'];
    const captured = [];
    const chunks = [];
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('ESPN unavailable in test');
    }));
    mockState.adapterFn = async function* ({ provider, messages, tools }) {
      mockState.adapterCalls.push(provider.id);
      captured.push({ messages, tools });
      yield { type: 'content', delta: '根据 sports_score 证据，已结束比赛包括 Norway 3-2 Senegal。' };
      yield { type: 'finish', reason: 'stop' };
    };

    const result = await run({
      messages: [{ role: 'user', content: '2026世界杯已经出的赛事比分' }],
      onChunk: async (chunk, meta) => chunks.push({ ...chunk, meta }),
    });

    expect(result.ok).toBe(true);
    expect(result.providerId).toBe('step-3.7-flash');
    expect(mockState.adapterCalls).toEqual(['step-3.7-flash']);
    expect(chunks.some((chunk) => chunk.type === 'tool_progress' && chunk.name === 'sports_score' && chunk.event === 'end' && chunk.meta?.providerId === 'step-3.7-flash')).toBe(true);
    expect(captured[0]?.tools).toEqual([]);
    const promptText = captured[0]?.messages.map((message) => String(message.content || '')).join('\n') || '';
    expect(promptText).toContain('sports_score');
    expect(promptText).toContain('provider: espn_scoreboard');
    expect(promptText).toContain('Norway 3-2 Senegal');
  });

  it('prefetches stock_market evidence for direct index quote prompts before provider synthesis', async () => {
    process.env.BRAIN_V2_DIRECT_MARKET_PREFETCH = '1';
    mockState.providers = {
      'mimo-ultraspeed': makeProvider('mimo-ultraspeed'),
      'step-3.7-flash': makeProvider('step-3.7-flash'),
      'deepseek-chat': makeProvider('deepseek-chat'),
    };
    mockState.order = ['mimo-ultraspeed', 'step-3.7-flash', 'deepseek-chat'];
    const captured = [];
    const chunks = [];
    const quoteText = [
      'var hq_str_gb_dji="DJI,51712.71,0.29,2026-06-22,148.01,51600,51800,51500";',
      'var hq_str_gb_ixic="NASDAQ,26166.60,-1.32,2026-06-22,-351.33,26500,26600,26000";',
      'var hq_str_gb_inx="S&P 500,7472.79,-0.37,2026-06-22,-27.79,7500,7520,7460";',
    ].join('\n');
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => Buffer.from(quoteText, 'utf8'),
    })));
    mockState.adapterFn = async function* ({ provider, messages, tools }) {
      mockState.adapterCalls.push(provider.id);
      captured.push({ messages, tools });
      yield { type: 'content', delta: '纳斯达克指数最新点位为 26166.60 点。' };
      yield { type: 'finish', reason: 'stop' };
    };

    const result = await run({
      messages: [{ role: 'user', content: '纳斯达克指数最新点位是多少？' }],
      onChunk: async (chunk, meta) => chunks.push({ ...chunk, meta }),
    });

    expect(result.ok).toBe(true);
    expect(result.providerId).toBe('step-3.7-flash');
    expect(mockState.adapterCalls).toEqual(['step-3.7-flash']);
    expect(chunks.some((chunk) => chunk.type === 'tool_progress' && chunk.name === 'stock_market' && chunk.event === 'end' && chunk.meta?.providerId === 'step-3.7-flash')).toBe(true);
    expect(captured[0]?.tools).toEqual([]);
    const promptText = captured[0]?.messages.map((message) => String(message.content || '')).join('\n') || '';
    expect(promptText).toContain('stock_market');
    expect(promptText).toContain('纳斯达克');
    expect(promptText).toContain('26166.60');
  });

  it('answers air quality prompts directly from weather evidence without provider inference', async () => {
    process.env.BRAIN_V2_DIRECT_WEATHER_PREFETCH = '1';
    mockState.order = ['p-step'];
    const chunks = [];
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        current: {
          time: '2026-06-23T07:00',
          us_aqi: 42,
          pm2_5: 9.5,
          pm10: 21,
        },
      }),
    })));
    mockState.adapterFn = async function* ({ provider }) {
      mockState.adapterCalls.push(provider.id);
      yield { type: 'content', delta: 'should not be called' };
    };

    const result = await run({
      messages: [{ role: 'user', content: '北京今天空气质量怎么样？' }],
      onChunk: async (chunk) => chunks.push(chunk),
    });

    expect(result.ok).toBe(true);
    expect(mockState.adapterCalls).toEqual([]);
    expect(chunks.some((chunk) => chunk.type === 'tool_progress' && chunk.name === 'weather' && chunk.event === 'end')).toBe(true);
    const visible = chunks.filter((chunk) => chunk.type === 'content').map((chunk) => chunk.delta).join('');
    expect(visible).toContain('北京当前空气质量');
    expect(visible).toContain('AQI(US): 42');
    expect(visible).toContain('PM2.5: 9.5');
  });

  it('answers direct forecast prompts from weather prefetch without DS planning tools', async () => {
    process.env.BRAIN_V2_DIRECT_WEATHER_PREFETCH = '1';
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-25T08:00:00.000Z'));
    mockState.order = ['p-step'];
    const chunks = [];
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        current_condition: [{
          temp_C: '29',
          FeelsLikeC: '33',
          lang_zh: [{ value: '多云' }],
          weatherDesc: [{ value: 'Cloudy' }],
          humidity: '78',
          winddir16Point: 'SE',
          windspeedKmph: '10',
          visibility: '10',
          precipMM: '0.0',
          uvIndex: '2',
        }],
        weather: [
          {
            date: '2026-06-25',
            mintempC: '27',
            maxtempC: '32',
            hourly: [{}, {}, {}, {}, { lang_zh: [{ value: '多云' }] }],
          },
          {
            date: '2026-06-26',
            mintempC: '28',
            maxtempC: '31',
            hourly: [{}, {}, {}, {}, { lang_zh: [{ value: '阴天' }] }],
          },
        ],
      }),
    })));
    mockState.adapterFn = async function* ({ provider }) {
      mockState.adapterCalls.push(provider.id);
      yield { type: 'content', delta: 'should not be called' };
    };

    try {
      const result = await run({
        messages: [{ role: 'user', content: '明天深圳天气如何' }],
        onChunk: async (chunk, meta) => chunks.push({ ...chunk, meta }),
      });

      expect(result.ok).toBe(true);
      expect(result.providerId).toBe('step-3.7-flash');
      expect(mockState.adapterCalls).toEqual([]);
      const toolEvents = chunks.filter((chunk) => chunk.type === 'tool_progress');
      expect(toolEvents.map((chunk) => chunk.name)).toEqual(['weather', 'weather']);
      expect(toolEvents.every((chunk) => chunk.meta?.providerId === 'step-3.7-flash')).toBe(true);
      expect(toolEvents.some((chunk) => chunk.name === 'parallel_research' || chunk.name === 'calendar')).toBe(false);
      const visible = chunks.filter((chunk) => chunk.type === 'content').map((chunk) => chunk.delta).join('');
      expect(visible).toContain('深圳明天天气：阴天，28~31°C');
      expect(visible).toContain('来源: weather 工具');
    } finally {
      vi.useRealTimers();
    }
  });

  it('summarizes weather fallback evidence with Step after skipping MiMo and DS planners', async () => {
    process.env.BRAIN_V2_DIRECT_WEATHER_PREFETCH = '1';
    process.env.ZHIPU_KEY = 'test-zhipu';
    mockState.providers = {
      'mimo-ultraspeed': makeProvider('mimo-ultraspeed'),
      'step-3.7-flash': makeProvider('step-3.7-flash'),
      'deepseek-chat': makeProvider('deepseek-chat'),
    };
    mockState.order = ['mimo-ultraspeed', 'step-3.7-flash', 'deepseek-chat'];
    const captured = [];
    const chunks = [];
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).startsWith('https://wttr.in/')) {
        return { ok: false, status: 503, json: async () => ({}) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          search_result: [{
            title: '杭州天气实况',
            link: 'https://weather.example/hangzhou',
            content: '杭州今天傍晚多云转阵雨，晚间可能有零星降雨，建议带伞。',
            publish_date: '2026-06-25',
          }],
        }),
        text: async () => '',
      };
    }));
    mockState.adapterFn = async function* ({ provider, messages, tools }) {
      mockState.adapterCalls.push(provider.id);
      captured.push({ messages, tools });
      yield { type: 'content', delta: '根据 weather 证据，杭州晚间可能有零星降雨，建议带伞。' };
      yield { type: 'finish', reason: 'stop' };
    };

    const result = await run({
      messages: [{ role: 'user', content: '杭州今晚天气要不要带伞？' }],
      onChunk: async (chunk, meta) => chunks.push({ ...chunk, meta }),
    });

    expect(result.ok).toBe(true);
    expect(result.providerId).toBe('step-3.7-flash');
    expect(mockState.adapterCalls).toEqual(['step-3.7-flash']);
    expect(chunks.some((chunk) => chunk.type === 'tool_progress' && chunk.name === 'weather' && chunk.event === 'end' && chunk.meta?.providerId === 'step-3.7-flash')).toBe(true);
    expect(captured[0]?.tools).toEqual([]);
    const promptText = captured[0]?.messages.map((message) => String(message.content || '')).join('\n') || '';
    expect(promptText).toContain('weather');
    expect(promptText).toContain('杭州今天傍晚多云转阵雨');
  });

  it('emits a deterministic grounded evidence answer when providers fail after generic tool evidence', async () => {
    stubSearchFetchOk();
    mockState.order = ['p-step', 'p-spark'];
    let stepRuns = 0;
    mockState.adapterFn = async function* ({ provider }) {
      mockState.adapterCalls.push(provider.id);
      if (provider.id === 'p-step') {
        stepRuns += 1;
        if (stepRuns === 1) {
          yield {
            type: 'tool_call_delta',
            delta: [{
              index: 0,
              id: 'tc-generic-evidence',
              type: 'function',
              function: { name: 'web_search', arguments: '{"query":"generic evidence smoke"}' },
            }],
          };
          yield { type: 'finish', reason: 'tool_calls' };
          return;
        }
      }
      throw new Error(`${provider.id} down`);
    };

    const chunks = [];
    const result = await run({
      messages: [{ role: 'user', content: '查一下 generic evidence smoke' }],
      onChunk: async (chunk) => chunks.push(chunk),
    });

    expect(result.ok).toBe(true);
    const visible = chunks.filter((chunk) => chunk.type === 'content').map((chunk) => chunk.delta).join('');
    expect(visible).toContain('根据本轮已执行工具返回的证据');
    expect(visible).toContain('web_search');
    expect(visible).toContain('search summary');
    expect(visible).not.toContain('all providers failed');
  });

  it('strips process preamble from evidence handoff synthesis without touching facts', async () => {
    process.env.BRAIN_V2_EVIDENCE_HANDOFF_AFTER = '3';
    stubSearchFetchOk();
    mockState.order = ['p-step', 'p-spark'];

    let stepRuns = 0;
    mockState.adapterFn = async function* ({ provider }) {
      if (provider.id === 'p-step') {
        stepRuns += 1;
        yield {
          type: 'tool_call_delta',
          delta: [{
            index: 0,
            id: `tc-process-${stepRuns}`,
            type: 'function',
            function: { name: 'web_search', arguments: `{"query":"q${stepRuns}"}` },
          }],
        };
        yield { type: 'finish', reason: 'tool_calls' };
        return;
      }
      yield { type: 'content', delta: '正在查询更多资料，请稍等——' };
      yield { type: 'content', delta: '根据现有证据，今晚共有 4 场比赛。' };
      yield { type: 'finish', reason: 'stop' };
    };

    const chunks = [];
    const result = await run({
      messages: [{ role: 'user', content: '今晚有几场' }],
      onChunk: async (chunk) => chunks.push(chunk),
    });

    expect(result).toMatchObject({ ok: true, providerId: 'p-spark' });
    const visible = chunks.filter((chunk) => chunk.type === 'content').map((chunk) => chunk.delta).join('');
    expect(visible).toBe('根据现有证据，今晚共有 4 场比赛。');
    expect(visible).not.toContain('正在查询');
    expect(visible).not.toContain('请稍等');
  });

  it('strips internal evidence-ledger leak text from grounded synthesis output', async () => {
    process.env.BRAIN_V2_EVIDENCE_HANDOFF_AFTER = '3';
    stubSearchFetchOk();
    mockState.order = ['p-step', 'p-spark'];

    let stepRuns = 0;
    mockState.adapterFn = async function* ({ provider }) {
      if (provider.id === 'p-step') {
        stepRuns += 1;
        yield {
          type: 'tool_call_delta',
          delta: [{
            index: 0,
            id: `tc-internal-ledger-${stepRuns}`,
            type: 'function',
            function: { name: 'web_search', arguments: `{"query":"q${stepRuns}"}` },
          }],
        };
        yield { type: 'finish', reason: 'tool_calls' };
        return;
      }
      yield { type: 'content', delta: '我已经拿到工具证据，但候选模型没有稳定完成最终总结。' };
      yield { type: 'content', delta: '先按证据账本回答：\n- provider: glm\n- 摘要: irrelevant\n' };
      yield { type: 'content', delta: '工具结果没有提供可核验日期，因此不能确认半决赛具体日期。' };
      yield { type: 'finish', reason: 'stop' };
    };

    const chunks = [];
    await run({
      messages: [{ role: 'user', content: '世界杯半决赛在哪一天？' }],
      onChunk: async (chunk) => chunks.push(chunk),
    });

    const visible = chunks.filter((chunk) => chunk.type === 'content').map((chunk) => chunk.delta).join('');
    expect(visible).toContain('工具结果没有提供可核验日期');
    expect(visible).not.toContain('候选模型');
    expect(visible).not.toContain('证据账本');
    expect(visible).not.toContain('provider:');
  });

  it('strips process sentences inside evidence handoff synthesis streams', async () => {
    process.env.BRAIN_V2_EVIDENCE_HANDOFF_AFTER = '3';
    stubSearchFetchOk();
    mockState.order = ['p-step', 'p-spark'];

    let stepRuns = 0;
    mockState.adapterFn = async function* ({ provider }) {
      if (provider.id === 'p-step') {
        stepRuns += 1;
        yield {
          type: 'tool_call_delta',
          delta: [{
            index: 0,
            id: `tc-process-middle-${stepRuns}`,
            type: 'function',
            function: { name: 'web_search', arguments: `{"query":"q${stepRuns}"}` },
          }],
        };
        yield { type: 'finish', reason: 'tool_calls' };
        return;
      }
      yield { type: 'content', delta: '证据显示日期口径不完全一致。让我重新确认一下今天准确的信息。' };
      yield { type: 'content', delta: '基于已返回证据，暂不能确认今天是否有暴雨预警。' };
      yield { type: 'finish', reason: 'stop' };
    };

    const chunks = [];
    await run({
      messages: [{ role: 'user', content: '查一下今天有没有预警' }],
      onChunk: async (chunk) => chunks.push(chunk),
    });

    const visible = chunks.filter((chunk) => chunk.type === 'content').map((chunk) => chunk.delta).join('');
    expect(visible).toContain('证据显示日期口径不完全一致。');
    expect(visible).toContain('基于已返回证据，暂不能确认今天是否有暴雨预警。');
    expect(visible).not.toContain('让我重新确认');
  });

  it('keeps normal opening facts in evidence handoff synthesis', async () => {
    process.env.BRAIN_V2_EVIDENCE_HANDOFF_AFTER = '3';
    stubSearchFetchOk();
    mockState.order = ['p-step', 'p-spark'];

    let stepRuns = 0;
    mockState.adapterFn = async function* ({ provider }) {
      if (provider.id === 'p-step') {
        stepRuns += 1;
        yield {
          type: 'tool_call_delta',
          delta: [{
            index: 0,
            id: `tc-fact-${stepRuns}`,
            type: 'function',
            function: { name: 'web_search', arguments: `{"query":"q${stepRuns}"}` },
          }],
        };
        yield { type: 'finish', reason: 'tool_calls' };
        return;
      }
      yield { type: 'content', delta: '现在北京时间 20:10，证据显示今晚有 4 场比赛。' };
      yield { type: 'finish', reason: 'stop' };
    };

    const chunks = [];
    await run({
      messages: [{ role: 'user', content: '今晚有几场' }],
      onChunk: async (chunk) => chunks.push(chunk),
    });

    const visible = chunks.filter((chunk) => chunk.type === 'content').map((chunk) => chunk.delta).join('');
    expect(visible).toBe('现在北京时间 20:10，证据显示今晚有 4 场比赛。');
  });

  it('falls back to serial tool execution with BRAIN_V2_TOOL_PARALLEL=1', async () => {
    process.env.BRAIN_V2_TOOL_PARALLEL = '1';
    stubSearchFetchOk();
    const capturedRounds = [];
    mockState.adapterFn = makeTwoToolThenContentAdapter(capturedRounds);

    const result = await run({
      messages: [{ role: 'user', content: 'search two things' }],
      onChunk: async () => {},
    });

    expect(result).toMatchObject({ ok: true, iterations: 2 });
    const round2Tools = capturedRounds[1].filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
    expect(round2Tools).toEqual(['tc-a', 'tc-b']);
  });

  it('summarizes structured and numbered web search results into inspectable sources', () => {
    const structured = __testing__.summarizeToolResult('web_search', JSON.stringify({
      ok: true,
      provider: 'bocha',
      summary: '官方文档摘要',
      items: [
        { title: 'StepFun Docs', url: 'https://platform.stepfun.com/docs/zh/api-reference/chat/messages-create', snippet: 'max_tokens controls generated output.' },
      ],
      sources: [
        { name: 'bocha', ok: true, summary: 'Bocha summary', items: [{ title: 'Pricing', url: 'https://platform.stepfun.com/pricing', snippet: 'Token plan pricing.' }] },
      ],
    }));
    expect(structured.summary).toContain('官方文档摘要');
    expect(structured.details).toEqual(expect.arrayContaining([
      expect.stringContaining('[StepFun Docs](https://platform.stepfun.com/docs/zh/api-reference/chat/messages-create)'),
      expect.stringContaining('[Pricing](https://platform.stepfun.com/pricing)'),
    ]));

    const numbered = __testing__.summarizeToolResult('web_search', [
      '── bocha ──',
      '1. StepFun API Reference',
      '   https://platform.stepfun.com/docs/zh/api-reference/responses/responses-create',
      '   Responses API supports streaming and function calling.',
    ].join('\n'));
    expect(numbered.summary).toContain('StepFun API Reference');
    expect(numbered.details).toEqual(expect.arrayContaining([
      expect.stringContaining('[StepFun API Reference](https://platform.stepfun.com/docs/zh/api-reference/responses/responses-create)'),
    ]));
  });

  it('compacts older server tool results before subsequent provider rounds', async () => {
    process.env.BRAIN_V2_TOOL_RESULT_CAP = '8';
    let adapterRuns = 0;
    const roundMessages = [];
    mockState.adapterFn = async function* ({ messages }) {
      adapterRuns += 1;
      roundMessages.push(messages);
      if (adapterRuns <= 3) {
        yield {
          type: 'tool_call_delta',
          delta: [{
            index: 0,
            id: `tc-${adapterRuns}`,
            type: 'function',
            function: { name: 'unit_convert', arguments: `{"query":"${adapterRuns * 100}公里"}` },
          }],
        };
        yield { type: 'finish', reason: 'tool_calls' };
        return;
      }
      yield { type: 'content', delta: 'done' };
      yield { type: 'finish', reason: 'stop' };
    };

    const result = await run({
      messages: [{ role: 'user', content: '连续换算' }],
      onChunk: async () => {},
    });

    expect(result).toMatchObject({ ok: true, iterations: 4 });
    const fourthRoundToolMessages = roundMessages[3].filter(m => m.role === 'tool');
    expect(fourthRoundToolMessages).toHaveLength(3);
    expect(fourthRoundToolMessages[0].content).toContain('[brain-v2:tool-result-compacted]');
    expect(fourthRoundToolMessages[1].content).toContain('[brain-v2:tool-result-compacted]');
    expect(fourthRoundToolMessages[2].content).toContain('【单位换算】');
    expect(fourthRoundToolMessages[2].content).not.toContain('[brain-v2:tool-result-compacted]');
  });

  it('does not inject a chain-tool hint by default when tools are present', async () => {
    let adapterMessages = null;
    mockState.adapterFn = async function* ({ messages }) {
      adapterMessages = messages;
      yield { type: 'content', delta: 'ok' };
      yield { type: 'finish', reason: 'stop' };
    };

    await run({ messages: [{ role: 'user', content: 'AAPL price times 100' }], tools: null, onChunk: async () => {} });

    expect(adapterMessages[0]).toMatchObject({ role: 'user' });
    expect(String(adapterMessages[0].content)).not.toContain('EXACT values returned by each tool');
  });

  it('feeds server tool results back without reinforcement wrappers', async () => {
    let adapterRuns = 0;
    const roundMessages = [];
    mockState.adapterFn = async function* ({ messages }) {
      adapterRuns += 1;
      roundMessages.push(messages);
      if (adapterRuns === 1) {
        yield {
          type: 'tool_call_delta',
          delta: [{
            index: 0,
            id: 'tc-chain-optout',
            type: 'function',
            function: { name: 'unit_convert', arguments: '{"query":"100公里"}' },
          }],
        };
        yield { type: 'finish', reason: 'tool_calls' };
        return;
      }
      yield { type: 'content', delta: 'ok' };
      yield { type: 'finish', reason: 'stop' };
    };

    await run({ messages: [{ role: 'user', content: '100公里是多少米' }], onChunk: async () => {} });

    expect(roundMessages[0][0]).toMatchObject({ role: 'user' });
    const toolMessage = roundMessages[1].find((message) => message.role === 'tool');
    expect(toolMessage.content).toContain('【单位换算】');
    expect(toolMessage.content).not.toContain('[Lynn tool step');
    expect(toolMessage.content).not.toContain('use these exact returned values');
  });

  it('preserves a caller-provided system prompt without adding another system prompt', async () => {
    let adapterMessages = null;
    mockState.adapterFn = async function* ({ messages }) {
      adapterMessages = messages;
      yield { type: 'content', delta: 'ok' };
      yield { type: 'finish', reason: 'stop' };
    };

    await run({
      messages: [{ role: 'system', content: 'caller system' }, { role: 'user', content: 'q' }],
      tools: null,
      onChunk: async () => {},
    });

    expect(adapterMessages[0].content).toBe('caller system');
    expect(String(adapterMessages[0].content)).not.toContain('EXACT values returned by each tool');
  });
});

describe('detectCapability', () => {
  it('detects vision from image_url content part', () => {
    const cap = detectCapability([{ role: 'user', content: [{ type: 'text', text: 'q' }, { type: 'image_url', image_url: { url: 'data:...' } }] }]);
    expect(cap.vision).toBe(true);
    expect(cap.audio).toBe(false);
    expect(cap.video).toBe(false);
  });
  it('detects audio from input_audio content part', () => {
    const cap = detectCapability([{ role: 'user', content: [{ type: 'input_audio', input_audio: {} }] }]);
    expect(cap.audio).toBe(true);
    expect(cap.video).toBe(false);
  });
  it('detects video from video_url content part', () => {
    const cap = detectCapability([{ role: 'user', content: [{ type: 'video_url', video_url: { url: 'https://x.mp4' } }] }]);
    expect(cap.video).toBe(true);
    expect(cap.vision).toBe(false);
    expect(cap.audio).toBe(false);
  });
  it('detects video from input_video content part', () => {
    const cap = detectCapability([{ role: 'user', content: [{ type: 'input_video', video_url: 'https://x.mp4' }] }]);
    expect(cap.video).toBe(true);
  });
  it('detects all three (mixed multimodal)', () => {
    const cap = detectCapability([{
      role: 'user',
      content: [
        { type: 'text', text: 'hi' },
        { type: 'image_url', image_url: { url: 'data:...' } },
        { type: 'input_audio', input_audio: {} },
        { type: 'video_url', video_url: { url: 'https://x.mp4' } },
      ],
    }]);
    expect(cap.vision).toBe(true);
    expect(cap.audio).toBe(true);
    expect(cap.video).toBe(true);
  });
  it('returns false for plain text', () => {
    const cap = detectCapability([{ role: 'user', content: 'just text' }]);
    expect(cap.vision).toBe(false);
    expect(cap.audio).toBe(false);
    expect(cap.video).toBe(false);
  });
  it('handles empty messages array', () => {
    expect(detectCapability([])).toEqual({ vision: false, audio: false, video: false });
    expect(detectCapability(null)).toEqual({ vision: false, audio: false, video: false });
  });
});

describe('router local probe helpers', () => {
  it('builds root health URLs for local llama.cpp endpoints', () => {
    expect(__testing__.buildLocalProbeUrl({
      endpoint: 'http://127.0.0.1:18098/v1',
      health_path: '/health',
    })).toBe('http://127.0.0.1:18098/health');
  });

  it('keeps relative probe paths under the OpenAI-compatible endpoint', () => {
    expect(__testing__.buildLocalProbeUrl({
      endpoint: 'http://127.0.0.1:18098/v1',
      health_path: 'models',
    })).toBe('http://127.0.0.1:18098/v1/models');
  });

  it('builds root slots URLs and summarizes llama.cpp slot busy state', () => {
    expect(__testing__.buildLocalSlotsUrl({
      endpoint: 'http://127.0.0.1:18098/v1',
    })).toBe('http://127.0.0.1:18098/slots');
    expect(__testing__.summarizeLocalSlots([
      { id: 0, is_processing: true },
      { id: 1, state: 'idle' },
    ])).toEqual({ total: 2, busy: 1 });
  });
});
