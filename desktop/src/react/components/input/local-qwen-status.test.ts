import { describe, expect, it } from 'vitest';
import {
  deriveLocalQwenRuntimeState,
  LOCAL_QWEN35_MODEL_ID,
  LOCAL_QWEN35_PROVIDER_ID,
  LOCAL_QWEN_PROMPT_DISMISS_KEY,
  LOCAL_QWEN_PROMPT_NEVER_KEY,
  LOCAL_QWEN_PROMPT_SNOOZE_UNTIL_KEY,
  LOCAL_QWEN_PROMPT_SHOWN_KEY,
  isLocalQwenPromptSnoozed,
  type LocalQwen35RuntimeStatus,
} from './local-qwen-status';

describe('local Qwen status derivation', () => {
  it('recognizes the default 27B endpoint and formats live TPS', () => {
    const status: LocalQwen35RuntimeStatus = {
      ok: true,
      runtime: {
        endpoint_running: true,
        serves_default_model: true,
        base_url: 'http://127.0.0.1:18099/v1',
        model_ids: [LOCAL_QWEN35_MODEL_ID],
        slots: { total: 1, busy: 1 },
        metrics_available: true,
        metrics: {
          prompt_tokens_total: 100,
          predicted_tokens_total: 250,
          requests_total: 3,
          predicted_tps: 18.4,
        },
      },
    };
    const derived = deriveLocalQwenRuntimeState(status, false, {
      id: LOCAL_QWEN35_MODEL_ID,
      provider: LOCAL_QWEN35_PROVIDER_ID,
    });
    expect(derived.running).toBe(true);
    expect(derived.current).toBe(true);
    expect(derived.endpointOccupied).toBe(false);
    expect(derived.tpsSummary).toBe('当前 18 tok/s');
    expect(derived.metricSummary).toBe('服务累计处理 350 tokens');
    expect(derived.slotSummary).toBe('生成中 1/1');
  });

  it('treats a live non-default local endpoint as occupied instead of default-ready', () => {
    const status: LocalQwen35RuntimeStatus = {
      runtime: {
        endpoint_running: true,
        endpoint_running_any: true,
        model_ids: ['qwen35-4b-q4km'],
      },
    };
    const derived = deriveLocalQwenRuntimeState(status, false, null);
    expect(derived.running).toBe(false);
    expect(derived.endpointOccupied).toBe(true);
    expect(derived.active).toBe(true);
  });

  it('does not hide the install recommendation just because it was shown today', () => {
    const today = '2026-06-27';
    const now = Date.parse(`${today}T12:00:00Z`);
    const values = new Map<string, string>([[LOCAL_QWEN_PROMPT_SHOWN_KEY, today]]);
    const storage = { getItem: (key: string) => values.get(key) || null };
    expect(isLocalQwenPromptSnoozed(storage, now)).toBe(false);

    values.set(LOCAL_QWEN_PROMPT_DISMISS_KEY, today);
    expect(isLocalQwenPromptSnoozed(storage, now)).toBe(true);
  });

  it('supports a seven-day snooze and a permanent opt-out', () => {
    const now = Date.parse('2026-06-27T12:00:00Z');
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) || null };

    values.set(LOCAL_QWEN_PROMPT_SNOOZE_UNTIL_KEY, String(now + 7 * 24 * 60 * 60 * 1000));
    expect(isLocalQwenPromptSnoozed(storage, now)).toBe(true);
    expect(isLocalQwenPromptSnoozed(storage, now + 8 * 24 * 60 * 60 * 1000)).toBe(false);

    values.set(LOCAL_QWEN_PROMPT_NEVER_KEY, '1');
    expect(isLocalQwenPromptSnoozed(storage, now + 365 * 24 * 60 * 60 * 1000)).toBe(true);
  });
});
