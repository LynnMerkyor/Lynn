/**
 * SER (Speech Emotion Recognition) Provider Registry · Lynn V0.79
 *
 * 统一接口:classify(audioBuffer, opts) + warmup() + health()
 *
 * 默认 provider:emotion2vec+ base (DGX 部署)
 */
import { createEmotion2VecProvider, EMOTION_LLM_HINT } from "./emotion2vec-plus.js";

interface SERConfig {
  provider?: string;
  [key: string]: unknown;
}

interface SERProvider {
  name?: string;
  label?: string;
  classify?(audioBuffer: unknown, opts?: Record<string, unknown>): Promise<unknown> | unknown;
  warmup?(): Promise<unknown> | unknown;
  health?(): Promise<boolean | { ok?: unknown }> | boolean | { ok?: unknown };
  [key: string]: unknown;
}

type SERProviderFactory = (config: SERConfig) => SERProvider;

const PROVIDERS: Record<string, SERProviderFactory> = {
  "emotion2vec": createEmotion2VecProvider,
  "emotion2vec-plus": createEmotion2VecProvider,
  "emotion2vec-plus-base": createEmotion2VecProvider,
};

/**
 * 创建 SER Provider
 * @param {object} config
 * @returns {object} provider
 */
export function createSERProvider(config: SERConfig = {}): SERProvider {
  const providerName = config.provider || "emotion2vec-plus-base";
  const factory = PROVIDERS[providerName];
  if (!factory) {
    throw new Error(`Unknown SER provider: ${providerName}. Available: ${Object.keys(PROVIDERS).join(", ")}`);
  }
  return factory(config);
}

export { EMOTION_LLM_HINT };
