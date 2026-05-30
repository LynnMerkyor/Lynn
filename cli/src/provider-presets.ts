export interface ProviderPreset {
  provider: string;
  baseUrl: string;
  model: string;
  description: string;
}

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  mimo: {
    provider: "openai-compatible",
    baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
    model: "mimo-v2.5-pro",
    description: "MiMo V2.5 Pro Token Plan route (matches Lynn Brain default family)",
  },
  stepfun: {
    provider: "openai-compatible",
    baseUrl: "https://api.stepfun.com/step_plan/v1",
    model: "step-3.7-flash",
    description: "StepFun 3.7 Flash fast text/coding fallback backend",
  },
  spark: {
    provider: "openai-compatible",
    baseUrl: "http://127.0.0.1:18098/v1",
    model: "qwen36-35b-a3b-apex-mtp",
    description: "Spark Qwen 3.6 35B A3B local fallback route",
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

export function presetNameForProviderProfile(profile: Pick<ProviderPreset, "baseUrl" | "model"> | null | undefined): string | null {
  if (!profile) return null;
  const baseUrl = profile.baseUrl.trim().replace(/\/+$/, "");
  const model = profile.model.trim();
  for (const [name, preset] of Object.entries(PROVIDER_PRESETS)) {
    if (preset.baseUrl.replace(/\/+$/, "") === baseUrl && preset.model === model) return name;
  }
  return null;
}
