import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webSearch, webSearchStructured, __testing__ } from '../tool-exec/web_search.js';

const row = { title: '大良街道', url: 'https://example.org/daliang', summary: '夜间预报须核对日期', date: '2026-10-18T00:00:00Z' };
beforeEach(() => {
  vi.stubEnv('DEEPSEEK_SEARCH_KEY', 'test-cloud-' + Math.random());
  vi.stubEnv('WEB_SEARCH_PRIMARY_PROVIDER', 'deepseek');
  vi.stubEnv('ZHIPU_KEY', 'test-zhipu');
  __testing__.cache.clear(); __testing__.structuredCache.clear();
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('cloud DeepSeek primary search', () => {
  it('does not start cloud search when the caller already cancelled', async () => {
    const controller = new AbortController(); controller.abort(new Error('User stopped'));
    const mock = vi.fn(); vi.stubGlobal('fetch', mock);
    await expect(webSearch('test', { signal: controller.signal })).rejects.toThrow('User stopped');
    expect(mock).not.toHaveBeenCalled();
  });
  it('aborts the upstream request without starting cloud fallbacks', async () => {
    const controller = new AbortController();
    const mock = vi.fn().mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }));
    vi.stubGlobal('fetch', mock);
    const pending = webSearchStructured('test', { signal: controller.signal });
    const assertion = expect(pending).rejects.toThrow('User stopped');
    controller.abort(new Error('User stopped'));
    await assertion;
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it('uses DeepSeek first even for explicit source links and preserves compound place', async () => {
    const mock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: [row] })));
    vi.stubGlobal('fetch', mock);
    const query = '顺德大良明天晚上天气 给我来源链接';
    const answer = await webSearchStructured(query);
    expect(answer.provider).toBe('deepseek');
    expect(answer.query).toBe(query);
    expect(JSON.parse(mock.mock.calls[0][1].body).query).toBe(query);
    expect(answer.summary).toContain(row.date);
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it('returns model-readable sources through the text tool path', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: [row] }))));
    const answer = await webSearch('顺德大良明天晚上天气');
    expect(answer).toContain('provider: deepseek');
    expect(answer).toContain(row.url);
    expect(answer.split(row.summary).length - 1).toBe(1);
    expect(answer).toContain(row.date);
  });
  it('falls back after rate limiting and preserves the failure trace', async () => {
    const mock = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 429 })).mockResolvedValueOnce(new Response(JSON.stringify({ search_result: [{ title: 'fallback', link: 'https://example.org/fallback', content: 'fallback evidence' }] })));
    vi.stubGlobal('fetch', mock);
    const answer = await webSearchStructured('ordinary test query');
    expect(answer.provider).toBe('glm');
    expect(answer.sources[0]).toMatchObject({ name: 'deepseek', ok: false, error: 'DeepSeek Search HTTP 429' });
    expect(mock).toHaveBeenCalledTimes(2);
  });
  it('does not present retrieval time as publication or event evidence', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: [{ ...row, date: undefined }] }))));
    const answer = await webSearch('recent event date');
    expect(answer).toContain('Published: unknown');
    expect(answer).toContain('retrieval time only; not publication or event time');
  });
  it('rejects an overlong model query without any provider requests', async () => {
    const mock = vi.fn(); vi.stubGlobal('fetch', mock);
    expect((await webSearchStructured('德'.repeat(129))).ok).toBe(false);
    expect(mock).not.toHaveBeenCalled();
  });
  it('honors an explicit alternate primary provider', async () => {
    vi.stubEnv('WEB_SEARCH_PRIMARY_PROVIDER', 'glm');
    const mock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ search_result: [{ title: 'fallback', link: 'https://example.org/fallback', content: 'fallback evidence' }] })));
    vi.stubGlobal('fetch', mock);
    expect((await webSearchStructured('ordinary query')).provider).toBe('glm');
    expect(String(mock.mock.calls[0][0])).toContain('bigmodel.cn');
  });
});
