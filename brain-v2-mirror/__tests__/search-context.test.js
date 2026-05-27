// Brain v2 · Search Context Broker tests
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { applySearchContext, createSearchRequestCache, classifyForSearch, __testing__ } from '../search-context.js';
import { mockFetch, ok } from './helpers.js';

const providerSpark = {
  id: 'apex-spark-i-balanced',
  endpoint: 'http://127.0.0.1:18098/v1',
  apiKey: 'none',
  model: 'qwen36-35b-a3b-apex-mtp',
  capability: { vision: false, audio: false, tools: true, thinking: true, native_search: false },
  wire: 'openai',
};

const providerMimo = {
  id: 'mimo',
  endpoint: 'https://example.com/v1',
  apiKey: 'k',
  model: 'mimo-v2.5-pro',
  capability: { vision: false, audio: false, tools: true, thinking: true, native_search: true },
  wire: 'mimo',
};

const msgsTime = [{ role: 'user', content: '今天的股价怎么样' }];
const msgsCode = [{ role: 'user', content: '帮我写一个快速排序函数' }];
const msgsStale = [{ role: 'user', content: '什么是函数式编程' }];

function mockMimoResponse(text = '【MiMo 摘要】今日 A 股小幅震荡') {
  // searchMimo() 调用 chat/completions(非 stream),返回 { choices:[{ message:{ content, annotations:[...]} }] }
  const body = {
    choices: [
      {
        message: {
          content: text,
          annotations: [
            { type: 'url_citation', title: '财经', url: 'https://x', summary: 'snippet' },
          ],
        },
      },
    ],
  };
  return ok({
    async *[Symbol.asyncIterator]() { /* not used in non-stream path */ },
    // searchMimo uses resp.json() not body iteration
  });
}

// searchMimo 用 resp.json(),所以 mock 时要在 ok() 上加 json
function mockMimoJson(payload) {
  return {
    ok: true,
    status: 200,
    text: async () => '',
    json: async () => payload,
  };
}

function mimoJsonResponse(content = '【MiMo 摘要】') {
  return mockMimoJson({
    choices: [
      {
        message: {
          content,
          annotations: [{ type: 'url_citation', title: 't', url: 'https://x', summary: 's' }],
        },
      },
    ],
  });
}

describe('classifyForSearch', () => {
  it('hits on time-sensitive keywords (zh)', () => {
    expect(classifyForSearch('今天天气怎么样').hit).toBe(true);
    expect(classifyForSearch('特斯拉最新股价').hit).toBe(true);
    expect(classifyForSearch('最近的新闻动态').hit).toBe(true);
  });

  it('hits on en time keywords', () => {
    expect(classifyForSearch('what is the current stock price of NVDA').hit).toBe(true);
    expect(classifyForSearch('latest news on AI').hit).toBe(true);
  });

  it('excludes code work even if a trigger word leaks in', () => {
    expect(classifyForSearch('帮我写一个最新版本的排序函数').hit).toBe(false);
    expect(classifyForSearch('debug this function').hit).toBe(false);
  });

  it('excludes translation', () => {
    expect(classifyForSearch('请把今天的天气翻译成英文').hit).toBe(false);
  });

  it('excludes math / solve', () => {
    expect(classifyForSearch('计算这个积分').hit).toBe(false);
    expect(classifyForSearch('solve this equation').hit).toBe(false);
  });

  it('excludes file ops', () => {
    expect(classifyForSearch('帮我读取这个文件').hit).toBe(false);
    expect(classifyForSearch('open this file please').hit).toBe(false);
  });

  it('rejects too-short / too-long input', () => {
    expect(classifyForSearch('').hit).toBe(false);
    expect(classifyForSearch('嗯').hit).toBe(false);
    expect(classifyForSearch('a'.repeat(3000)).hit).toBe(false);
  });

  it('returns no-trigger for ordinary general questions', () => {
    expect(classifyForSearch('什么是函数式编程').hit).toBe(false);
    expect(classifyForSearch('给我讲讲量子力学').hit).toBe(false);
  });
});

describe('applySearchContext — gating', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    __testing__.lru.clear();
    delete process.env.BRAIN_V2_PRE_SEARCH;
    delete process.env.MIMO_SEARCH_KEY;
  });

  it('skips when flag is off', async () => {
    process.env.MIMO_SEARCH_KEY = 'k';
    const r = await applySearchContext({ messages: msgsTime, provider: providerSpark, requestCache: createSearchRequestCache() });
    expect(r.meta.applied).toBe(false);
    expect(r.meta.skipReason).toBe('flag-off');
    expect(r.messages).toBe(msgsTime);
  });

  it('skips on native_search provider (mimo)', async () => {
    process.env.BRAIN_V2_PRE_SEARCH = '1';
    process.env.MIMO_SEARCH_KEY = 'k';
    const r = await applySearchContext({ messages: msgsTime, provider: providerMimo, requestCache: createSearchRequestCache() });
    expect(r.meta.applied).toBe(false);
    expect(r.meta.skipReason).toBe('provider-native-search');
  });

  it('skips when no MIMO_SEARCH_KEY', async () => {
    process.env.BRAIN_V2_PRE_SEARCH = '1';
    const r = await applySearchContext({ messages: msgsTime, provider: providerSpark, requestCache: createSearchRequestCache() });
    expect(r.meta.applied).toBe(false);
    expect(r.meta.skipReason).toBe('no-mimo-key');
  });

  it('skips on code / non-trigger user message', async () => {
    process.env.BRAIN_V2_PRE_SEARCH = '1';
    process.env.MIMO_SEARCH_KEY = 'k';
    const r1 = await applySearchContext({ messages: msgsCode, provider: providerSpark, requestCache: createSearchRequestCache() });
    expect(r1.meta.applied).toBe(false);
    expect(r1.meta.skipReason).toBe('excluded');
    const r2 = await applySearchContext({ messages: msgsStale, provider: providerSpark, requestCache: createSearchRequestCache() });
    expect(r2.meta.applied).toBe(false);
    expect(r2.meta.skipReason).toBe('no-trigger');
  });

  it('skips when no user message', async () => {
    process.env.BRAIN_V2_PRE_SEARCH = '1';
    process.env.MIMO_SEARCH_KEY = 'k';
    const r = await applySearchContext({ messages: [{ role: 'system', content: 'hi' }], provider: providerSpark, requestCache: createSearchRequestCache() });
    expect(r.meta.applied).toBe(false);
    expect(r.meta.skipReason).toBe('no-user-msg');
  });
});

describe('applySearchContext — applied path', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    __testing__.lru.clear();
    process.env.BRAIN_V2_PRE_SEARCH = '1';
    process.env.MIMO_SEARCH_KEY = 'k';
  });
  afterEach(() => {
    delete process.env.BRAIN_V2_PRE_SEARCH;
    delete process.env.MIMO_SEARCH_KEY;
  });

  it('calls MiMo on cache miss and injects system context before last user message', async () => {
    const f = mockFetch(mimoJsonResponse('A 股小幅震荡'));
    const cache = createSearchRequestCache();
    const r = await applySearchContext({ messages: msgsTime, provider: providerSpark, requestCache: cache });
    expect(f).toHaveBeenCalledTimes(1);
    expect(r.meta.applied).toBe(true);
    expect(r.meta.source).toBe('mimo');
    expect(r.meta.cached).toBe(null);
    expect(r.messages).not.toBe(msgsTime);
    expect(r.messages.length).toBe(msgsTime.length + 1);
    const injected = r.messages[r.messages.length - 2];
    expect(injected.role).toBe('system');
    expect(String(injected.content)).toContain('【实时信息上下文】');
    expect(String(injected.content)).toContain('忽略');
    expect(String(injected.content)).toContain('A 股小幅震荡');
  });

  it('request cache: 2nd call same request reuses without hitting MiMo', async () => {
    const f = mockFetch(mimoJsonResponse('foo'));
    const cache = createSearchRequestCache();
    await applySearchContext({ messages: msgsTime, provider: providerSpark, requestCache: cache });
    const r2 = await applySearchContext({ messages: msgsTime, provider: providerSpark, requestCache: cache });
    expect(f).toHaveBeenCalledTimes(1);
    expect(r2.meta.applied).toBe(true);
    expect(r2.meta.cached).toBe('request');
  });

  it('LRU cache: new request reuses across requests within 5min', async () => {
    const f = mockFetch(mimoJsonResponse('bar'));
    const c1 = createSearchRequestCache();
    await applySearchContext({ messages: msgsTime, provider: providerSpark, requestCache: c1 });
    expect(f).toHaveBeenCalledTimes(1);
    const c2 = createSearchRequestCache();
    const r2 = await applySearchContext({ messages: msgsTime, provider: providerSpark, requestCache: c2 });
    expect(f).toHaveBeenCalledTimes(1); // still 1, LRU hit
    expect(r2.meta.cached).toBe('lru');
  });

  it('search failure does NOT block — returns original messages with meta.applied=false', async () => {
    mockFetch({ ok: false, status: 500, text: async () => 'oops', json: async () => ({}) });
    const cache = createSearchRequestCache();
    const r = await applySearchContext({ messages: msgsTime, provider: providerSpark, requestCache: cache, log: () => {} });
    expect(r.meta.applied).toBe(false);
    expect(r.meta.skipReason).toBe('search-failed');
    expect(r.messages).toBe(msgsTime);
  });

  it('empty result from MiMo → applied=false, original messages', async () => {
    mockFetch(mockMimoJson({ choices: [{ message: { content: '', annotations: [] } }] }));
    const cache = createSearchRequestCache();
    const r = await applySearchContext({ messages: msgsTime, provider: providerSpark, requestCache: cache, log: () => {} });
    expect(r.meta.applied).toBe(false);
    expect(r.messages).toBe(msgsTime);
  });

  it('keeps last user message at the end after injection', async () => {
    mockFetch(mimoJsonResponse('snippet'));
    const cache = createSearchRequestCache();
    const messages = [
      { role: 'system', content: 'persona' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: '今天的天气' },
    ];
    const r = await applySearchContext({ messages, provider: providerSpark, requestCache: cache });
    expect(r.meta.applied).toBe(true);
    // injected system is at index 3, last user pushed to 4
    expect(r.messages[3].role).toBe('system');
    expect(String(r.messages[3].content)).toContain('【实时信息上下文】');
    expect(r.messages[4].role).toBe('user');
    expect(r.messages[4].content).toBe('今天的天气');
  });
});
