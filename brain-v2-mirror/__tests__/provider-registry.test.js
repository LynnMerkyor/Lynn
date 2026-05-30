import { describe, it, expect } from 'vitest';
import { getProvider, getProviderStatusSnapshot, PROVIDERS, providerOrderForCapability, universalOrder } from '../provider-registry.js';

describe('provider registry', () => {
  it('keeps MiMo in the intended universal fallback head position', () => {
    expect(universalOrder.map(String).slice(0, 4)).toEqual([
      'mimo',
      'step-3.7-flash',
      'apex-spark-i-balanced',
      'deepseek-chat',
    ]);
  });

  it('registers StepFun as a cloud text/tools fallback without native search', () => {
    const step = getProvider('step-3.7-flash');
    expect(step).toBeTruthy();
    expect(String(step.id)).toBe('step-3.7-flash');
    expect(step.endpoint).toBe('https://api.stepfun.com/step_plan/v1');
    expect(String(step.model)).toBe('step-3.7-flash');
    expect(step.wire).toBe('openai');
    expect(step.cooldown_ms).toBe(60_000);
    expect(step.default_thinking).toBe(false);
    expect(step.thinking_control).toBeUndefined();
    expect(step.capability).toMatchObject({
      vision: false,
      audio: false,
      video: false,
      tools: true,
      thinking: true,
      native_search: false,
    });
  });

  it('keeps Qwen chat-template thinking control scoped to Spark only', () => {
    expect(getProvider('apex-spark-i-balanced').thinking_control).toBe('qwen_chat_template');
    expect(getProvider('step-3.7-flash').thinking_control).toBeUndefined();
    expect(getProvider('deepseek-chat').thinking_control).toBeUndefined();
  });

  it('keeps MiMo as the first-class vision and text route', () => {
    const visionOrder = providerOrderForCapability({ vision: true })
      .map((id) => PROVIDERS[id])
      .filter((provider) => provider?.capability?.vision)
      .map((provider) => String(provider.id));

    expect(visionOrder[0]).toBe('mimo');
    expect(visionOrder).not.toContain('step-3.7-flash');
    expect(universalOrder.map(String).slice(0, 2)).toEqual(['mimo', 'step-3.7-flash']);
    expect(visionOrder).not.toContain('apex-spark-i-balanced');
    expect(visionOrder).not.toContain('deepseek-chat');
  });

  it('exposes a sanitized provider status snapshot without leaking keys', () => {
    const snapshot = getProviderStatusSnapshot();
    const step = snapshot.providers.find((provider) => provider.id === 'step-3.7-flash');
    const spark = snapshot.providers.find((provider) => provider.id === 'apex-spark-i-balanced');

    expect(snapshot.route.slice(0, 2)).toEqual(['mimo', 'step-3.7-flash']);
    expect(step).toMatchObject({ id: 'step-3.7-flash', credential: expect.any(String), inRoute: true });
    expect(spark).toMatchObject({ credential: 'not_required', configured: true, local: true });
    expect(JSON.stringify(snapshot)).not.toContain('apiKey');
  });
});
