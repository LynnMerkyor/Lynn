export type SchedulePreset = 'daily' | 'weekdays' | 'weekly' | 'custom';

const WEEKDAY_SET = '1,2,3,4,5';

export function formatAutomationDateTime(
  ts?: string | number | null,
  locale = String(window.i18n?.locale || 'zh-CN'),
): string {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleString(locale, {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

export function parseCronTime(schedule: string | number): { hour: string; minute: string } | null {
  if (typeof schedule !== 'string') return null;
  const parts = String(schedule).split(' ');
  if (parts.length !== 5) return null;
  const [min, hour] = parts;
  if (hour === '*' || min === '*') return null;
  return {
    hour: String(parseInt(hour, 10)).padStart(2, '0'),
    minute: String(parseInt(min, 10)).padStart(2, '0'),
  };
}

export function parseCronDays(schedule: string | number): number[] {
  if (typeof schedule !== 'string') return [];
  const parts = String(schedule).split(' ');
  if (parts.length !== 5) return [];
  const dow = String(parts[4] || '').trim();
  if (!dow || dow === '*') return [0, 1, 2, 3, 4, 5, 6];
  if (dow === '1-5') return [1, 2, 3, 4, 5];
  return dow
    .split(',')
    .map((value) => parseInt(value, 10))
    .filter((value) => !Number.isNaN(value) && value >= 0 && value <= 6);
}

export function inferSchedulePreset(schedule: string | number): SchedulePreset {
  if (typeof schedule !== 'string') return 'custom';
  const parts = String(schedule).split(' ');
  if (parts.length !== 5) return 'custom';
  const dow = String(parts[4] || '').trim();
  if (!dow || dow === '*') return 'daily';
  if (dow === '1-5' || dow === WEEKDAY_SET) return 'weekdays';
  if (/^\d$/.test(dow)) return 'weekly';
  return 'custom';
}

export function buildCron(hour: string, minute: string, days: number[]): string {
  const normalizedHour = String(parseInt(hour || '9', 10)).padStart(2, '0');
  const normalizedMinute = String(parseInt(minute || '0', 10)).padStart(2, '0');
  const uniqueDays = Array.from(new Set(days)).sort((left, right) => left - right);
  const dowPart = uniqueDays.length === 0 || uniqueDays.length === 7 ? '*' : uniqueDays.join(',');
  return `${parseInt(normalizedMinute, 10)} ${parseInt(normalizedHour, 10)} * * ${dowPart}`;
}

export function buildScheduleFromPreset(
  preset: SchedulePreset,
  hour: string,
  minute: string,
  weeklyDay: number,
  customDays: number[],
): string {
  if (preset === 'daily') return buildCron(hour, minute, []);
  if (preset === 'weekdays') return buildCron(hour, minute, [1, 2, 3, 4, 5]);
  if (preset === 'weekly') return buildCron(hour, minute, [weeklyDay]);
  return buildCron(hour, minute, customDays.length > 0 ? customDays : [1]);
}
