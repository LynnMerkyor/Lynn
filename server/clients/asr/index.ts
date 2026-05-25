/**
 * ASR Provider Registry · v0.77
 *
 * 统一接口：transcribe(audioBuffer, opts) + health()
 * 支持 provider：faster-whisper（默认）/ openai-whisper / azure-stt
 *
 * 配置来源（优先级从高到低）：
 *   1. engine.config.voice.asr
 *   2. 环境变量 LYNN_ASR_URL
 *   3. 内置默认值
 */
import { createSenseVoiceProvider } from "./sensevoice.js";
import { createQwen3AsrProvider } from "./qwen3-asr.js";
import { createFasterWhisperProvider } from "./faster-whisper.js";
import { createOpenAIWhisperProvider } from "./openai-whisper.js";
import { createAzureSTTProvider } from "./azure-stt.js";

interface ASRConfig {
  provider?: string;
  fallback_provider?: string;
  fallbackProvider?: string;
  fallback?: ASRConfig;
  [key: string]: unknown;
}

interface ASRProvider {
  name?: string;
  label?: string;
  transcribe(audioBuffer: unknown, opts?: Record<string, unknown>): Promise<Record<string, unknown>> | Record<string, unknown>;
  health?(): Promise<boolean | { ok?: unknown }> | boolean | { ok?: unknown };
  [key: string]: unknown;
}

interface ASRFallbackDeps {
  primaryProvider?: ASRProvider;
  fallbackProvider?: ASRProvider;
}

type ASRProviderFactory = (config: ASRConfig) => ASRProvider;

function errorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err);
}

const PROVIDERS: Record<string, ASRProviderFactory> = {
  "qwen3-asr": createQwen3AsrProvider,
  "qwen3": createQwen3AsrProvider,
  "qwen": createQwen3AsrProvider,
  "sensevoice": createSenseVoiceProvider,
  "faster-whisper": createFasterWhisperProvider,
  "openai": createOpenAIWhisperProvider,
  "openai-whisper": createOpenAIWhisperProvider,
  "azure": createAzureSTTProvider,
  "azure-stt": createAzureSTTProvider,
};

export function listASRProviders() {
  return [
    { id: "qwen3-asr", label: "Qwen3-ASR-0.6B (V0.79 Jarvis Runtime)", needsKey: false },
    { id: "sensevoice", label: "SenseVoice (达摩院・推荐)", needsKey: false, default: true },
    { id: "faster-whisper", label: "Faster Whisper (自托管)", needsKey: false },
    { id: "openai", label: "OpenAI Whisper API", needsKey: true },
    { id: "azure", label: "Azure Speech-to-Text", needsKey: true },
  ];
}

export function createASRProvider(config: ASRConfig = {}): ASRProvider {
  const providerId = config.provider || "sensevoice";
  const factory = PROVIDERS[providerId];
  if (!factory) {
    console.warn(`[ASR] Unknown provider "${providerId}", falling back to sensevoice`);
    return createSenseVoiceProvider(config);
  }
  return factory(config);
}

export function createASRFallbackProvider(config: ASRConfig = {}, deps: ASRFallbackDeps = {}): ASRProvider {
  const primaryProvider = config.provider || "qwen3-asr";
  const fallbackProvider = config.fallback_provider || config.fallbackProvider || "sensevoice";
  const primary = deps.primaryProvider || createASRProvider({ ...config, provider: primaryProvider });
  if (primaryProvider === fallbackProvider && !deps.fallbackProvider) {
    return primary;
  }
  const fallback = deps.fallbackProvider || createASRProvider({
    ...(config.fallback || {}),
    provider: fallbackProvider,
  });

  return {
    name: `${primary.name || primaryProvider}+fallback`,
    label: `${primary.label || primaryProvider} with fallback`,

    async transcribe(audioBuffer: unknown, opts: Record<string, unknown> = {}) {
      try {
        return await primary.transcribe(audioBuffer, opts);
      } catch (err) {
        const result = await fallback.transcribe(audioBuffer, opts);
        return {
          ...result,
          fallbackUsed: true,
          primaryError: errorMessage(err),
        };
      }
    },

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

async function healthOf(provider: ASRProvider | null | undefined): Promise<boolean> {
  if (!provider || typeof provider.health !== "function") return true;
  try {
    const value = await provider.health();
    if (typeof value === "object" && value && "ok" in value) return !!value.ok;
    return !!value;
  } catch {
    return false;
  }
}
