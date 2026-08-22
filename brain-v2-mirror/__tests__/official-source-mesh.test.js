import { afterEach, describe, expect, it, vi } from 'vitest';

import { __testing__, lookupOfficialSources } from '../tool-exec/official-source-mesh.js';

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

describe('official source mesh', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('does not intercept an ambiguous generic query', async () => {
    vi.stubGlobal('fetch', vi.fn());
    expect(await lookupOfficialSources('帮我了解一下这个产品')).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('returns USGS institutional earthquake evidence before generic search', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('data.earthquake.cn')) {
        const html = '<tr id="earthquake_subao_guid_catalog_tr_0">' + [
          '1', '2026-8-22 11:40:13', '122.08', '24.38', '28', '4.5', '台湾宜兰县海域', '天然地震',
        ].map((value) => `<td><div class="cls-data-content-list">${value}</div></td>`).join('') + '</tr>';
        return { ok: true, status: 200, text: async () => html };
      }
      return jsonResponse({
        metadata: { generated: Date.parse('2026-08-22T12:00:00Z') },
        features: [{
          properties: {
            mag: 6.2,
            place: '100 km east of Test City',
            time: Date.parse('2026-08-22T10:00:00Z'),
            url: 'https://earthquake.usgs.gov/earthquakes/eventpage/test',
            tsunami: 0,
            alert: 'green',
          },
        }],
      });
    }));

    const result = await lookupOfficialSources('最近全球有显著地震吗');

    expect(result.provider).toBe('cenc_official+usgs_official');
    expect(result.summary).toContain('中国地震台网速报目录');
    expect(result.summary).toContain('M6.2');
    expect(result.items[0].url).toContain('earthquake.cn');
    expect(result.items[1].url).toContain('earthquake.usgs.gov');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('filters CENC rows by an explicit Chinese location and reports a bounded evidence gap', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('data.earthquake.cn')) {
        const html = '<tr id="earthquake_subao_guid_catalog_tr_0">' + [
          '1', '2026-8-22 11:40:13', '122.08', '24.38', '28', '4.5', '台湾宜兰县海域', '天然地震',
        ].map((value) => `<td><div class="cls-data-content-list">${value}</div></td>`).join('') + '</tr>';
        return { ok: true, status: 200, text: async () => html };
      }
      return jsonResponse({ metadata: { generated: Date.now() }, features: [] });
    }));

    const result = await lookupOfficialSources('广州刚才是不是地震了');

    expect(result.summary).toContain('“广州”');
    expect(result.summary).toContain('不能单独证明没有地震');
    expect(result.summary).not.toContain('M4.5 台湾');
    expect(__testing__.earthquakeLocationHint('广州刚才是不是地震了')).toBe('广州');
  });

  it('merges World Bank and WHO observations for explicit life expectancy queries', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('api.worldbank.org')) {
        return jsonResponse([
          { lastupdated: '2026-07-13' },
          [{
            indicator: { value: 'Life expectancy at birth, total (years)' },
            date: '2024',
            value: 78.1,
          }],
        ]);
      }
      if (String(url).includes('ghoapi.azureedge.net')) {
        return jsonResponse({ value: [{ TimeDim: 2023, NumericValue: 77.8, Value: '77.8 [77.1-78.5]', Date: '2026-01-01' }] });
      }
      throw new Error('unexpected url');
    }));

    const result = await lookupOfficialSources('中国最新预期寿命是多少');

    expect(result.provider).toBe('world_bank_official_api+who_official_api');
    expect(result.summary).toContain('World Bank');
    expect(result.summary).toContain('WHO');
    expect(result.sources.map((source) => source.name)).toEqual(['world_bank_official_api', 'who_official_api']);
  });

  it('uses Hugging Face Hub metadata for an explicit model URL', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      id: 'google/gemma-4-E4B-it',
      downloads: 12345,
      likes: 321,
      private: false,
      lastModified: '2026-08-20T00:00:00Z',
      pipeline_tag: 'image-text-to-text',
      sha: 'abc123',
      siblings: [{ rfilename: 'README.md' }, { rfilename: 'model.safetensors' }],
    })));

    const result = await lookupOfficialSources('检查 https://huggingface.co/google/gemma-4-E4B-it 最近下载量');

    expect(result.provider).toBe('huggingface_official_api');
    expect(result.summary).toContain('12345 downloads');
    expect(result.items[0].snippet).toContain('sha=abc123');
  });

  it('parses explicit targets without treating vague words as package names', () => {
    expect(__testing__.parseGitHubTarget('看 https://github.com/LynnMerkyor/Lynn/issues/5')).toEqual({ owner: 'LynnMerkyor', repo: 'Lynn', issue: '5' });
    expect(__testing__.parseHuggingFaceRepo('https://huggingface.co/google/gemma-4-E4B-it')).toBe('google/gemma-4-E4B-it');
    expect(__testing__.parseArxivId('https://arxiv.org/pdf/2606.04101')).toBe('2606.04101');
    expect(__testing__.explicitPackageName('npm 最新版本', 'npm')).toBe('');
    expect(__testing__.explicitPackageName('npm package vite 最新版本', 'npm')).toBe('vite');
  });
});
