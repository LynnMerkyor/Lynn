export interface ProviderPreset {
  provider: string;
  baseUrl: string;
  model: string;
}

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  stepfun: {
    provider: "openai-compatible",
    baseUrl: "https://api.stepfun.com/step_plan/v1",
    model: "step-3.7-flash",
  },
  deepseek: {
    provider: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
  },
  openai: {
    provider: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o",
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
