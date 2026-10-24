import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebSearchTool, initWebSearch, runSearchQuery, searchBingHtml, verifySearchKey } from '../lib/tools/web-search.js';
import { loadLocale } from '../server/i18n.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let config: { provider?: string; api_key?: string } = {};
const item = { title: '大良街道', url: 'https://example.org/daliang', summary: '夜间数据，应核对目标日期', date: '2026-10-19T00:00:00Z' };
const cloud = () => new Response(JSON.stringify({ ok: true, provider: 'deepseek', items: [{ ...item, snippet: item.summary, retrievedAt: '2026-10-18T00:00:00Z' }], summary: item.summary, sources: [{ name: 'deepseek', ok: true, items: [item] }] }));
beforeEach(() => {
  config = {};
  initWebSearch('', { searchConfigResolver: () => config });
  loadLocale('zh');
  vi.stubEnv('BRAIN_V2_URL', 'http://127.0.0.1:8790');
  vi.stubEnv('LYNN_DISABLE_BRAIN_SEARCH', '0');
});
afterEach(() => { config = {}; vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function fakeDeadlines() {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('Search timed out', 'TimeoutError')), milliseconds);
    return controller.signal;
  });
}

describe('client search routing independent of model BYOK', () => {
  it('does not start a request for an already cancelled tool', async () => {
    const controller = new AbortController(); controller.abort(new Error('User stopped'));
    const mock = vi.fn(); vi.stubGlobal('fetch', mock);
    await expect(createWebSearchTool().execute('cancel', { query: 'test' }, { signal: controller.signal })).rejects.toThrow('User stopped');
    expect(mock).not.toHaveBeenCalled();
  });
  it('cancels an in-flight provider without starting fallback providers', async () => {
    config = { provider: 'deepseek', api_key: 'test-cancellation' };
    const controller = new AbortController();
    const mock = vi.fn().mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }));
    vi.stubGlobal('fetch', mock);
    const pending = runSearchQuery('test', 5, { signal: controller.signal });
    const assertion = expect(pending).rejects.toThrow('User stopped');
    controller.abort(new Error('User stopped'));
    await assertion;
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it('times out an HTML response body after ten seconds', async () => {
    fakeDeadlines();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url, options) => ({
      ok: true, status: 200,
      text: () => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })),
    })));
    const assertion = expect(searchBingHtml('test', 5)).rejects.toThrow('Search timed out');
    await vi.advanceTimersByTimeAsync(10000);
    await assertion;
  });
  it('bounds the full provider and fallback chain to thirty seconds', async () => {
    fakeDeadlines();
    config = { provider: 'tavily', api_key: 'test-budget' };
    const mock = vi.fn().mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }));
    vi.stubGlobal('fetch', mock);
    const assertion = expect(runSearchQuery('ordinary query')).rejects.toThrow('Search timed out');
    await vi.advanceTimersByTimeAsync(30000);
    await assertion;
    expect(mock).toHaveBeenCalledTimes(3);
  });
  it('sends extractive evidence only once while retaining dates and links', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(cloud()));
    const answer = await createWebSearchTool().execute('search', { query: 'test' });
    const body = answer.content[0].text;
    expect(body.split(item.summary).length - 1).toBe(1);
    expect(body).toContain(item.date);
    expect(body).toContain(item.url);
  });
  it('aborts a stalled cloud response body and continues to a fallback', async () => {
    vi.useFakeTimers();
    let cloudSignal: AbortSignal | undefined;
    const mock = vi.fn().mockImplementation(async (url, options) => {
      if (String(url).includes('/v1/web-search')) {
        cloudSignal = options.signal;
        return {
          ok: true,
          status: 200,
          json: () => new Promise((resolve, reject) => {
            cloudSignal!.addEventListener('abort', () => reject(new Error('Response body timed out')), { once: true });
          }),
        };
      }
      return new Response('<a class="result__a" href="https://example.org/fallback">Fallback evidence</a>');
    });
    vi.stubGlobal('fetch', mock);
    const pending = runSearchQuery('ordinary query');
    await vi.advanceTimersByTimeAsync(13999);
    expect(cloudSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(cloudSignal?.aborted).toBe(true);
    expect((await pending).provider).toBe('duckduckgo-html');
  });
  it('never combines a new provider with a legacy configuration key', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lynn-search-config-'));
    try {
      const file = path.join(directory, 'config.yaml');
      fs.writeFileSync(file, 'search:\n  provider: tavily\n  api_key: legacy-secret\n');
      config = { provider: 'deepseek' };
      initWebSearch(file, { searchConfigResolver: () => config });
      const mock = vi.fn().mockResolvedValue(cloud()); vi.stubGlobal('fetch', mock);
      expect((await runSearchQuery('普通新闻')).provider).toBe('lynn-brain/deepseek');
      expect(mock).toHaveBeenCalledTimes(1);
      expect(String(mock.mock.calls[0][0])).not.toContain('api.deepseek.com');
      expect(JSON.stringify(mock.mock.calls)).not.toContain('legacy-secret');
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  it('uses cloud by default without a client DeepSeek key and preserves the query', async () => {
    const mock = vi.fn().mockResolvedValue(cloud()); vi.stubGlobal('fetch', mock);
    const query = '明天晚上顺德大良天气 site:nmc.cn';
    const answer = await runSearchQuery(query, 5);
    expect(answer.provider).toBe('lynn-brain/deepseek');
    expect(JSON.parse(mock.mock.calls[0][1].body).query).toBe(query);
    expect(mock.mock.calls[0][1].headers.Authorization).toBeUndefined();
    expect(answer.results[0].date).toBe(item.date);
  });
  it('prefers explicitly configured DeepSeek search BYOK over the cloud', async () => {
    config = { provider: 'deepseek', api_key: 'test-client-own' };
    const mock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: [item] })));
    vi.stubGlobal('fetch', mock);
    const query = '顺德大良 2026-10-19 夜间';
    const answer = await runSearchQuery(query);
    expect(answer.provider).toBe('deepseek');
    expect(mock.mock.calls[0][0]).toBe('https://api.deepseek.com/v1/tools/search');
    expect(JSON.parse(mock.mock.calls[0][1].body).query).toBe(query);
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it('falls back to cloud without forwarding the user search key', async () => {
    config = { provider: 'deepseek', api_key: 'test-client-failure' };
    const mock = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 429 })).mockResolvedValueOnce(cloud());
    vi.stubGlobal('fetch', mock);
    expect((await runSearchQuery('普通新闻查询')).provider).toBe('lynn-brain/deepseek');
    expect(mock).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(mock.mock.calls[1][1])).not.toContain(config.api_key);
  });
  it('returns to cloud when the provider is cleared even if an old key remains saved', async () => {
    config = { provider: '', api_key: 'test-inactive-key' };
    const mock = vi.fn().mockResolvedValue(cloud()); vi.stubGlobal('fetch', mock);
    expect((await runSearchQuery('普通新闻查询')).provider).toBe('lynn-brain/deepseek');
    expect(JSON.stringify(mock.mock.calls[0][1])).not.toContain(config.api_key);
  });
  it('shows source dates and full summaries to the model', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(cloud()));
    const answer = await createWebSearchTool().execute('search', { query: '顺德大良天气' });
    expect(answer.content[0].text).toContain(item.date);
    expect(answer.content[0].text).toContain(item.summary);
  });
  it('verifies user credentials using search rather than a chat model', async () => {
    const mock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: [item] })));
    vi.stubGlobal('fetch', mock);
    expect(await verifySearchKey('deepseek', 'test-verification')).toBe(true);
    expect(mock.mock.calls[0][0]).toBe('https://api.deepseek.com/v1/tools/search');
  });
  it('labels missing publication dates rather than substituting retrieval time', async () => {
    const response = new Response(JSON.stringify({ ok: true, provider: 'deepseek', items: [{ ...item, date: undefined, snippet: item.summary, retrievedAt: '2026-10-24T09:00:00Z' }] }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    const answer = await createWebSearchTool().execute('search', { query: 'recent event date' });
    expect(answer.content[0].text).toContain('Published: unknown');
    expect(answer.content[0].text).toContain('retrieval time only; not publication or event time');
  });
});
