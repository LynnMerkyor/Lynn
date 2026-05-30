import { describe, it, expect } from 'vitest';
import { getProvider, PROVIDERS, universalOrder } from '../provider-registry.js';

describe('provider registry', () => {
  it('keeps StepFun in the intended universal fallback position', () => {
    expect(universalOrder.map(String).slice(0, 4)).toEqual([
      'mimo',
      'apex-spark-i-balanced',
      'step-3.7-flash',
      'deepseek-chat',
    ]);
  });

  it('registers StepFun as a cloud vision/tools fallback without native search', () => {
    const step = getProvider('step-3.7-flash');
    expect(step).toBeTruthy();
    expect(String(step.id)).toBe('step-3.7-flash');
    expect(step.endpoint).toBe('https://api.stepfun.com/step_plan/v1');
    expect(String(step.model)).toBe('step-3.7-flash');
    expect(step.wire).toBe('openai');
    expect(step.cooldown_ms).toBe(60_000);
    expect(step.default_thinking).toBe(false);
    expect(step.capability).toMatchObject({
      vision: true,
      audio: false,
      video: false,
      tools: true,
      thinking: true,
      native_search: false,
    });
  });

  it('makes StepFun the second vision-capable option after MiMo', () => {
    const visionOrder = universalOrder
      .map((id) => PROVIDERS[id])
      .filter((provider) => provider?.capability?.vision)
      .map((provider) => String(provider.id));

    expect(visionOrder.slice(0, 2)).toEqual(['mimo', 'step-3.7-flash']);
    expect(visionOrder).not.toContain('apex-spark-i-balanced');
    expect(visionOrder).not.toContain('deepseek-chat');
  });
});
