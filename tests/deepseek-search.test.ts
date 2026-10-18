import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchDeepSeek } from '../shared/deepseek-search.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const result = { title: '大良', url: 'https://example.org/forecast', summary: '完整摘要', snippet: '短摘要', date: '2026-10-18T00:00:00Z', authority: 3, rerank_score: 2.4 };

describe('DeepSeek search transport', () => {
  it('preserves model query, dates and source metadata without a model call', async () => {
    const mock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: [result] })));
    vi.stubGlobal('fetch', mock);
    const query = '顺德大良 2026-10-19 夜间 site:nmc.cn';
    const items = await searchDeepSeek(query, 5, 'test-query');
    expect(JSON.parse(mock.mock.calls[0][1].body)).toEqual({ query, count: 5, need_content: false });
    expect(items[0]).toMatchObject({ ...result, snippet: result.summary });
    expect(items[0].retrievedAt).toBeTruthy();
  });
  it('rejects overlong queries without truncating or calling the provider', async () => {
    const mock = vi.fn(); vi.stubGlobal('fetch', mock);
    await expect(searchDeepSeek('德'.repeat(129), 5, 'test-long')).rejects.toThrow('1–128');
    expect(mock).not.toHaveBeenCalled();
  });
  it('counts Unicode characters rather than UTF16 units', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: [result] }))));
    await expect(searchDeepSeek('🌧'.repeat(128), 5, 'test-unicode')).resolves.toHaveLength(1);
  });
  it.each([0, 51, 1.5, NaN])('rejects invalid result count %s', async count => {
    await expect(searchDeepSeek('天气', count, 'test-count')).rejects.toThrow('integer');
  });
  it.each([401, 402, 429, 503])('reports HTTP %s without echoing upstream secrets or retrying', async status => {
    const mock = vi.fn().mockResolvedValue(new Response('secret upstream body', { status }));
    vi.stubGlobal('fetch', mock);
    await expect(searchDeepSeek('天气', 5, `test-error-${status}`)).rejects.toThrow(`HTTP ${status}`);
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it('filters unsafe links, duplicates and empty evidence', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: [result, result, { ...result, url: 'javascript:alert(1)' }, { ...result, url: 'https://user:password@example.org/' }, { title: 'empty', url: 'https://example.org/empty' }] }))));
    await expect(searchDeepSeek('天气', 5, 'test-links')).resolves.toHaveLength(1);
  });
  it('rejects empty results', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"results":[]}')));
    await expect(searchDeepSeek('天气', 5, 'test-empty')).rejects.toThrow('no usable');
  });
  it('does not issue requests after cancellation', async () => {
    const mock = vi.fn(); vi.stubGlobal('fetch', mock);
    await expect(searchDeepSeek('天气', 5, 'test-abort', AbortSignal.abort())).rejects.toThrow();
    expect(mock).not.toHaveBeenCalled();
  });
  it('keeps the deadline active while reading the response body', async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => ({
      ok: true,
      json: () => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })),
    })));
    const pending = searchDeepSeek('天气', 5, 'test-body-timeout');
    const rejection = expect(pending).rejects.toThrow('body stalled');
    await Promise.resolve();
    controller.abort(new Error('body stalled'));
    await rejection;
    expect(timeout).toHaveBeenCalledWith(10000);
  });
});
