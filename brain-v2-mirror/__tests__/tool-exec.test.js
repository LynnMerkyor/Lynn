import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../tool-exec/web_search.js', () => ({
  webSearch: vi.fn(async (q) => 'mock results for: ' + q),
}));

import { webSearch } from '../tool-exec/web_search.js';
import { executeServerTool, isServerTool, mergeWithServerTools, SERVER_TOOLS, SERVER_TOOL_NAMES, shouldExposeExternalEvidenceTools, shouldPreferSportsScoreTool, shouldPreferStockMarketTool, shouldPreferWeatherTool, shouldSuppressWebToolsForInternalLynnUx } from '../tool-exec/index.js';
import { parallelResearch } from '../tool-exec/parallel_research.js';

describe('tool-exec dispatcher', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('routes web_search to webSearch handler', async () => {
    const r = await executeServerTool('web_search', '{"query":"hello"}');
    expect(r).toBe('mock results for: hello');
  });

  it('returns error for unknown tool', async () => {
    const r = await executeServerTool('not_a_tool', '{}');
    expect(JSON.parse(r).error).toMatch(/not handled by brain server/);
  });

  it('handles invalid JSON args gracefully', async () => {
    const r = await executeServerTool('web_search', 'not json');
    expect(JSON.parse(r).error).toMatch(/invalid tool args/);
  });

  it('accepts already-parsed args object', async () => {
    const r = await executeServerTool('web_search', { query: 'parsed' });
    expect(r).toBe('mock results for: parsed');
  });

  it('does not inject web search tools for Lynn-internal UX copy prompts', () => {
    for (const content of [
      '给 Session Map 的 Huge 节点写 3 个短状态文案',
      '右侧工作台显示当前会话 digest 时应该避免什么？',
      '给长会话 7GB 卡死问题设计一个健康检查策略',
      '给 CLI 和 GUI 共用内核写一个回归测试矩阵',
      '设计一个 5 步门禁测试流程验证聊天工具链',
      '如果复核模型和主模型结论冲突，产品上怎么展示比较好？',
      '解释 Vitest 的 beforeEach 用途',
    ]) {
      const messages = [{ role: 'user', content }];
      const tools = mergeWithServerTools([], messages).map((tool) => tool.function.name);

      expect(shouldSuppressWebToolsForInternalLynnUx(messages)).toBe(true);
      expect(tools).not.toContain('web_search');
      expect(tools).not.toContain('web_fetch');
      expect(tools).not.toContain('live_news');
      expect(tools).not.toContain('unit_convert');
      expect(tools).not.toContain('calendar');
    }
  });

  it('does not inject web search tools for code snippet prompts', () => {
    const messages = [{ role: 'user', content: '写一个 zod schema 校验 release manifest' }];
    const tools = mergeWithServerTools([], messages).map((tool) => tool.function.name);

    expect(shouldSuppressWebToolsForInternalLynnUx(messages)).toBe(true);
    expect(tools).not.toContain('web_search');
    expect(tools).not.toContain('web_fetch');
    expect(tools).not.toContain('live_news');
  });

  it('keeps web search tools for explicit Lynn external lookup prompts', () => {
    const messages = [{ role: 'user', content: '查 Lynn v0.85.1 镜像站下载页现在显示的版本号' }];
    const tools = mergeWithServerTools([], messages).map((tool) => tool.function.name);

    expect(shouldSuppressWebToolsForInternalLynnUx(messages)).toBe(false);
    expect(tools).toContain('web_search');
    expect(tools).toContain('web_fetch');
  });

  it('does not expose external evidence tools for timeless planning or writing turns', () => {
    for (const content of [
      '第一次去杭州三天两晚，帮我安排一个不赶路的行程',
      '设计一个三幕式小说大纲，主题是记忆租赁',
      '给高中生解释动量守恒，用生活例子',
    ]) {
      const messages = [{ role: 'user', content }];
      const tools = mergeWithServerTools([], messages).map((tool) => tool.function.name);
      expect(shouldExposeExternalEvidenceTools(messages)).toBe(false);
      expect(tools).not.toContain('web_search');
      expect(tools).not.toContain('weather');
      expect(tools).not.toContain('parallel_research');
    }
  });

  it('removes client-supplied evidence and deliverable tools when the turn does not allow them', () => {
    const clientTools = [
      { type: 'function', function: { name: 'read' } },
      { type: 'function', function: { name: 'web-search' } },
      { type: 'function', function: { name: 'create-artifact' } },
    ];
    const tools = mergeWithServerTools(clientTools, [{
      role: 'user',
      content: '第一次去杭州三天两晚，帮我安排一个不赶路的行程',
    }]).map((tool) => tool.function.name);

    expect(tools).toContain('read');
    expect(tools).not.toContain('web-search');
    expect(tools).not.toContain('create-artifact');
  });

  it('keeps external evidence tools for explicit lookup and inherently live questions', () => {
    for (const content of [
      '查一下杭州最近有哪些景点临时关闭，给来源',
      '杭州明天下雨吗？',
      '美元人民币汇率现在多少？',
    ]) {
      const messages = [{ role: 'user', content }];
      expect(shouldExposeExternalEvidenceTools(messages)).toBe(true);
    }
  });

  it('prefers the dedicated sports score tool for direct sports schedule prompts', () => {
    const messages = [{ role: 'user', content: '今天世界杯赛程发我一下' }];
    const tools = mergeWithServerTools([], messages).map((tool) => tool.function.name);

    expect(shouldPreferSportsScoreTool(messages)).toBe(true);
    expect(tools).toContain('sports_score');
    expect(tools).not.toContain('web_search');
    expect(tools).not.toContain('web_fetch');
    expect(tools).not.toContain('live_news');
    expect(tools).not.toContain('calendar');
    expect(tools).not.toContain('parallel_research');
  });

  it('prefers the stock market tool for direct index quote prompts', () => {
    const messages = [{ role: 'user', content: '纳斯达克指数最新点位是多少？' }];
    const tools = mergeWithServerTools([], messages).map((tool) => tool.function.name);

    expect(shouldPreferStockMarketTool(messages)).toBe(true);
    expect(tools).toContain('stock_market');
    expect(tools).not.toContain('web_search');
    expect(tools).not.toContain('web_fetch');
    expect(tools).not.toContain('live_news');
    expect(tools).not.toContain('parallel_research');
  });

  it('prefers the weather tool for direct air quality prompts', () => {
    const messages = [{ role: 'user', content: '北京今天空气质量怎么样？' }];
    const tools = mergeWithServerTools([], messages).map((tool) => tool.function.name);

    expect(shouldPreferWeatherTool(messages)).toBe(true);
    expect(tools).toContain('weather');
    expect(tools).not.toContain('web_search');
    expect(tools).not.toContain('web_fetch');
    expect(tools).not.toContain('live_news');
    expect(tools).not.toContain('parallel_research');
  });

  it('prefers the weather tool for direct forecast prompts', () => {
    const messages = [{ role: 'user', content: '明天深圳天气如何' }];
    const tools = mergeWithServerTools([], messages).map((tool) => tool.function.name);

    expect(shouldPreferWeatherTool(messages)).toBe(true);
    expect(tools).toContain('weather');
    expect(tools).not.toContain('web_search');
    expect(tools).not.toContain('live_news');
    expect(tools).not.toContain('calendar');
    expect(tools).not.toContain('parallel_research');
  });

  it('formats exchange rates with correct pct field and JPY unit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      text: async () => [
        'var hq_str_fx_susdcny="03:00:01,6.7751000000,6.7773000000,6.7783000000,88.0000000000,6.7751000000,6.7793000000,6.7705000000,6.7773000000,美元兑人民币,-0.0148,-0.0010,0.0088,source,0.0000,0.0000,,2026-06-23";',
        'var hq_str_fx_sjpycny="03:15:20,0.0419355786,0.0419355786,0.0419767701,2.2353590000,0.0419818806,0.0420657656,0.0418422297,0.0419355786,日元兑人民币,-0.0981,-0.0000,0.0002,source,0.0000,0.0000,,2026-06-23";',
      ].join('\n'),
    })));

    const usd = await executeServerTool('exchange_rate', { query: '美元人民币汇率' });
    expect(usd).toContain('美元/人民币: 1 美元 = 6.7751 人民币');
    expect(usd).toContain('涨跌幅 -0.0148%');
    expect(usd).not.toContain('+6.7751%');

    const jpy = await executeServerTool('exchange_rate', { query: '日元兑人民币现在大概多少？' });
    expect(jpy).toContain('日元/人民币: 1 日元 = 0.041936 人民币');
    expect(jpy).toContain('100 日元 ≈ 4.1936 人民币');
    expect(jpy).not.toContain('100日元 ≈ 0.042');
  });

  it('returns Open-Meteo AQI for air quality prompts without web search fallback', async () => {
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
    vi.mocked(webSearch).mockClear();

    const result = await executeServerTool('weather', { query: '北京今天空气质量怎么样？' });

    expect(result).toContain('北京当前空气质量');
    expect(result).toContain('AQI(US): 42');
    expect(result).toContain('PM2.5: 9.5');
    expect(result).toContain('open-meteo-air-quality');
    expect(vi.mocked(webSearch)).not.toHaveBeenCalled();
  });

  it('strips relative-time words from live_news expansion queries', async () => {
    vi.mocked(webSearch).mockClear();
    const r = await executeServerTool('live_news', { query: '昨晚世界杯赛程结束了吗？比赛结果如何' });
    expect(r).toContain('【实时新闻扩展检索】');
    const queries = vi.mocked(webSearch).mock.calls.map(([q]) => String(q));
    expect(queries).toHaveLength(9);
    expect(queries.join('\n')).not.toContain('昨晚');
    expect(queries.some((q) => q.includes('今日 最新'))).toBe(true);
    expect(queries.some((q) => q.includes('近3天 最新'))).toBe(true);
    expect(queries.some((q) => q.includes('近7天 最新'))).toBe(true);
  });

  it('keeps A-share market movement prompts out of live_news expansion', async () => {
    vi.mocked(webSearch).mockClear();
    const r = await executeServerTool('live_news', { query: '今天 A 股有什么异动？' });

    expect(r).toContain('market_lookup_misroute');
    expect(r).toContain('stock_market');
    expect(vi.mocked(webSearch)).not.toHaveBeenCalled();
  });

  it('does not expand old news for strict same-day news queries', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-22T20:30:00Z')); // 2026-06-23 Beijing
    vi.mocked(webSearch).mockClear();
    vi.mocked(webSearch).mockResolvedValue('科技动态(2026-06-22)：旧日期新闻，不应冒充今天更新。');

    try {
      const r = await executeServerTool('live_news', { query: '今天科技新闻有什么重要更新？' });
      expect(r).toContain('no_same_day_evidence');
      expect(r).toContain('2026年06月23日');
      expect(r).not.toContain('2026-06-22');
      expect(r).not.toContain('不应冒充今天更新');
      expect(vi.mocked(webSearch)).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses one official-domain fast path for OpenAI model release live_news', async () => {
    vi.mocked(webSearch).mockClear();
    vi.mocked(webSearch).mockResolvedValueOnce('1. Model Release Notes | OpenAI Help Center\\nURL: https://help.openai.com/en/articles/9624314-model-release-notes\\n摘要: Official model release notes list recent model updates.');

    const r = await executeServerTool('live_news', { query: '查一下 OpenAI 最近发布了什么新模型，给一句摘要' });
    const queries = vi.mocked(webSearch).mock.calls.map(([q]) => String(q));

    expect(r).toContain('OpenAI 官方模型发布资料');
    expect(r).toContain('Model Release Notes');
    expect(r).not.toContain('GPT-5.5');
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain('site:openai.com');
  });

  it('returns ESPN scoreboard evidence for recognized sports score queries', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        events: [{
          date: '2026-06-11T19:00Z',
          name: 'South Africa at Mexico',
          status: { type: { completed: true, shortDetail: 'FT' } },
          competitions: [{
            competitors: [
              { homeAway: 'home', score: '2', team: { displayName: 'Mexico' } },
              { homeAway: 'away', score: '0', team: { displayName: 'South Africa' } },
            ],
          }],
        }],
      }),
    })));

    const r = await executeServerTool('sports_score', { query: '世界杯比分' });
    expect(r).toContain('provider: espn_scoreboard');
    expect(r).toContain('league: FIFA World Cup');
    expect(r).toContain('Mexico 2-0 South Africa');
    expect(global.fetch.mock.calls[0][0]).toContain('site.api.espn.com');
  });

  it('filters ESPN scoreboard rows by Beijing tonight window and hides scheduled 0-0 scores', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-21T11:05:00Z'));
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        events: [
          {
            date: '2026-06-21T04:00Z',
            status: { type: { completed: true, shortDetail: 'FT' } },
            competitions: [{ competitors: [
              { homeAway: 'home', score: '4', team: { displayName: 'Japan' } },
              { homeAway: 'away', score: '0', team: { displayName: 'Tunisia' } },
            ] }],
          },
          {
            date: '2026-06-21T16:00Z',
            status: { type: { completed: false, shortDetail: 'Scheduled' } },
            competitions: [{ competitors: [
              { homeAway: 'home', score: '0', team: { displayName: 'Spain' } },
              { homeAway: 'away', score: '0', team: { displayName: 'Saudi Arabia' } },
            ] }],
          },
          {
            date: '2026-06-22T17:00Z',
            status: { type: { completed: false, shortDetail: 'Scheduled' } },
            competitions: [{ competitors: [
              { homeAway: 'home', score: '0', team: { displayName: 'Argentina' } },
              { homeAway: 'away', score: '0', team: { displayName: 'Austria' } },
            ] }],
          },
        ],
      }),
    })));

    try {
      const r = await executeServerTool('sports_score', { query: '今晚世界杯有几场比赛' });
      expect(r).toContain('Spain vs Saudi Arabia');
      expect(r).not.toContain('Spain 0-0 Saudi Arabia');
      expect(r).not.toContain('Japan 4-0 Tunisia');
      expect(r).not.toContain('Argentina vs Austria');
    } finally {
      vi.useRealTimers();
    }
  });

  it('includes previous source date for Beijing early-morning "today" World Cup schedule', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-22T17:05:00Z')); // 2026-06-23 01:05 Beijing
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        events: [
          {
            date: '2026-06-22T17:00:00Z',
            status: { type: { completed: false, shortDetail: 'Scheduled' } },
            competitions: [{ competitors: [
              { homeAway: 'home', score: '', team: { displayName: 'Argentina' } },
              { homeAway: 'away', score: '', team: { displayName: 'Austria' } },
            ] }],
          },
          {
            date: '2026-06-23T17:00:00Z',
            status: { type: { completed: false, shortDetail: 'Scheduled' } },
            competitions: [{ competitors: [
              { homeAway: 'home', score: '', team: { displayName: 'Portugal' } },
              { homeAway: 'away', score: '', team: { displayName: 'Uzbekistan' } },
            ] }],
          },
        ],
      }),
    })));

    try {
      const r = await executeServerTool('sports_score', { query: '今天世界杯赛程发我一下' });
      expect(r).toContain('provider: espn_scoreboard');
      expect(r).toContain('dateRange: 20260622-20260624');
      expect(r).toContain('Argentina vs Austria');
      expect(r).not.toContain('Portugal vs Uzbekistan');
      expect(global.fetch.mock.calls[0][0]).toContain('dates=20260621-20260625');
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats yesterday/last-night sports result queries as the previous Beijing day plus this morning', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-22T17:30:00Z')); // 2026-06-23 01:30 Beijing
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        events: [
          {
            date: '2026-06-21T16:00:00Z',
            status: { type: { completed: true, shortDetail: 'FT' } },
            competitions: [{ competitors: [
              { homeAway: 'home', score: '4', team: { displayName: 'Spain' } },
              { homeAway: 'away', score: '0', team: { displayName: 'Saudi Arabia' } },
            ] }],
          },
          {
            date: '2026-06-22T17:00:00Z',
            status: { type: { completed: false, shortDetail: '14\'' } },
            competitions: [{ competitors: [
              { homeAway: 'home', score: '0', team: { displayName: 'Argentina' } },
              { homeAway: 'away', score: '0', team: { displayName: 'Austria' } },
            ] }],
          },
        ],
      }),
    })));

    try {
      const r = await executeServerTool('sports_score', { query: '昨晚世界杯最新的比赛结果' });
      expect(r).toContain('Spain 4-0 Saudi Arabia');
      expect(r).not.toContain('Argentina vs Austria');
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses bundled World Cup schedule fallback when ESPN is temporarily unreachable', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-21T11:05:00Z'));
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('fetch failed');
    }));

    try {
      const pending = executeServerTool('sports_score', { query: '你能预测今晚世界杯比分么？' });
      await vi.advanceTimersByTimeAsync(1000);
      const r = await pending;
      expect(r).toContain('directSourceStatus: fallback_static_schedule');
      expect(r).toContain('userIntent: score_prediction');
      expect(r).toContain('Spain vs Saudi Arabia');
      expect(r).toContain('Belgium vs Iran');
      expect(r).toContain('Uruguay vs Cape Verde');
      expect(r).toContain('New Zealand vs Egypt');
      expect(r).not.toContain('请改用 web_search');
    } finally {
      vi.useRealTimers();
    }
  });

  it('isServerTool returns true for known and false for unknown', () => {
    expect(isServerTool('web_search')).toBe(true);
    expect(isServerTool('bash')).toBe(false);
  });
});

describe('mergeWithServerTools', () => {
  it('appends serverTools to client tools', () => {
    const merged = mergeWithServerTools([{ type: 'function', function: { name: 'bash' } }]);
    const names = merged.map(t => t.function.name);
    expect(names).toContain('bash');
    expect(names).toContain('web_search');
  });
  it('does not duplicate server tools when client already has them', () => {
    const merged = mergeWithServerTools([{ type: 'function', function: { name: 'web_search' } }]);
    const wsCount = merged.filter(t => t.function.name === 'web_search').length;
    expect(wsCount).toBe(1);
  });
  it('handles null client tools', () => {
    const merged = mergeWithServerTools(null);
    expect(merged.map(t => t.function.name)).toContain('web_search'); expect(merged.length).toBeGreaterThan(5);
  });
});

describe('mergeWithServerTools document-intent gating', () => {
  const names = (clientTools, messages) => mergeWithServerTools(clientTools, messages).map(t => t.function.name);

  it('injects all server tools when messages omitted (back-compat)', () => {
    const n = names(null);
    expect(n).toContain('create_report');
    expect(n).toContain('create_pptx');
    expect(n).toContain('create_pdf');
    expect(n).toContain('create_artifact');
  });

  it('gates out the document generators on a plain turn', () => {
    const n = names(null, [{ role: 'user', content: '今天心情很好，帮我改写正式一点' }]);
    expect(n).not.toContain('web_search');
    expect(n).not.toContain('web_fetch');
    expect(n).not.toContain('weather');
    expect(n).not.toContain('create_report');
    expect(n).not.toContain('create_pptx');
    expect(n).not.toContain('create_pdf');
    expect(n).not.toContain('create_artifact');
  });

  it('prefers the weather tool for ordinary weather prompts', () => {
    const n = names(null, [{ role: 'user', content: '今天北京天气怎么样' }]);
    expect(n).toContain('weather');
    expect(n).not.toContain('web_search');
    expect(n).not.toContain('web_fetch');
  });

  it('injects HTML/report tools when the user asks to export results as an image', () => {
    const n = names(null, [{ role: 'user', content: '把刚才世界杯赛程结果输出成图片长图' }]);
    expect(n).toContain('create_report');
    expect(n).toContain('create_artifact');
  });

  it('does not treat creative image drawing as an HTML report request', () => {
    const n = names(null, [{ role: 'user', content: '画一只猫在月亮上睡觉' }]);
    expect(n).not.toContain('create_report');
    expect(n).not.toContain('create_artifact');
  });

  it('injects the document generators on explicit intent (zh)', () => {
    expect(names(null, [{ role: 'user', content: '帮我做个PPT介绍这个项目' }])).toContain('create_pptx');
    expect(names(null, [{ role: 'user', content: '整理成一份分析报告' }])).toContain('create_report');
    expect(names(null, [{ role: 'user', content: '导出成PDF' }])).toContain('create_pdf');
  });

  it('injects the document generators on explicit intent (en)', () => {
    const n = names(null, [{ role: 'user', content: 'generate a PDF report of the results' }]);
    expect(n).toContain('create_pdf');
    expect(n).toContain('create_report');
    expect(names(null, [{ role: 'user', content: 'make a powerpoint deck' }])).toContain('create_pptx');
  });

  it('keeps external evidence tools out of ordinary chat turns', () => {
    const n = names(null, [{ role: 'user', content: 'hello there' }]);
    expect(n).not.toContain('web_search');
    expect(n).not.toContain('web_fetch');
  });

  it('detects intent across the recent user turns, not just the last', () => {
    const n = names(null, [
      { role: 'user', content: '研究一下这家公司' },
      { role: 'assistant', content: '好的,这是初步分析…' },
      { role: 'user', content: '做成PPT' },
    ]);
    expect(n).toContain('create_pptx');
  });
});

describe('SERVER_TOOLS schema', () => {
  it('has web_search with required query parameter', () => {
    const ws = SERVER_TOOLS.find(t => t.function.name === 'web_search');
    expect(ws).toBeDefined();
    expect(ws.function.parameters.required).toEqual(['query']);
  });
  it('SERVER_TOOL_NAMES set matches array', () => {
    expect(SERVER_TOOL_NAMES.size).toBe(SERVER_TOOLS.length);
  });
});

describe('parallelResearch', () => {
  it('returns early with partial results once enough sub-queries settle', async () => {
    const startedAt = Date.now();
    const resultText = await parallelResearch({
      queries: [
        { label: 'fast-1', tool: 'web_search', args: { ms: 10, value: 'A' } },
        { label: 'fast-2', tool: 'web_search', args: { ms: 20, value: 'B' } },
        { label: 'slow-3', tool: 'web_search', args: { ms: 2000, value: 'C' } },
      ],
    }, {
      dispatchFn: (_tool, args) => new Promise(resolve => {
        setTimeout(() => resolve(JSON.stringify({ value: args.value })), args.ms);
      }),
    });
    const elapsed = Date.now() - startedAt;
    const data = JSON.parse(resultText);
    expect(elapsed).toBeLessThan(1000);
    expect(data.parallel).toBe(true);
    expect(data.partial).toBe(true);
    expect(data.returned).toBe(2);
    expect(data.results.map(r => r.label)).toEqual(['fast-1', 'fast-2']);
  });
});
