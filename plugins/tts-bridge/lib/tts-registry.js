/**
 * TTS Provider Registry · StepFun Realtime first.
 *
 * 统一接口:synthesize({ text, voice, speed, outPath })
 * 支持 provider:stepfun-realtime (默认) / cosyvoice / say / edge / openai
 *
 * 默认值对齐 manifest.json provider.default = 'stepfun-realtime':
 *   - stepfun-realtime 通过 Lynn Brain 托管 StepFun Realtime,不要求用户本地填 Key
 *   - cosyvoice/say/edge/openai 只作为旧配置兼容或显式选择
 *
 * 配置来源:engine.config.voice.tts
 *
 * Protocol/UX reference: StepFun official Step-Realtime-CLI (MIT). See NOTICE.
 */
import { createCosyVoiceProvider } from "./providers/cosyvoice.js";
import { createEdgeTTSProvider } from "./providers/edge-tts.js";
import { createMacOSSayProvider } from "./providers/macos-say.js";
import { createOpenAITTSProvider } from "./providers/openai-tts.js";
import { createBrainRealtimeTTSProvider } from "./providers/brain-realtime.js";

const PROVIDERS = {
  "brain-realtime": createBrainRealtimeTTSProvider,
  "brain-stepfun-realtime": createBrainRealtimeTTSProvider,
  "stepfun-realtime": createBrainRealtimeTTSProvider,
  stepfun: createBrainRealtimeTTSProvider,
  edge: createEdgeTTSProvider,
  cosyvoice: createCosyVoiceProvider,
  say: createMacOSSayProvider,
  openai: createOpenAITTSProvider,
};

export function listTTSProviders() {
  return [
    { id: "stepfun-realtime", label: "StepFun Realtime TTS (Lynn 云端・默认)", needsKey: false, default: true },
    { id: "cosyvoice", label: "CosyVoice 2 (legacy explicit)", needsKey: false },
    { id: "say", label: "macOS say (legacy explicit)", needsKey: false, platform: "darwin" },
    { id: "edge", label: "Edge TTS (legacy explicit)", needsKey: false },
    { id: "openai", label: "OpenAI TTS API", needsKey: true },
  ];
}

/**
 * 自动 provider 路由:按 config.provider(manifest 默认 'stepfun-realtime')。
 */
function pickProvider(config) {
  return config?.provider || "stepfun-realtime";
}

export function createTTSProvider(config = {}) {
  const providerId = pickProvider(config);
  const factory = PROVIDERS[providerId];
  if (!factory) {
    console.warn(`[TTS] Unknown provider "${providerId}", falling back to stepfun-realtime`);
    return createBrainRealtimeTTSProvider(config);
  }
  return factory(config);
}
