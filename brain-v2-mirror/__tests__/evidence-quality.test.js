import { describe, expect, it } from 'vitest';
import {
  buildEvidencePolicyHint,
  containsGroundedToolDenialContradiction,
  classifySearchEvidencePolicy,
  containsTemporalNoResultContradiction,
  currentTemporalContext,
  enrichEvidenceSearchQuery,
  needsSourceGradeEvidence,
  normalizeSearchQueryIntent,
} from '../evidence-quality.js';

describe('Evidence Quality Protocol', () => {
  it('routes volatile factual queries to source-grade evidence without topic-specific tails', () => {
    expect(classifySearchEvidencePolicy('今晚蓝鲸杯有几场比赛')).toMatchObject({
      grade: 'source',
      reason: 'event-score-schedule-or-prediction',
    });
    expect(needsSourceGradeEvidence('世界杯半决赛在哪一天？')).toBe(true);
    expect(needsSourceGradeEvidence('深圳明天天气')).toBe(true);
    expect(needsSourceGradeEvidence('中国主要创业社群的人数，收费')).toBe(true);
    expect(needsSourceGradeEvidence('React useMemo 怎么用')).toBe(false);

    const enriched = enrichEvidenceSearchQuery('今晚世界杯有几场比赛');
    expect(enriched).toContain('official schedule results fixtures score date source');
    expect(enriched).not.toContain('2026 FIFA World Cup');
    expect(enriched).not.toContain('腾讯体育');
    expect(enriched).not.toContain('ESPN');

    const semifinal = enrichEvidenceSearchQuery('世界杯半决赛在哪一天？');
    expect(semifinal).toContain('official schedule dates semifinal final fixtures source');
  });

  it('adds evidence-use hints for source-grade queries', () => {
    const hint = buildEvidencePolicyHint('昨晚世界杯最新的比赛结果', new Date('2026-06-21T06:00:00Z'));

    expect(hint).toContain('证据使用提示');
    expect(hint).toContain('当前北京时间日期: 2026-06-21');
    expect(hint).toContain('赛事/赛程/比分/预测属于高波动问题');
    expect(hint).toContain('已知事实 / 证据缺口 / 可回答结论');
  });

  it('normalizes likely typoed World Cup intent but leaves unrelated event names alone', () => {
    expect(normalizeSearchQueryIntent('今晚世纪杯有几场比赛')).toBe('今晚世界杯有几场比赛');
    expect(normalizeSearchQueryIntent('新世纪杯英语演讲比赛')).toBe('新世纪杯英语演讲比赛');
  });

  it('exposes a deterministic temporal context and contradiction guard', () => {
    const now = new Date('2026-06-21T06:00:00Z');

    expect(currentTemporalContext(now)).toContain('今天=2026-06-21');
    expect(containsTemporalNoResultContradiction('2026年6月20日尚未开赛，没有比分。', now)).toBe(false);
    expect(containsTemporalNoResultContradiction('今天没有比分。', now)).toBe(false);
    expect(containsTemporalNoResultContradiction('目前暂无赛果数据。', now)).toBe(false);
    expect(containsTemporalNoResultContradiction('2026年6月22日尚未开赛，没有比分。', now)).toBe(false);
  });

  it('detects answers that deny tools after grounded evidence exists', () => {
    expect(containsGroundedToolDenialContradiction('Lynn CLI 的工具集中暂未包含天气查询功能。')).toBe(true);
    expect(containsGroundedToolDenialContradiction('当前工具不支持实时查询股价。')).toBe(true);
    expect(containsGroundedToolDenialContradiction('工具证据显示深圳明天晴天。')).toBe(false);
  });

  it.each([
    '现有证据不足，不能确认实时行情。',
    '搜索源返回429和超时，本次无法取得实时板块排行。',
    '当前工具只返回指数样本，无法判断实时全市场异动。',
    '没有拿到股价数据。工具返回上游超时。',
    '没有拿到天气数据，工具返回上游错误。',
    '今天是周日，不能把最近交易日报价当成实时行情。',
  ])('does not equate evidence limitations with missing tool capability: %s', (answer) => {
    expect(containsGroundedToolDenialContradiction(answer)).toBe(false);
  });

  it('does not reject a verified empty query window but still rejects past dates described as future', () => {
    const now = new Date('2026-10-09T10:00:00Z');
    expect(containsTemporalNoResultContradiction('昨晚查询窗口没有比赛记录，0 场。', now)).toBe(false);
    expect(containsTemporalNoResultContradiction('昨晚没有比赛记录，0 场；7月19日历史决赛比分为2-1。', now)).toBe(false);
    expect(containsTemporalNoResultContradiction('要到2026年6月11日才开赛，没有比分。', now)).toBe(true);
    expect(containsTemporalNoResultContradiction('今天是2026年10月9日，要到2027年6月11日才开赛。', now)).toBe(false);
    expect(containsTemporalNoResultContradiction('昨晚为2026年10月8日，要到2026-10-10才开赛。', now)).toBe(false);
    expect(containsTemporalNoResultContradiction('要到2026年10月9日今晚才开赛。', now)).toBe(false);
    expect(containsTemporalNoResultContradiction('要到2026-06-11才开赛。', now)).toBe(true);
  });

  it('does not equate a current date or partial evidence with complete data availability', () => {
    const now = new Date('2026-10-09T10:00:00Z');
    for (const answer of [
      '今天本轮只覆盖指数样本，没有全市场成交量数据，不能判断缩量。',
      '目前只有 US AQI，未返回中国 AQI 口径的信息。',
      '2026年10月9日搜索源失败，目前暂无可靠新闻数据。',
    ]) expect(containsTemporalNoResultContradiction(answer, now)).toBe(false);
    expect(containsTemporalNoResultContradiction('要到2026年6月11日才开赛。', now)).toBe(true);
    expect(containsTemporalNoResultContradiction('要到 **2026年6月11日** 才开赛。', now)).toBe(true);
  });
});
