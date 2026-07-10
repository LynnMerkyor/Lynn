import { afterEach, describe, expect, it } from 'vitest';
import { buildDirectEvidencePrefetchPlans } from '../direct-evidence-policy.js';

const envKeys = [
  'BRAIN_V2_DIRECT_WEATHER_PREFETCH',
  'BRAIN_V2_DIRECT_SPORTS_PREFETCH',
  'BRAIN_V2_DIRECT_MARKET_PREFETCH',
];

afterEach(() => {
  for (const key of envKeys) delete process.env[key];
});

describe('direct evidence prefetch policy', () => {
  it('selects the realtime tool without selecting a model answer', () => {
    const plans = buildDirectEvidencePrefetchPlans([
      { role: 'user', content: '深圳明天会下雨吗？' },
    ]);

    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      kind: 'weather',
      toolName: 'weather',
      providerId: 'step-3.7-flash',
    });
  });

  it('does not prefetch the same evidence ledger twice', () => {
    const intent = [{ role: 'user', content: '今晚世界杯有几场？' }];
    const evidence = [
      ...intent,
      { role: 'user', content: '【Lynn 工具证据 #1: sports_score】\nprovider: espn_scoreboard' },
    ];

    expect(buildDirectEvidencePrefetchPlans(intent, evidence)).toEqual([]);
  });

  it('honors per-tool kill switches', () => {
    process.env.BRAIN_V2_DIRECT_MARKET_PREFETCH = '0';
    expect(buildDirectEvidencePrefetchPlans([
      { role: 'user', content: '纳斯达克最新点位是多少？' },
    ])).toEqual([]);
  });
});
