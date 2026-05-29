export interface ProviderPreset {
  provider: string;
  baseUrl: string;
  model: string;
  description: string;
}

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  stepfun: {
    provider: "openai-compatible",
    baseUrl: "https://api.stepfun.com/step_plan/v1",
    model: "step-3.7-flash",
    description: "StepFun 3.7 Flash fast coding / multimodal cloud backend",
  },
  deepseek: {
    provider: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    description: "DeepSeek OpenAI-compatible chat backend",
  },
  openai: {
    provider: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o",
    description: "OpenAI-compatible default example",
  },
};

export function resolveProviderPreset(name: string | null): ProviderPreset | null {
  if (!name) return null;
  const preset = PROVIDER_PRESETS[name.trim().toLowerCase()];
  if (!preset) {
    throw new Error(`unknown provider preset: ${name}. Available presets: ${Object.keys(PROVIDER_PRESETS).join(", ")}`);
  }
  return preset;
}

export function listProviderPresets(): Array<{ name: string } & ProviderPreset> {
  return Object.entries(PROVIDER_PRESETS)
    .map(([name, preset]) => ({ name, ...preset }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
