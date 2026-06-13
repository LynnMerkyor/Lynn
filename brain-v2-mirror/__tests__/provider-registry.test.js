import { describe, it, expect } from 'vitest';
import { getProvider, getProviderStatusSnapshot, PROVIDERS, providerOrderForCapability, universalOrder } from '../provider-registry.js';

describe('provider registry', () => {
  it('keeps StepFun low-reasoning + 48K in the intended universal fallback head position', () => {
    expect(universalOrder.map(String).slice(0, 4)).toEqual([
      'step-3.7-flash',
      'apex-spark-i-balanced',
      'deepseek-chat',
      'deepseek-pro',
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
    expect(step.default_reasoning_effort).toBe('low');
    expect(step.max_tokens).toBe(49_152);
    expect(step.thinking_control).toBeUndefined();
    expect(step.capability).toMatchObject({
      vision: true,
      audio: false,
      video: true,
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

  it('routes vision to StepFun as the head vision-capable provider', () => {
    const visionOrder = providerOrderForCapability({ vision: true })
      .map((id) => PROVIDERS[id])
      .filter((provider) => provider?.capability?.vision)
      .map((provider) => String(provider.id));

    // StepFun (step-3.7-flash) now covers vision itself (vision_model=step-1o-turbo-vision via the
    // openai-compat adapter switch) and is the head — MiMo is no longer the vision fallback.
    expect(visionOrder[0]).toBe('step-3.7-flash');
    expect(visionOrder).toContain('step-3.7-flash');
    expect(universalOrder.map(String)[0]).toBe('step-3.7-flash');
    expect(visionOrder).not.toContain('apex-spark-i-balanced');
    expect(visionOrder).not.toContain('deepseek-chat');
  });

  it('exposes a sanitized provider status snapshot without leaking keys', () => {
    const snapshot = getProviderStatusSnapshot();
    const step = snapshot.providers.find((provider) => provider.id === 'step-3.7-flash');
    const spark = snapshot.providers.find((provider) => provider.id === 'apex-spark-i-balanced');

    expect(snapshot.route.slice(0, 3)).toEqual(['step-3.7-flash', 'apex-spark-i-balanced', 'deepseek-chat']);
    expect(step).toMatchObject({ id: 'step-3.7-flash', credential: expect.any(String), inRoute: true });
    expect(spark).toMatchObject({
      credential: 'not_required',
      configured: true,
      local: true,
      routeRole: 'local_single_slot_manager',
      localConcurrencyLimit: 1,
      busyFallbackProvider: 'step-3.7-flash or ds-v4-flash',
    });
    expect(JSON.stringify(snapshot)).not.toContain('apiKey');
  });
});
