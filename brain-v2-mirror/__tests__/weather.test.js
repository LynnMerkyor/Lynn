import { afterEach, describe, expect, it, vi } from 'vitest';

import { __testing__, weather } from '../tool-exec/weather.js';

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  };
}

describe('weather multi-source fallback', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    ['明天深圳天气如何', '深圳'],
    ['今晚广州会下雨吗', '广州'],
    ['广州天河区明天会不会下雨', '广州天河区'],
    ['明天东京天气怎么样', '东京'],
    ['巴黎今晚会下雨吗', '巴黎'],
    ['weather in London tomorrow', 'London'],
  ])('extracts the location from %s', (query, expected) => {
    expect(__testing__.resolveDisplayCity(query)).toBe(expected);
  });

  it('uses CMA official observations and forecasts for Chinese cities', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const value = String(url);
      if (value.includes('weather.cma.cn/api/autocomplete')) {
        return jsonResponse({ code: 0, data: ['59493|深圳|Shenzuo|中国'] });
      }
      if (value.includes('weather.cma.cn/api/weather/view')) {
        return jsonResponse({
          code: 0,
          data: {
            location: { id: '59493', name: '深圳' },
            now: { temperature: 28.3, feelst: 33.6, humidity: 91, precipitation: 0.1, windDirection: '东北风', windSpeed: 1.4 },
            alarm: [{ title: '深圳市气象台发布暴雨橙色预警' }],
            lastUpdate: '2026/08/22 20:25',
            daily: [
              { date: '2026/08/22', high: 32, low: 26, dayText: '雷阵雨', nightText: '中雨' },
              { date: '2026/08/23', high: 32, low: 25, dayText: '雷阵雨', nightText: '中雨' },
            ],
          },
        });
      }
      throw new Error('secondary provider unavailable in this test');
    }));

    const result = await weather('明天深圳天气如何');

    expect(result).toContain('深圳天气（中国气象局）');
    expect(result).toContain('provider: cma');
    expect(result).toContain('查询重点: 明天 2026/08/23');
    expect(result).toContain('暴雨橙色预警');
  });

  it('falls back to global Open-Meteo geocoding and forecast', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const value = String(url);
      if (value.includes('weather.cma.cn/api/autocomplete')) {
        return jsonResponse({ code: 0, data: ['59287|广州|Guangzhou|中国'] });
      }
      if (value.includes('geocoding-api.open-meteo.com')) {
        return jsonResponse({ results: [{ name: 'Paris', latitude: 48.8566, longitude: 2.3522, timezone: 'Europe/Paris' }] });
      }
      if (value.includes('api.open-meteo.com/v1/forecast')) {
        return jsonResponse({
          current: { time: '2026-08-22T14:00', temperature_2m: 24.1, apparent_temperature: 24.3, relative_humidity_2m: 55, weather_code: 1, precipitation: 0, wind_speed_10m: 8.2 },
          daily: {
            time: ['2026-08-22', '2026-08-23', '2026-08-24'],
            weather_code: [1, 61, 2],
            temperature_2m_max: [26, 23, 25],
            temperature_2m_min: [17, 16, 15],
            precipitation_sum: [0, 3.2, 0],
            precipitation_probability_max: [5, 78, 10],
          },
        });
      }
      throw new Error('wttr unavailable in this test');
    }));

    const result = await weather('weather in Paris tomorrow');

    expect(result).toContain('Paris天气（Open-Meteo）');
    expect(result).toContain('provider: open-meteo');
    expect(result).toContain('明天 2026-08-23');
    expect(result).toContain('最高降水概率 78%');
  });

  it('rejects an error JSON from the search fallback when all direct sources fail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    const webSearchFn = vi.fn(async () => JSON.stringify({ ok: false, error: 'all search sources failed' }));

    const result = await weather('明天深圳天气如何', { webSearchFn });
    const parsed = JSON.parse(result);

    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe('all weather sources failed');
    expect(parsed.sources).toEqual(['cma', 'open-meteo', 'wttr.in']);
    expect(result).not.toContain('mimo unusable result');
    expect(webSearchFn).toHaveBeenCalledTimes(1);
  });
});
