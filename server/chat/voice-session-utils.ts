import { debugLog } from "../../lib/debug-log.js";
import { stripEmojiForTts } from "../../shared/tts-text-normalizer.js";
import { EMOTION_LLM_HINT } from "../clients/ser/index.js";
import {
  decodePcm16Audio,
  PCM_SAMPLE_RATE,
  pcm16ToWav,
} from "./voice-audio-codec.js";
import type {
  BrainRunner,
  EmotionResult,
  HealthProvider,
  JsonRecord,
  ProviderHealth,
  TtsPiece,
  VadConfig,
  VoiceEngine,
} from "./voice-ws-types.js";

export const TTS_MAX_SEGMENT_CHARS = 80;
export const TTS_RETRY_MIN_SEGMENT_CHARS = 24;
export const TTS_SEGMENT_TIMEOUT_MS = 45000;
export const EMOTION_CURRENT_TURN_WAIT_MS = 250;

export const DEFAULT_VAD_CONFIG = Object.freeze({
  enabled: true,
  speechRms: 0.012,
  silenceRms: 0.006,
  minSpeechFrames: 1,
  endSilenceFrames: 5,
});

export function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

export function asEmotion(value: unknown): EmotionResult | null {
  const record = asRecord(value);
  return record ? record as EmotionResult : null;
}

export function asTtsPiece(value: unknown): TtsPiece {
  return (asRecord(value) || {}) as TtsPiece;
}

export function errorMessage(err: unknown, fallback = ""): string {
  return err instanceof Error ? err.message : (fallback || String(err || ""));
}

export function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "";
}

export function normalizeVadConfig(config: Partial<VadConfig> = {}): VadConfig {
  return {
    ...DEFAULT_VAD_CONFIG,
    ...config,
    enabled: config.enabled !== false,
  };
}

/**
 * emotion2vec+ only needs a short representative segment. Feeding very long
 * turns tends to bias top-1 toward neutral and costs latency.
 */
export function extractEmotionSegment(wavBuffer: Buffer, {
  headSeconds = 1,
  tailSeconds = 3,
}: { headSeconds?: number; tailSeconds?: number } = {}): Buffer {
  const targetSeconds = headSeconds + tailSeconds;
  const decoded = decodePcm16Audio(wavBuffer);
  const sampleRate = decoded.sampleRate || PCM_SAMPLE_RATE;
  const bytesPerSecond = sampleRate * 2;
  const totalSeconds = decoded.pcm.length / bytesPerSecond;
  if (totalSeconds <= targetSeconds) {
    return wavBuffer;
  }
  const headBytes = Math.min(decoded.pcm.length, headSeconds * bytesPerSecond);
  const tailBytes = Math.min(decoded.pcm.length - headBytes, tailSeconds * bytesPerSecond);
  const head = decoded.pcm.subarray(0, headBytes);
  const tail = decoded.pcm.subarray(decoded.pcm.length - tailBytes);
  const merged = Buffer.concat([head, tail]);
  return pcm16ToWav(merged, { sampleRate });
}

export function cleanTextForTts(text: unknown): string {
  return stripEmojiForTts(String(text || "")
    .replace(/```[\s\S]*?```/g, "代码块略过。")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)、]\s+/gm, "")
    .replace(/\n{2,}/g, "。")
    .replace(/\s+/g, " ")
    .trim());
}

function splitSegmentByLength(text: unknown, maxChars = TTS_MAX_SEGMENT_CHARS): string[] {
  const value = String(text || "").trim();
  if (!value) return [];
  const out: string[] = [];
  let remaining = value;
  while (remaining.length > maxChars) {
    const window = remaining.slice(0, maxChars);
    let splitAt = -1;
    for (const sep of ["，", ",", "、", "：", ":", " "]) {
      const pos = window.lastIndexOf(sep);
      if (pos >= Math.floor(maxChars * 0.45)) {
        splitAt = pos + 1;
        break;
      }
    }
    if (splitAt <= 0) splitAt = maxChars;
    out.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) out.push(remaining);
  return out.filter(Boolean);
}

export function splitTextForTts(text: unknown, { maxChars = TTS_MAX_SEGMENT_CHARS }: { maxChars?: number } = {}): string[] {
  const value = cleanTextForTts(text);
  if (!value) return [];
  const parts = value.match(/[^。！？!?；;]+[。！？!?；;]?/g) || [value];
  const out: string[] = [];
  for (const part of parts.map((p) => p.trim()).filter(Boolean)) {
    if (part.length <= maxChars) {
      out.push(part);
      continue;
    }
    out.push(...splitSegmentByLength(part, maxChars));
  }
  return out;
}

function normalizeProviderHealth(provider: HealthProvider | null | undefined, value: unknown): ProviderHealth {
  const name = provider?.name || "unknown";
  if (value === undefined || value === null) return { name, ok: true, fallbackOk: false, degraded: false };
  if (typeof value === "boolean") return { name, ok: value, fallbackOk: false, degraded: !value };
  const record = asRecord(value);
  if (record) {
    const ok = "ok" in record ? !!record.ok : true;
    const fallbackOk = !!record.fallbackOk;
    return {
      name,
      ok,
      fallbackOk,
      degraded: !!record.degraded || (!ok && fallbackOk),
      error: typeof record.error === "string" ? record.error : undefined,
    };
  }
  return { name, ok: !!value, fallbackOk: false, degraded: !value };
}

export async function providerHealthStatus(provider: HealthProvider | null | undefined): Promise<ProviderHealth> {
  if (!provider || typeof provider.health !== "function") {
    return normalizeProviderHealth(provider, true);
  }
  try {
    return normalizeProviderHealth(provider, await provider.health());
  } catch (err) {
    return {
      name: provider?.name || "unknown",
      ok: false,
      fallbackOk: false,
      degraded: true,
      error: errorMessage(err),
    };
  }
}

export function buildVoicePrompt(transcript: string, emotion: EmotionResult | null = null): string {
  const tag = typeof emotion?.tag === "string" ? emotion.tag : "";
  const emotionHint = tag && Object.prototype.hasOwnProperty.call(EMOTION_LLM_HINT, tag)
    ? EMOTION_LLM_HINT[tag as keyof typeof EMOTION_LLM_HINT]
    : null;
  return [
    "你正在用语音和用户对话。请用自然、简短、口语化的中文回答。",
    "除非用户明确要求,不要输出长列表。需要工具时可以正常使用 Lynn 的工具能力。",
    emotionHint ? `用户当前语气提示:${emotionHint}` : "",
    "",
    `用户刚才说:${transcript}`,
  ].filter(Boolean).join("\n");
}

function configString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function mergeRealtimeConfig(config: JsonRecord, voiceConfig: JsonRecord = {}): JsonRecord {
  const realtime = asRecord(voiceConfig.realtime) || {};
  return {
    ...realtime,
    ...config,
    api_key: config.api_key || config.apiKey || realtime.api_key || realtime.apiKey,
    endpoint: config.endpoint || config.base_url || config.baseUrl || realtime.endpoint || realtime.base_url || realtime.baseUrl,
    model: config.model || realtime.model,
    default_voice: config.default_voice || config.voice || realtime.default_voice || realtime.voice,
  };
}

function voiceRouterMode(config: JsonRecord = {}, voiceConfig: JsonRecord = {}): string {
  const router = asRecord(voiceConfig.router) || {};
  return configString(config.router)
    || configString(router.provider)
    || configString(router.mode)
    || configString(voiceConfig.router)
    || configString(process.env.LYNN_VOICE_ROUTER)
    || "";
}

function hasStepRealtimeKey(config: JsonRecord = {}, voiceConfig: JsonRecord = {}): boolean {
  const merged = mergeRealtimeConfig(config, voiceConfig);
  return !!(
    configString(merged.api_key)
    || configString(merged.apiKey)
    || configString(process.env.LYNN_STEP_REALTIME_KEY)
    || configString(process.env.STEPFUN_REALTIME_API_KEY)
    || configString(process.env.STEPFUN_API_KEY)
    || configString(process.env.STEP_API_KEY)
  );
}

function shouldUseStepRealtime(config: JsonRecord = {}, voiceConfig: JsonRecord = {}): boolean {
  const provider = configString(config.provider);
  const mode = voiceRouterMode(config, voiceConfig);
  if (provider === "stepfun-realtime" || provider === "stepfun") return true;
  if (mode === "stepfun" || mode === "stepfun-realtime") return true;
  if (mode === "auto") return hasStepRealtimeKey(config, voiceConfig);
  return false;
}

export function resolveVoiceRuntimeAsrConfig(config: JsonRecord = {}, voiceConfig: JsonRecord = {}): JsonRecord {
  if (shouldUseStepRealtime(config, voiceConfig)) {
    return {
      ...mergeRealtimeConfig(config, voiceConfig),
      provider: "stepfun-realtime",
      fallback_provider: config.fallback_provider || config.fallbackProvider || "spark",
      fallback: {
        provider: "spark",
        ...(asRecord(config.fallback) || {}),
      },
    };
  }
  const provider = String(config.provider || "").trim();
  if (provider === "spark" || provider === "spark-local") {
    return {
      ...config,
      provider: "spark",
      fallback_provider: config.fallback_provider || config.fallbackProvider || "sensevoice",
    };
  }
  if (!provider || provider === "sensevoice") {
    return {
      ...config,
      provider: "qwen3-asr",
      fallback_provider: config.fallback_provider || config.fallbackProvider || "sensevoice",
    };
  }
  return config;
}

export function resolveVoiceRuntimeTtsConfig(config: JsonRecord = {}, voiceConfig: JsonRecord = {}): JsonRecord {
  if (shouldUseStepRealtime(config, voiceConfig)) {
    return {
      ...mergeRealtimeConfig(config, voiceConfig),
      provider: "stepfun-realtime",
      fallback_provider: config.fallback_provider || config.fallbackProvider || "spark",
      fallback: {
        provider: "spark",
        ...(asRecord(config.fallback) || {}),
      },
    };
  }
  const provider = configString(config.provider);
  if (provider === "spark" || provider === "spark-local") {
    return {
      ...config,
      provider: "spark",
      fallback_provider: config.fallback_provider || config.fallbackProvider || "edge",
    };
  }
  return config;
}

export function isSemanticTranscript(text: unknown): boolean {
  const value = String(text || "").trim();
  if (!value) return false;
  if (value.length < 2) return false;
  const nonSemantic = /^[\s]*((嗯|啊|哦|哈|喂|呃|嗨|咳|hm|uh|ah|oh|huh|haha|mhm)[\s,，。.!?！？]*)+$/i;
  if (nonSemantic.test(value)) return false;
  return true;
}

function escapeRegExp(value: unknown): string {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeVoiceTranscript(text: unknown): string {
  let value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return "";
  value = value.replace(/^(?:嗯|呃|啊|那个|就是)[，,。.\s]*/g, "");
  const spokenRestartMarkers = [
    "我要查的是",
    "我想查的是",
    "我要问的是",
    "我想问的是",
    "我问的是",
    "我查的是",
    "要查的是",
    "想查的是",
    "查的是",
    "问的是",
  ];
  for (const marker of spokenRestartMarkers) {
    const escaped = escapeRegExp(marker);
    value = value.replace(new RegExp(`${escaped}[\\u4e00-\\u9fa5]{0,2}${escaped}`, "g"), marker);
  }
  return value.trim();
}

export const defaultBrainRunner: BrainRunner = async ({ transcript, emotion, engine, signal }: {
  transcript: string;
  emotion?: EmotionResult | null;
  engine: VoiceEngine;
  signal?: AbortSignal;
}): Promise<string> => {
  if (typeof engine?.executeIsolated === "function") {
    const result = await engine.executeIsolated(buildVoicePrompt(transcript, emotion), { signal });
    if (result?.error) throw new Error(String(result.error));
    return String(result?.replyText || "");
  }
  if (typeof engine?.voiceReply === "function") {
    return String(await engine.voiceReply(transcript, { signal }) || "");
  }
  return "";
};

export async function waitForCurrentTurnEmotion(
  emotionPromise: Promise<EmotionResult | null> | null | undefined,
  timeoutMs = EMOTION_CURRENT_TURN_WAIT_MS,
): Promise<EmotionResult | null> {
  if (!emotionPromise) return null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race<EmotionResult | null>([
      emotionPromise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
