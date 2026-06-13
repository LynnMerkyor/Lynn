// Brain v2 · Router tests (vi.mock provider-registry + wire-adapter for hermetic DI)
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// hoisted shared mock state
const mockState = vi.hoisted(() => ({
  cooldown: new Set(),
  providers: {},
  adapterFn: null,
  adapterCalls: [],
}));

vi.mock('../provider-registry.js', () => ({
  universalOrder: ['p-step', 'p-spark', 'p-cloud', 'p-vision'],
  providerOrderForCapability: (capabilityRequired) => (
    capabilityRequired?.vision || capabilityRequired?.audio || capabilityRequired?.video
      ? ['p-vision', 'p-step', 'p-spark', 'p-cloud']
      : ['p-step', 'p-spark', 'p-cloud', 'p-vision']
  ),
  getProvider: (id) => mockState.providers[id] || null,
  isInCooldown: (id) => mockState.cooldown.has(id),
  markUnhealthy: (id, reason) => mockState.cooldown.add(id),
  clearUnhealthy: (id) => mockState.cooldown.delete(id),
  PROVIDERS: mockState.providers,
}));

vi.mock('../wire-adapter/index.js', () => ({
  getAdapter: () => mockState.adapterFn,
  ADAPTERS: {},
}));

import { run, detectCapability, __testing__ } from '../router.js';

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
  mockState.adapterCalls = [];
  mockState.adapterFn = null;
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
  delete process.env.BRAIN_V2_TOOL_PARALLEL;
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
    json: async () => ({ choices: [{ message: { content: 'search summary' } }] }),
    text: async () => '',
  }));
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
  it('retries once with reduced reasoning when a turn overflows (finish=length, empty answer)', async () => {
    const reasoningSeen = [];
    let call = 0;
    mockState.adapterFn = async function* ({ provider, reasoningEffort }) {
      mockState.adapterCalls.push(provider.id);
      reasoningSeen.push(reasoningEffort ?? null);
      call += 1;
      if (call === 1) {
        // overflow mid-reasoning: reasoning streamed, no content, finish=length
        yield { type: 'reasoning', delta: 'thinking…' };
        yield { type: 'finish', reason: 'length' };
      } else {
        // retry produces a real answer
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
    // length-overflow with empty answer → retried once on the same provider
    expect(mockState.adapterCalls).toEqual(['p-step', 'p-step']);
    // reasoning stepped high → medium on the retry
    expect(reasoningSeen[0]).toBe('high');
    expect(reasoningSeen[1]).toBe('medium');
    // the retry's answer reached the client
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
  });

  it('falls back on HTTP 429 rate limit and cools down the limited provider', async () => {
    let callIdx = 0;
    const chunks = [];
    mockState.adapterFn = async function* ({ provider }) {
      mockState.adapterCalls.push(provider.id);
      callIdx++;
      if (callIdx === 1) throw new Error('p-step HTTP 429: rate limited');
      yield { type: 'content', delta: 'fallback after rate limit' };
      yield { type: 'finish', reason: 'stop' };
    };

    const r = await run({
      messages: [{ role: 'user', content: 'q' }],
      onChunk: async c => chunks.push(c),
    });

    expect(r.providerId).toBe('p-spark');
    expect(mockState.adapterCalls).toEqual(['p-step', 'p-spark']);
    expect(mockState.cooldown.has('p-step')).toBe(true);
    expect(chunks.find((c) => c.type === 'content')?.delta).toBe('fallback after rate limit');
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
      { id: 'p-spark', reason: 'local-busy' },
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
    process.env.MIMO_SEARCH_KEY = 'test-mimo';
    mockState.cooldown.add('p-step');
    mockState.providers['p-spark'] = makeProvider('p-spark', { native_search: false });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({
        choices: [{
          message: {
            content: '杭州今日有小雨。',
            annotations: [{ type: 'url_citation', title: 'weather', url: 'https://weather.example', summary: 'rain' }],
          },
        }],
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
        { role: 'user', content: '今天天气怎么样' },
      ],
      onChunk: async (chunk, meta) => {
        chunks.push(chunk);
        metas.push(meta);
      },
    });

    expect(result.providerId).toBe('p-spark');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(chunks.map(c => c.type)).toEqual(['pre_search', 'content']);
    expect(chunks[0]).toMatchObject({ source: 'mimo', hit: true, cached: null });
    expect(metas[0].fallback_from).toEqual([{ id: 'p-step', reason: 'cooldown' }]);
    expect(adapterMessages).toHaveLength(5);
    expect(adapterMessages.map(m => m.role)).toEqual(['system', 'user', 'assistant', 'user', 'user']);
    expect(adapterMessages.filter(m => m.role === 'system')).toHaveLength(1);
    expect(adapterMessages[0].content).toBe('persona must stay at prefix');
    expect(adapterMessages[3].role).toBe('user');
    expect(String(adapterMessages[3].content)).toContain('<lynn_runtime_frame');
    expect(String(adapterMessages[3].content)).toContain('【实时信息上下文】');
    expect(adapterMessages[4].role).toBe('user');
    expect(adapterMessages[4].content).toBe('今天天气怎么样');
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
          choices: [{
            message: {
              content: 'Zhipu summary',
              tool_calls: [{ type: 'web_search', web_search: { search_result: [{ title: 'A', link: 'https://a.example', content: 'a snippet' }] } }],
            },
          }],
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
    expect(end).toMatchObject({ name: 'web_search', ok: true });
    expect(end.summary).toContain('Zhipu summary');
    expect(end.summary).toContain('MiMo summary');
    expect(end.details).toEqual(expect.arrayContaining([
      expect.stringContaining('Zhipu summary'),
      expect.stringContaining('[A](https://a.example)'),
      expect.stringContaining('[B](https://b.example)'),
    ]));
  });

  it('retries once when a round is reasoning-only with finish=stop (思考完不说话)', async () => {
    // 2026-06-10 用户实测:工具轮后模型只出 reasoning 就正常收流,正文为空 → GUI 静默无反馈。
    const reasoningSeen = [];
    let call = 0;
    mockState.adapterFn = async function* ({ reasoningEffort }) {
      reasoningSeen.push(reasoningEffort ?? null);
      call += 1;
      if (call === 1) {
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
    expect(reasoningSeen).toEqual(['high', 'medium']); // 重试降一档
    expect(chunks.some((c) => c.type === 'content' && /最终答案/.test(c.delta))).toBe(true);
  });

  it('does NOT retry a plain empty stop without reasoning (kept pass-through)', async () => {
    let call = 0;
    mockState.adapterFn = async function* () {
      call += 1;
      yield { type: 'finish', reason: 'stop' }; // 无 reasoning 无 content —— 维持 BYOK 透传语义
    };
    const r = await run({ messages: [{ role: 'user', content: 'x' }], onChunk: async () => {} });
    expect(r).toMatchObject({ ok: true, iterations: 1 });
    expect(call).toBe(1);
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

  it('runs independent server tools concurrently and feeds results back in original call order', async () => {
    process.env.ZHIPU_KEY = 'test-zhipu';
    process.env.MIMO_SEARCH_KEY = 'test-mimo';
    // Concurrency barrier: each web_search issues 2 source fetches (zhipu+mimo). With both tools
    // in flight at once there are 4 pending fetches; serial execution would stall at 2 and the
    // barrier would only release via the (failing) fallback timer.
    const pending = [];
    let sawParallelBarrier = false;
    const okPayload = { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'search summary' } }] }), text: async () => '' };
    const flush = () => { while (pending.length) pending.shift()(okPayload); };
    const fallbackTimer = setTimeout(flush, 1500);
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => {
      pending.push(resolve);
      if (pending.length >= 4) {
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
      expect(message.content).toContain('请只基于上方工具证据回答当前事实');
      expect(message.content).toContain('不要用旧知识或记忆补充工具证据里没有的具体事实');
      expect(message.content).toContain('The user wants');
    }
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
