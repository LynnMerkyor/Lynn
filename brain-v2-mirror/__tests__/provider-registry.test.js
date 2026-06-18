import { describe, it, expect } from 'vitest';
import { getProvider, getProviderStatusSnapshot, PROVIDERS, providerOrderForCapability, universalOrder } from '../provider-registry.js';

describe('provider registry', () => {
  it('keeps DS V4 Flash as the text/tool orchestration head with StepFun as fast fallback', () => {
    expect(universalOrder.map(String).slice(0, 4)).toEqual([
      'deepseek-chat',
      'step-3.7-flash',
      'apex-spark-i-balanced',
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

  it('routes vision to StepFun first and MiMo multimodal as native fallback', () => {
    const visionOrder = providerOrderForCapability({ vision: true })
      .map((id) => PROVIDERS[id])
      .filter((provider) => provider?.capability?.vision)
      .map((provider) => String(provider.id));

    expect(visionOrder[0]).toBe('step-3.7-flash');
    expect(visionOrder[1]).toBe('mimo-multimodal');
    expect(visionOrder).toContain('step-3.7-flash');
    expect(visionOrder).toContain('mimo-multimodal');
    expect(universalOrder.map(String)[0]).toBe('deepseek-chat');
    expect(visionOrder).not.toContain('apex-spark-i-balanced');
    expect(visionOrder).not.toContain('deepseek-chat');
  });

  it('routes native audio to MiMo multimodal after filtering non-audio providers', () => {
    const audioCapableOrder = providerOrderForCapability({ audio: true })
      .map((id) => PROVIDERS[id])
      .filter((provider) => provider?.capability?.audio)
      .map((provider) => String(provider.id));

    expect(audioCapableOrder[0]).toBe('mimo-multimodal');
    expect(audioCapableOrder).toEqual(['mimo-multimodal']);
  });

  it('registers MiMo as native image/audio/video fallback without taking over text route', () => {
    const mimo = getProvider('mimo-multimodal');
    expect(mimo).toBeTruthy();
    expect(String(mimo.id)).toBe('mimo-multimodal');
    expect(mimo.endpoint).toBe('https://token-plan-cn.xiaomimimo.com/v1');
    expect(String(mimo.model)).toBe('mimo-v2.5');
    expect(mimo.wire).toBe('openai');
    expect(mimo.capability).toMatchObject({
      vision: true,
      audio: true,
      video: true,
      tools: false,
      thinking: true,
      native_search: false,
    });
    expect(universalOrder.map(String)).not.toContain('mimo-multimodal');
    expect(providerOrderForCapability({ audio: true }).map(String)).toContain('mimo-multimodal');
    expect(providerOrderForCapability({ video: true }).map(String)).toContain('mimo-multimodal');
  });

  it('exposes a sanitized provider status snapshot without leaking keys', () => {
    const snapshot = getProviderStatusSnapshot();
    const ds = snapshot.providers.find((provider) => provider.id === 'deepseek-chat');
    const step = snapshot.providers.find((provider) => provider.id === 'step-3.7-flash');
    const spark = snapshot.providers.find((provider) => provider.id === 'apex-spark-i-balanced');

    expect(snapshot.route.slice(0, 3)).toEqual(['deepseek-chat', 'step-3.7-flash', 'apex-spark-i-balanced']);
    expect(ds).toMatchObject({ id: 'deepseek-chat', routeRole: 'head', inRoute: true });
    expect(step).toMatchObject({ id: 'step-3.7-flash', credential: expect.any(String), inRoute: true });
    expect(spark).toMatchObject({
      credential: 'not_required',
      configured: true,
      local: true,
      routeRole: 'local_single_slot_manager',
      localConcurrencyLimit: 1,
      busyFallbackProvider: 'ds-v4-flash or step-3.7-flash',
    });
    expect(JSON.stringify(snapshot)).not.toContain('apiKey');
  });
});
