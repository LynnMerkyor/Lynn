/**
 * TTS Provider Registry · Lynn Voice Runtime
 *
 * Voice WS uses byte-returning providers. The older tts-bridge plugin remains
 * the file-saving tool path for chat message朗读.
 */
import { createCosyVoice2TtsProvider } from "./cosyvoice2.js";
import { createEdgeTtsProvider } from "./edge.js";
import { createStepFunRealtimeTtsProvider } from "../stepfun-realtime.js";
import { createBrainRealtimeTtsProvider } from "../brain-realtime-voice.js";

interface TTSConfig {
  provider?: string;
  fallback_provider?: string;
  fallbackProvider?: string;
  fallback?: TTSConfig;
  [key: string]: unknown;
}

interface TTSResult {
  [key: string]: unknown;
}

interface TTSProvider {
  name?: string;
  label?: string;
  synthesize(text: string, opts?: Record<string, unknown>): Promise<TTSResult> | TTSResult;
  synthesizeStream?(text: string, opts?: Record<string, unknown>): AsyncIterable<TTSResult>;
  health?(): Promise<boolean | { ok?: unknown }> | boolean | { ok?: unknown };
  [key: string]: unknown;
}

interface TTSFallbackDeps {
  primaryProvider?: TTSProvider;
  fallbackProvider?: TTSProvider;
}

type TTSProviderFactory = (config: TTSConfig) => TTSProvider;

function errorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err);
}

const PROVIDERS: Record<string, TTSProviderFactory> = {
  "brain-realtime": createBrainRealtimeTtsProvider,
  "brain-stepfun-realtime": createBrainRealtimeTtsProvider,
  "stepfun-realtime": createBrainRealtimeTtsProvider,
  "stepfun": createBrainRealtimeTtsProvider,
  "stepfun-direct": createStepFunRealtimeTtsProvider,
  "stepfun-byok": createStepFunRealtimeTtsProvider,
  spark: createBrainRealtimeTtsProvider,
  "spark-local": createBrainRealtimeTtsProvider,
  cosyvoice: createCosyVoice2TtsProvider,
  cosyvoice2: createCosyVoice2TtsProvider,
  "cosyvoice-2": createCosyVoice2TtsProvider,
  edge: createEdgeTtsProvider,
  "edge-tts": createEdgeTtsProvider,
};

export function createTTSProvider(config: TTSConfig = {}): TTSProvider {
  const providerId = config.provider || "brain-realtime";
  const factory = PROVIDERS[providerId];
  if (!factory) {
    throw new Error(`Unknown TTS provider: ${providerId}. Available: ${Object.keys(PROVIDERS).join(", ")}`);
  }
  return factory(config);
}

export function createTTSFallbackProvider(config: TTSConfig = {}, deps: TTSFallbackDeps = {}): TTSProvider {
  const primaryProvider = config.provider || "brain-realtime";
  const primary = deps.primaryProvider || createTTSProvider({ ...config, provider: primaryProvider });
  const fallbackProvider = config.fallback?.provider || config.fallback_provider || config.fallbackProvider || "brain-realtime";

  if (primaryProvider === fallbackProvider && !deps.fallbackProvider) {
    return primary;
  }

  const fallbackConfig = {
    ...(config.fallback || {}),
    provider: fallbackProvider,
  };
  const fallback = deps.fallbackProvider || createTTSProvider(fallbackConfig);

  // 2026-05-01 P0-② — primary 支持 synthesizeStream 时透传(优先);否则不暴露,
  // voice-ws 看到 provider 没 synthesizeStream 自动回退到 synthesize 整段路径
  const supportsStream = typeof primary.synthesizeStream === "function";
  const primarySynthesizeStream = primary.synthesizeStream?.bind(primary);

  return {
    name: `${primary.name || "tts"}+fallback`,
    label: `${primary.label || primary.name || "TTS"} with fallback`,

    async synthesize(text: string, opts: Record<string, unknown> = {}) {
      try {
        return await primary.synthesize(text, opts);
      } catch (err) {
        const primaryError = errorMessage(err);
        try {
          const result = await fallback.synthesize(text, opts);
          return {
            ...result,
            fallbackUsed: true,
            primaryError,
          };
        } catch (fallbackErr) {
          throw new Error(`${primary.name || primaryProvider} failed: ${primaryError}; ${fallback.name || fallbackProvider} failed: ${errorMessage(fallbackErr)}`);
        }
      }
    },

    // 2026-05-01 P0-② 流式接力:首 chunk 出来就吐,fallback 失败时改走 synthesize 整段
    ...(supportsStream ? {
      async *synthesizeStream(text: string, opts: Record<string, unknown> = {}) {
        try {
          for await (const chunk of primarySynthesizeStream?.(text, opts) || []) {
            yield chunk;
          }
          return;
        } catch (err) {
          // 主链流式失败 → fallback synthesize 整段 → 包装成单 chunk yield
          const primaryError = errorMessage(err);
          try {
            const fallbackResult = await fallback.synthesize(text, opts);
            yield {
              ...fallbackResult,
              fallbackUsed: true,
              primaryError,
            };
          } catch (fallbackErr) {
            throw new Error(`${primary.name || primaryProvider} failed: ${primaryError}; ${fallback.name || fallbackProvider} failed: ${errorMessage(fallbackErr)}`);
          }
        }
      },
    } : {}),

    async health() {
      const [primaryOk, fallbackOk] = await Promise.all([
        healthOf(primary),
        healthOf(fallback),
      ]);
      return {
        ok: primaryOk,
        fallbackOk,
        degraded: !primaryOk && fallbackOk,
      };
    },
  };
}

async function healthOf(provider: TTSProvider | null | undefined): Promise<boolean> {
  if (!provider || typeof provider.health !== "function") return true;
  try {
    const value = await provider.health();
    if (typeof value === "object" && value && "ok" in value) return !!value.ok;
    return !!value;
  } catch {
    return false;
  }
}

export { createCosyVoice2TtsProvider, createEdgeTtsProvider };
