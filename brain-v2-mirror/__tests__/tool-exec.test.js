import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../tool-exec/web_search.js', () => ({
  webSearch: vi.fn(async (q) => 'mock results for: ' + q),
}));

import { webSearch } from '../tool-exec/web_search.js';
import { executeServerTool, isServerTool, mergeWithServerTools, SERVER_TOOLS, SERVER_TOOL_NAMES } from '../tool-exec/index.js';
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

  it('uses one official-domain fast path for OpenAI model release live_news', async () => {
    vi.mocked(webSearch).mockClear();
    vi.mocked(webSearch).mockResolvedValueOnce('1. Introducing GPT-5.5 - OpenAI\\nURL: https://openai.com/index/introducing-gpt-5-5/\\n摘要: GPT-5.5 and GPT-5.5 Pro are now available.');

    const r = await executeServerTool('live_news', { query: '查一下 OpenAI 最近发布了什么新模型，给一句摘要' });
    const queries = vi.mocked(webSearch).mock.calls.map(([q]) => String(q));

    expect(r).toContain('OpenAI 官方模型发布资料');
    expect(r).toContain('GPT-5.5');
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

    const r = await executeServerTool('sports_score', { query: '今晚世界杯有几场比赛' });
    expect(r).toContain('Spain vs Saudi Arabia');
    expect(r).not.toContain('Spain 0-0 Saudi Arabia');
    expect(r).not.toContain('Japan 4-0 Tunisia');
    expect(r).not.toContain('Argentina vs Austria');
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
    const n = names(null, [{ role: 'user', content: '今天北京天气怎么样' }]);
    expect(n).toContain('web_search');
    expect(n).toContain('web_fetch');
    expect(n).toContain('weather');
    expect(n).not.toContain('create_report');
    expect(n).not.toContain('create_pptx');
    expect(n).not.toContain('create_pdf');
    expect(n).not.toContain('create_artifact');
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

  it('keeps web_search / web_fetch available regardless of intent', () => {
    const n = names(null, [{ role: 'user', content: 'hello there' }]);
    expect(n).toContain('web_search');
    expect(n).toContain('web_fetch');
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
