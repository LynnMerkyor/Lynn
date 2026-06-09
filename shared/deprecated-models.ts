export type ModelRefLike = {
  id?: unknown;
  provider?: unknown;
  base_url?: unknown;
  baseUrl?: unknown;
};

const DEPRECATED_MIMO_LLM_PROVIDERS = new Set([
  "mimo",
  "xiaomi",
  "xiaomimimo",
  "mimo-token-plan",
  "xiaomi-mimo",
]);

const DEPRECATED_MIMO_LLM_MODEL_IDS = new Set([
  "mimo-v2-flash",
  "mimo-v2-pro",
  "mimo-v2.5",
  "mimo-v2.5-pro",
  "xiaomi/mimo-v2-flash",
  "xiaomi/mimo-v2-pro",
  "xiaomi/mimo-v2.5",
  "xiaomi/mimo-v2.5-pro",
]);

function normalize(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

export function isDeprecatedMimoLlmProvider(provider: unknown): boolean {
  return DEPRECATED_MIMO_LLM_PROVIDERS.has(normalize(provider));
}

export function isDeprecatedMimoLlmModelId(modelId: unknown): boolean {
  const id = normalize(modelId);
  if (!id) return false;
  if (DEPRECATED_MIMO_LLM_MODEL_IDS.has(id)) return true;
  return /(?:^|\/)mimo-v2(?:\.5)?(?:-(?:pro|flash))?$/.test(id);
}

export function isDeprecatedMimoTokenPlanBaseUrl(baseUrl: unknown): boolean {
  const value = normalize(baseUrl);
  if (!value) return false;
  return value.includes("token-plan-cn.xiaomimimo.com");
}

export function isDeprecatedMimoLlmRef(modelId: unknown, provider?: unknown): boolean {
  if (isDeprecatedMimoLlmModelId(modelId)) return true;
  return isDeprecatedMimoLlmProvider(provider) && /mimo/i.test(String(modelId || ""));
}

export function isDeprecatedMimoLlmModelRef(ref: ModelRefLike | null | undefined): boolean {
  if (!ref) return false;
  return isDeprecatedMimoLlmRef(ref.id, ref.provider)
    || (isDeprecatedMimoLlmProvider(ref.provider) && isDeprecatedMimoTokenPlanBaseUrl(ref.base_url || ref.baseUrl));
}
