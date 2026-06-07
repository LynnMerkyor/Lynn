/**
 * TTS Provider Registry · v0.77 (CosyVoice stream default 2026-05-28; MiMo TTS removed 2026-06-07)
 *
 * 统一接口:synthesize({ text, voice, speed, outPath })
 * 支持 provider:cosyvoice (默认) / edge / say / openai
 *
 * 默认值对齐 manifest.json provider.default = 'cosyvoice':
 *   - cosyvoice Spark 本地服务:短文本低延迟、真流式、零 token 成本
 *   - edge/say/openai 作为用户可选 fallback / BYOK
 *
 * 配置来源:engine.config.voice.tts
 */
import { createCosyVoiceProvider } from "./providers/cosyvoice.js";
import { createEdgeTTSProvider } from "./providers/edge-tts.js";
import { createMacOSSayProvider } from "./providers/macos-say.js";
import { createOpenAITTSProvider } from "./providers/openai-tts.js";

const PROVIDERS = {
  edge: createEdgeTTSProvider,
  cosyvoice: createCosyVoiceProvider,
  say: createMacOSSayProvider,
  openai: createOpenAITTSProvider,
};

export function listTTSProviders() {
  return [
    { id: "cosyvoice", label: "CosyVoice 2 (Spark・默认・真流式)", needsKey: false, default: true },
    { id: "edge", label: "Edge TTS (免费在线・备用)", needsKey: false },
    { id: "say", label: "macOS say (本地)", needsKey: false, platform: "darwin" },
    { id: "openai", label: "OpenAI TTS API", needsKey: true },
  ];
}

/**
 * 自动 provider 路由:按 config.provider(manifest 默认 'cosyvoice')。
 */
function pickProvider(config) {
  return config?.provider || "cosyvoice";
}

export function createTTSProvider(config = {}) {
  const providerId = pickProvider(config);
  const factory = PROVIDERS[providerId];
  if (!factory) {
    console.warn(`[TTS] Unknown provider "${providerId}", falling back to cosyvoice`);
    return createCosyVoiceProvider(config);
  }
  return factory(config);
}
