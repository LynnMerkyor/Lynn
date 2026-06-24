import { describe, it, expect, beforeEach, vi } from 'vitest';

process.env.ZHIPU_KEY = 'test-zhipu';
process.env.MIMO_SEARCH_KEY = 'test-mimo';
delete process.env.BOCHA_KEY;
delete process.env.TAVILY_KEY;
delete process.env.SERPER_KEY;

const { webSearch, webSearchStructured, __testing__ } = await import('../tool-exec/web_search.js');

function jsonResp(obj, status = 200) {
  return { ok: status === 200, status, json: async () => obj, text: async () => JSON.stringify(obj) };
}

function mimoResp(summary = 'MiMo summary', url = 'http://m') {
  return jsonResp({
    choices: [{
      message: {
        content: summary,
        annotations: [{ type: 'url_citation', title: 'M', url, summary: 'm-snip' }],
      },
    }],
  });
}

function glmResp({ link = '', title = 'GLM Article', content = 'glm rich content', date = '2026-06-13' } = {}) {
  return jsonResp({
    search_result: [{ title, link, content, publish_date: date }],
  });
}

describe('web_search aggregator', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.ZHIPU_KEY = 'test-zhipu';
    process.env.MIMO_SEARCH_KEY = 'test-mimo';
    delete process.env.WEB_SEARCH_PRIMARY_PROVIDER;
    delete process.env.BOCHA_KEY;
    delete process.env.TAVILY_KEY;
    delete process.env.SERPER_KEY;
    __testing__.cache.clear();
    __testing__.structuredCache.clear();
  });

  it('uses GLM as the default primary source for fast fresh search', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(glmResp({ link: '', title: '世界杯赛程', content: '加拿大 1-1 波黑，美国 4-1 巴拉圭。' }));

    const r = await webSearch('test query');

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(r).toContain('provider: glm');
    expect(r).toContain('世界杯赛程');
    expect(r).toContain('加拿大 1-1 波黑');
  });

  it('uses MiMo first when the user explicitly asks for source links', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(mimoResp('MiMo with links', 'http://source-link'));

    const r = await webSearch('2026世界杯赛程 给我来源链接');

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(r).toContain('provider: mimo');
    expect(r).toContain('MiMo with links');
    expect(r).toContain('http://source-link');
  });

  it('falls back to MiMo when GLM is unavailable', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'down', json: async () => ({}) })
      .mockResolvedValueOnce(mimoResp('MiMo fallback'));

    const r = await webSearch('普通即时资讯');

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(r).toContain('provider: mimo');
    expect(r).toContain('MiMo fallback');
  });

  it('returns error JSON when all configured sources fail', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => '', json: async () => ({}) });

    const r = await webSearch('q');
    const parsed = JSON.parse(r);

    expect(parsed.error).toBe('all search sources failed');
    expect(parsed.sources.length).toBeGreaterThanOrEqual(2);
    expect(parsed.sources.every((s) => !s.ok)).toBe(true);
  });

  it('caches successful results (5min LRU)', async () => {
    global.fetch = vi.fn().mockResolvedValue(glmResp({ title: 'cached', content: 'cached content' }));

    const r1 = await webSearch('cache-test');
    const r2 = await webSearch('cache-test');

    expect(r1).toBe(r2);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('returns error for empty query without calling fetch', async () => {
    global.fetch = vi.fn();
    const r = await webSearch('');
    expect(JSON.parse(r).error).toBe('empty query');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('normalizes common World Cup typo intent without rewriting real event names', () => {
    expect(__testing__.normalizeSearchQueryIntent('今晚的世纪杯比赛有几场')).toBe('今晚的世界杯比赛有几场');
    expect(__testing__.normalizeSearchQueryIntent('新世纪杯龙舟比赛')).toBe('新世纪杯龙舟比赛');
    expect(__testing__.normalizeSearchQueryIntent('21世纪杯英语演讲比赛')).toBe('21世纪杯英语演讲比赛');
  });

  it('classifies volatile current facts as source-grade instead of keyword-only buckets', () => {
    expect(__testing__.classifySearchEvidencePolicy('今晚世界杯有几场比赛').grade).toBe('source');
    expect(__testing__.classifySearchEvidencePolicy('今晚蓝鲸杯有几场比赛').grade).toBe('source');
    expect(__testing__.classifySearchEvidencePolicy('英伟达今天股价').grade).toBe('source');
    expect(__testing__.classifySearchEvidencePolicy('DGX Spark 最新版出了吗')).toMatchObject({ grade: 'source', reason: 'product-release-or-version' });
    expect(__testing__.classifySearchEvidencePolicy('深圳明天天气').grade).toBe('source');
    expect(__testing__.classifySearchEvidencePolicy('中国主要创业社群的人数，收费').grade).toBe('source');
    expect(__testing__.classifySearchEvidencePolicy('解释一下 React').grade).toBe('fast');
  });

  it('uses optional racers only in the fallback lane', async () => {
    delete process.env.ZHIPU_KEY;
    process.env.BOCHA_KEY = 'test-bocha';
    global.fetch = vi.fn().mockImplementation((url) => {
      if (String(url).includes('bochaai')) {
        return Promise.resolve(jsonResp({ data: { webPages: { value: [
          { name: 'Bocha', url: 'http://bo', snippet: 'bo!' },
          { name: 'Bocha 2', url: 'http://bo2', snippet: 'bo2!' },
        ] } } }));
      }
      return Promise.resolve({ ok: false, status: 500, text: async () => 'down', json: async () => ({}) });
    });

    const r = await webSearch('with-bocha');

    expect(r).toContain('provider: bocha');
    expect(r).toContain('http://bo');
  });
});

describe('webSearchStructured (Lynn brain proxy backend)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.ZHIPU_KEY = 'test-zhipu';
    process.env.MIMO_SEARCH_KEY = 'test-mimo';
    delete process.env.WEB_SEARCH_PRIMARY_PROVIDER;
    delete process.env.BOCHA_KEY;
    delete process.env.TAVILY_KEY;
    delete process.env.SERPER_KEY;
    __testing__.cache.clear();
    __testing__.structuredCache.clear();
  });

  it('returns structured GLM items + summary as the default primary result', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(glmResp({ link: '', title: '2026世界杯最新赛程', content: '墨西哥 2-0 南非，韩国 2-1 捷克。' }));

    const r = await webSearchStructured('结构化测试');

    expect(r.ok).toBe(true);
    expect(r.provider).toBe('glm');
    expect(r.summary).toContain('墨西哥 2-0 南非');
    expect(r.items).toEqual([]);
    expect(r.sources[0].items[0]).toMatchObject({ title: '2026世界杯最新赛程', url: '' });
    expect(r.sources.map((s) => s.name)).toEqual(['glm']);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps GLM content-only results usable without inventing a Baidu source URL', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(glmResp({ link: '', title: '2026世界杯最新赛程', content: '墨西哥 2-0 南非，韩国 2-1 捷克。' }));

    const r = await webSearchStructured('普通即时资讯');

    expect(r.ok).toBe(true);
    expect(r.provider).toBe('glm');
    expect(r.summary).toContain('墨西哥 2-0 南非');
    expect(r.items).toEqual([]);
    expect(r.sources[0].items[0]).toMatchObject({ title: '2026世界杯最新赛程', url: '' });

    const formatted = __testing__.formatStructuredSearchForTool(r);
    expect(formatted).toContain('GLM Web Search');
    expect(formatted).toContain('摘要无原文链接');
    expect(formatted).not.toContain('baidu.com/s?wd=');
  });

  it('uses structured MiMo as primary for explicit source-link queries', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(mimoResp('MiMo 综合答案'));

    const r = await webSearchStructured('结构化测试 来源链接');

    expect(r.ok).toBe(true);
    expect(r.provider).toBe('mimo');
    expect(r.summary).toBe('MiMo 综合答案');
    expect(r.items).toEqual([{ title: 'M', url: 'http://m', snippet: 'm-snip' }]);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('uses structured MiMo as primary for source-grade comparative fee research queries', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(mimoResp('MiMo comparative citation answer', 'https://source.example/research'));

    const r = await webSearchStructured('中国主要创业社群的人数，收费');

    expect(r.ok).toBe(true);
    expect(r.provider).toBe('mimo');
    expect(r.summary).toBe('MiMo comparative citation answer');
    expect(r.items).toEqual([{ title: 'M', url: 'https://source.example/research', snippet: 'm-snip' }]);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('uses ESPN scoreboard before generic search for sports score and schedule queries', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-23T12:54:00Z'));
    try {
      global.fetch = vi.fn().mockResolvedValueOnce(jsonResp({
        events: [{
          date: '2026-06-23T17:00Z',
          status: { type: { completed: false, shortDetail: 'Scheduled' } },
          competitions: [{
            competitors: [
              { homeAway: 'home', score: '', team: { displayName: 'Portugal' } },
              { homeAway: 'away', score: '', team: { displayName: 'Uzbekistan' } },
            ],
          }],
        }],
      }));

      const r = await webSearchStructured('今晚世界杯有几场比赛');

      expect(r.ok).toBe(true);
      expect(r.provider).toBe('espn_scoreboard');
      expect(r.evidencePolicy).toMatchObject({ grade: 'source', reason: 'event-score-schedule-or-prediction' });
      expect(r.summary).toContain('provider: espn_scoreboard');
      expect(r.summary).toContain('Portugal vs Uzbekistan');
      expect(__testing__.needsSourceGradeEvidence('2026世界杯已经出的赛事比分')).toBe(true);
      expect(__testing__.isSportsScoreOrScheduleQuery('今晚世界杯有几场比赛')).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(global.fetch.mock.calls[0][0]).toContain('site.api.espn.com');
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns ESPN scoreboard JSON for sports evidence queries without waiting for generic search providers', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(jsonResp({
      events: [{
        date: '2026-07-14T19:00Z',
        status: { type: { completed: false, shortDetail: 'Scheduled' } },
        competitions: [{
          competitors: [
            { homeAway: 'home', score: '', team: { displayName: 'Winner QF1' } },
            { homeAway: 'away', score: '', team: { displayName: 'Winner QF2' } },
          ],
        }],
      }],
    }));

    const r = await webSearchStructured('世界杯半决赛在哪一天？');

    expect(r.ok).toBe(true);
    expect(r.provider).toBe('espn_scoreboard');
    expect(r.summary).toContain('provider: espn_scoreboard');
    expect(r.summary).toContain('Winner QF1 vs Winner QF2');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][0]).toContain('site.api.espn.com');
  });

  it('formats source-grade searches with a generic evidence policy hint', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(mimoResp('MiMo citation answer', 'https://sports.example/game'));

    const r = await webSearch('今晚蓝鲸杯有几场比赛');

    expect(r).toContain('证据使用提示');
    expect(r).toContain('当前北京时间日期');
    expect(r).toContain('赛事/赛程/比分/预测属于高波动问题');
    expect(r).toContain('已知事实 / 证据缺口 / 可回答结论');
    expect(r).toContain('provider: mimo');
  });

  it('enriches sports probability queries with English odds terms before calling MiMo', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(mimoResp('MiMo odds answer', 'https://oddschecker.com/football/world-cup'));

    const r = await webSearchStructured('英格兰 克罗地亚 比赛 胜率 预测');

    expect(r.ok).toBe(true);
    expect(r.provider).toBe('mimo');
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.messages[0].content).toContain('England');
    expect(body.messages[0].content).toContain('Croatia');
    expect(body.messages[0].content).toContain('odds');
    expect(body.messages[0].content).toContain('implied probability');
  });

  it('filters low-quality SEO sports prediction domains when better odds sources are present', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(jsonResp({
      choices: [{
        message: {
          content: 'MiMo odds answer',
          annotations: [
            { type: 'url_citation', title: 'SEO tips', url: 'https://soccertips.ai/england-croatia', summary: 'generic prediction' },
            { type: 'url_citation', title: 'OddsChecker odds', url: 'https://www.oddschecker.com/football/world-cup/england-croatia', summary: 'England 55% implied probability from odds' },
          ],
        },
      }],
    }));

    const r = await webSearchStructured('英格兰 克罗地亚 胜率 预测');

    expect(r.ok).toBe(true);
    expect(r.items[0].url).toContain('oddschecker.com');
    expect(r.items.map((item) => item.url)).not.toContain('https://soccertips.ai/england-croatia');
  });

  it('filters product release searches to the exact product and official-grade sources', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(jsonResp({
      choices: [{
        message: {
          content: 'DGX Spark official answer',
          annotations: [
            { type: 'url_citation', title: 'ZENTEK NVIDIA DGX 解决方案', url: 'https://zentek.example/dgx', summary: 'NVIDIA DGX, Omniverse, GPU training partner.' },
            { type: 'url_citation', title: 'NVIDIA DGX Spark Release Notes', url: 'https://docs.nvidia.com/dgx/dgx-spark/release-notes.html', summary: 'DGX Spark June 2026 release notes list DGX OS 7.5.0.' },
            { type: 'url_citation', title: 'NVIDIA DGX Spark Marketplace', url: 'https://marketplace.nvidia.com/en-us/enterprise/personal-ai-supercomputers/dgx-spark/', summary: 'DGX Spark Buy Now product page.' },
          ],
        },
      }],
    }));

    const r = await webSearchStructured('DGX Spark 最新版出了吗');

    expect(r.ok).toBe(true);
    expect(r.provider).toBe('mimo');
    expect(r.evidencePolicy).toMatchObject({ grade: 'source', reason: 'product-release-or-version' });
    expect(r.items.map((item) => item.url)).toEqual([
      'https://docs.nvidia.com/dgx/dgx-spark/release-notes.html',
      'https://marketplace.nvidia.com/en-us/enterprise/personal-ai-supercomputers/dgx-spark/',
    ]);
    expect(r.items.map((item) => item.url)).not.toContain('https://zentek.example/dgx');
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.messages[0].content).toContain('NVIDIA DGX Spark');
    expect(body.messages[0].content).toContain('site:nvidia.com');
  });

  it('does not accept product release results that miss the exact product token', async () => {
    global.fetch = vi.fn().mockImplementation((url) => {
      const target = String(url);
      if (target.includes('api.xiaomimimo.com')) {
        return Promise.resolve(jsonResp({
          choices: [{
            message: {
              content: 'generic DGX partner page',
              annotations: [
                { type: 'url_citation', title: 'NVIDIA DGX partner solutions', url: 'https://zentek.example/dgx', summary: 'NVIDIA DGX, GPU, Omniverse.' },
              ],
            },
          }],
        }));
      }
      if (target.includes('open.bigmodel.cn')) {
        return Promise.resolve(glmResp({
          link: 'https://docs.nvidia.com/dgx/dgx-spark/release-notes.html',
          title: 'NVIDIA DGX Spark Release Notes',
          content: 'DGX Spark June 2026 release notes: DGX OS 7.5.0, GPU Driver 580.159.03.',
        }));
      }
      if (target.includes('docs.nvidia.com/dgx/dgx-spark/release-notes.html')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: async () => '<html><title>NVIDIA DGX Spark Release Notes</title><body>DGX Spark Release Notes June 2026 DGX OS 7.5.0 GPU Driver 580.159.03 CUDA Toolkit 13.0</body></html>',
          json: async () => ({}),
        });
      }
      if (target.includes('marketplace.nvidia.com')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: async () => '<html><title>NVIDIA DGX Spark Marketplace</title><body>DGX Spark Personal AI Supercomputer Buy Now Grace Blackwell</body></html>',
          json: async () => ({}),
        });
      }
      if (target.includes('www.nvidia.com/en-us/products/workstations/dgx-spark')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: async () => '<html><title>NVIDIA DGX Spark</title><body>DGX Spark Personal AI Supercomputer product page.</body></html>',
          json: async () => ({}),
        });
      }
      return Promise.resolve({ ok: false, status: 404, text: async () => 'not found', json: async () => ({}) });
    });

    const r = await webSearchStructured('DGX Spark 最新版出了吗');

    expect(r.ok).toBe(true);
    expect(r.provider).toBe('official_product_fallback');
    expect(r.items.map((item) => item.url)).toEqual([
      'https://docs.nvidia.com/dgx/dgx-spark/release-notes.html',
      'https://marketplace.nvidia.com/en-us/enterprise/personal-ai-supercomputers/dgx-spark/',
      'https://www.nvidia.com/en-us/products/workstations/dgx-spark/',
    ]);
    expect(r.items.map((item) => item.url)).not.toContain('https://zentek.example/dgx');
    expect(r.summary).toContain('DGX Spark Release Notes');
    expect(r.summary).toContain('DGX OS 7.5.0');
    expect(global.fetch).toHaveBeenCalledTimes(5);
  });

  it('uses official product fallback when configured search providers fail for DGX Spark', async () => {
    global.fetch = vi.fn().mockImplementation((url) => {
      const target = String(url);
      if (target.includes('docs.nvidia.com/dgx/dgx-spark/release-notes.html')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: async () => '<html><title>NVIDIA DGX Spark Release Notes</title><body>DGX Spark Release Notes June 2026 DGX OS 7.4.0 GPU Driver 580.159.03 CUDA Toolkit 13.0</body></html>',
          json: async () => ({}),
        });
      }
      if (target.includes('marketplace.nvidia.com')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: async () => '<html><title>NVIDIA DGX Spark Marketplace</title><body>DGX Spark Personal AI Supercomputer Buy Now Grace Blackwell</body></html>',
          json: async () => ({}),
        });
      }
      if (target.includes('www.nvidia.com/en-us/products/workstations/dgx-spark')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: async () => '<html><title>NVIDIA DGX Spark</title><body>DGX Spark Personal AI Supercomputer product page.</body></html>',
          json: async () => ({}),
        });
      }
      return Promise.resolve({ ok: false, status: 401, text: async () => 'unauthorized', json: async () => ({}) });
    });

    const r = await webSearchStructured('DGX Spark 最新版出了吗');

    expect(r.ok).toBe(true);
    expect(r.provider).toBe('official_product_fallback');
    expect(r.items.map((item) => item.url)).toEqual([
      'https://docs.nvidia.com/dgx/dgx-spark/release-notes.html',
      'https://marketplace.nvidia.com/en-us/enterprise/personal-ai-supercomputers/dgx-spark/',
      'https://www.nvidia.com/en-us/products/workstations/dgx-spark/',
    ]);
    expect(r.summary).toContain('DGX Spark Release Notes');
    expect(r.summary).toContain('DGX OS 7.4.0');
    expect(global.fetch).toHaveBeenCalledTimes(5);
  });

  it('falls back to non-summary source when MiMo and GLM both fail and Bocha is configured', async () => {
    process.env.BOCHA_KEY = 'test-bocha';
    global.fetch = vi.fn().mockImplementation((url) => {
      if (String(url).includes('bochaai')) {
        return Promise.resolve(jsonResp({ data: { webPages: { value: [
          { name: 'Bocha Article', url: 'http://b', snippet: 'b-snip' },
          { name: 'Bocha Article 2', url: 'http://b2', snippet: 'b2-snip' },
        ] } } }));
      }
      return Promise.resolve({ ok: false, status: 500, text: async () => 'down', json: async () => ({}) });
    });

    const r = await webSearchStructured('mimo-glm-down');

    expect(r.ok).toBe(true);
    expect(r.provider).toBe('bocha');
    expect(r.summary).toBeUndefined();
    expect(r.items).toEqual([
      { title: 'Bocha Article', url: 'http://b', snippet: 'b-snip' },
      { title: 'Bocha Article 2', url: 'http://b2', snippet: 'b2-snip' },
    ]);
  });

  it('returns ok=false when all racers fail', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => '', json: async () => ({}) });
    const r = await webSearchStructured('all-down');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('all search sources failed');
    expect(r.sources.every((s) => !s.ok)).toBe(true);
  });

  it('rejects empty query without calling fetch', async () => {
    global.fetch = vi.fn();
    const r = await webSearchStructured('');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('empty query');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('sends normalized World Cup typo queries to the direct scoreboard path', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(jsonResp({
      events: [{
        date: '2026-06-23T17:00Z',
        status: { type: { completed: false, shortDetail: 'Scheduled' } },
        competitions: [{
          competitors: [
            { homeAway: 'home', score: '', team: { displayName: 'Portugal' } },
            { homeAway: 'away', score: '', team: { displayName: 'Uzbekistan' } },
          ],
        }],
      }],
    }));

    const r = await webSearchStructured('今晚的世纪杯比赛有几场');

    expect(r.ok).toBe(true);
    expect(r.query).toContain('世界杯');
    expect(r.query).not.toContain('世纪杯');
    expect(r.provider).toBe('espn_scoreboard');
    expect(global.fetch.mock.calls[0][0]).toContain('site.api.espn.com');
  });

  it('serves the second call from the structured cache', async () => {
    global.fetch = vi.fn().mockResolvedValue(glmResp({ title: 'cached', content: 'cached content' }));
    const a = await webSearchStructured('cache-key-q');
    const b = await webSearchStructured('cache-key-q');
    expect(a).toBe(b);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
