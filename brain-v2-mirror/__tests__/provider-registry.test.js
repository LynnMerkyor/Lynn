import { describe, it, expect } from 'vitest';
import { getProvider, getProviderStatusSnapshot, PROVIDERS, providerOrderForCapability, universalOrder } from '../provider-registry.js';

describe('provider registry', () => {
  it('keeps MiMo UltraSpeed as the text/tool execution head with StepFun and DS as fallback reviewers', () => {
    expect(universalOrder.map(String).slice(0, 6)).toEqual([
      'mimo-ultraspeed',
      'step-3.7-flash',
      'deepseek-chat',
      'apex-spark-i-balanced',
      'mimo-token-plan-pro',
      'deepseek-pro',
    ]);
  });

  it('registers MiMo ordinary API UltraSpeed separately from Token Plan', () => {
    const fast = getProvider('mimo-ultraspeed');
    expect(fast).toBeTruthy();
    expect(String(fast.id)).toBe('mimo-ultraspeed');
    expect(fast.endpoint).toBe('https://api.xiaomimimo.com/v1');
    expect(String(fast.model)).toBe('mimo-v2.5-pro-ultraspeed');
    expect(fast.apiKey).toBe(process.env.MIMO_ULTRASPEED_KEY || '');
    expect(fast.wire).toBe('openai');
    expect(fast.default_reasoning_effort).toBe('low');
    expect(fast.max_tokens).toBe(16_384);
    expect(fast.timeout_ms).toBe(30_000);
    expect(fast.capability).toMatchObject({
      vision: false,
      audio: false,
      video: false,
      tools: true,
      thinking: true,
      native_search: false,
    });
  });

  it('registers MiMo Token Plan Pro as a bounded tail fallback', () => {
    const tokenPlan = getProvider('mimo-token-plan-pro');
    expect(tokenPlan).toBeTruthy();
    expect(String(tokenPlan.id)).toBe('mimo-token-plan-pro');
    expect(tokenPlan.endpoint).toBe('https://token-plan-cn.xiaomimimo.com/v1');
    expect(String(tokenPlan.model)).toBe('mimo-v2.5-pro');
    expect(tokenPlan.apiKey).toBe(process.env.MIMO_TOKEN_PLAN_KEY || '');
    expect(tokenPlan.timeout_ms).toBe(30_000);
    expect(tokenPlan.capability.tools).toBe(true);
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
    expect(universalOrder.map(String)[0]).toBe('mimo-ultraspeed');
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
    expect(mimo.apiKey).toBe(process.env.MIMO_MULTIMODAL_KEY || '');
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
    const fast = snapshot.providers.find((provider) => provider.id === 'mimo-ultraspeed');
    const ds = snapshot.providers.find((provider) => provider.id === 'deepseek-chat');
    const step = snapshot.providers.find((provider) => provider.id === 'step-3.7-flash');
    const spark = snapshot.providers.find((provider) => provider.id === 'apex-spark-i-balanced');

    expect(snapshot.route.slice(0, 4)).toEqual(['mimo-ultraspeed', 'step-3.7-flash', 'deepseek-chat', 'apex-spark-i-balanced']);
    expect(fast).toMatchObject({ id: 'mimo-ultraspeed', routeRole: 'head', inRoute: true });
    expect(ds).toMatchObject({ id: 'deepseek-chat', routeRole: 'escape', inRoute: true });
    expect(step).toMatchObject({ id: 'step-3.7-flash', routeRole: 'escape', credential: expect.any(String), inRoute: true });
    expect(spark).toMatchObject({
      credential: 'not_required',
      configured: true,
      local: true,
      routeRole: 'local_single_slot_manager',
      localConcurrencyLimit: 1,
      busyFallbackProvider: 'mimo-ultraspeed or step-3.7-flash',
    });
    expect(JSON.stringify(snapshot)).not.toContain('apiKey');
  });
});
