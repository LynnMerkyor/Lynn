import { describe, expect, it } from 'vitest';
import {
  buildCron,
  buildScheduleFromPreset,
  formatAutomationDateTime,
  inferSchedulePreset,
  parseCronDays,
  parseCronTime,
} from '../components/automation/cron-utils';

describe('automation cron utils', () => {
  it('parses cron time and weekdays', () => {
    expect(parseCronTime('30 9 * * 1-5')).toEqual({ hour: '09', minute: '30' });
    expect(parseCronDays('30 9 * * 1-5')).toEqual([1, 2, 3, 4, 5]);
    expect(parseCronDays('0 18 * * *')).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('infers schedule presets from cron day fields', () => {
    expect(inferSchedulePreset('0 9 * * *')).toBe('daily');
    expect(inferSchedulePreset('0 9 * * 1,2,3,4,5')).toBe('weekdays');
    expect(inferSchedulePreset('0 9 * * 5')).toBe('weekly');
    expect(inferSchedulePreset('0 9 * * 1,3,5')).toBe('custom');
  });

  it('builds cron expressions from presets', () => {
    expect(buildCron('09', '30', [])).toBe('30 9 * * *');
    expect(buildScheduleFromPreset('daily', '09', '30', 5, [])).toBe('30 9 * * *');
    expect(buildScheduleFromPreset('weekdays', '09', '30', 5, [])).toBe('30 9 * * 1,2,3,4,5');
    expect(buildScheduleFromPreset('weekly', '18', '00', 5, [])).toBe('0 18 * * 5');
    expect(buildScheduleFromPreset('custom', '11', '05', 5, [1, 3])).toBe('5 11 * * 1,3');
  });

  it('formats automation dates with a provided locale', () => {
    expect(formatAutomationDateTime('2026-05-28T09:30:00Z', 'en-US')).toContain('5/28');
    expect(formatAutomationDateTime(null, 'en-US')).toBe('');
  });
});
