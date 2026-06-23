import { readSignedClientAgentHeaders } from "../../shared/client-agent-identity.js";
import { BRAIN_API_ROOTS } from "../../shared/brain-provider.js";
import { extractPcm16FromWav, pcm16ToWav, toBuffer } from "../chat/voice-audio-codec.js";

interface BrainRealtimeVoiceConfig {
  timeout_ms?: unknown;
  timeoutMs?: unknown;
  brain_base_url?: unknown;
  brainBaseUrl?: unknown;
  default_voice?: unknown;
  voice?: unknown;
  base_url?: unknown;
  baseUrl?: unknown;
  [key: string]: unknown;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function brainRoots(config: BrainRealtimeVoiceConfig): string[] {
  // Generic voice provider config may still contain legacy local ASR/TTS
  // base_url values. Brain-hosted StepFun Realtime must not inherit those.
  const configured = stringValue(config.brain_base_url) || stringValue(config.brainBaseUrl);
  const roots = configured ? [configured] : BRAIN_API_ROOTS;
  return [...new Set(roots.map((root) => String(root || "").replace(/\/+$/, "")).filter(Boolean))];
}

function endpoint(root: string, pathname: string): string {
  return `${root}${pathname}`;
}

function normalizeAudioInput(audioBuffer: unknown): Buffer {
  const audio = toBuffer(audioBuffer as Parameters<typeof toBuffer>[0]);
  return extractPcm16FromWav(audio);
}

async function postBrainVoice(pathname: "/v1/voice/asr" | "/v1/voice/tts", body: Record<string, unknown>, config: BrainRealtimeVoiceConfig): Promise<Record<string, unknown>> {
  const timeoutMs = numberValue(config.timeout_ms ?? config.timeoutMs, 45_000);
  const headers = {
    "Content-Type": "application/json",
    ...readSignedClientAgentHeaders({ method: "POST", pathname }),
  };
  let lastError: unknown = null;
  for (const root of brainRoots(config)) {
    try {
      const res = await fetch(endpoint(root, pathname), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) {
        throw new Error(String(data?.error || `HTTP ${res.status}`));
      }
      return data as Record<string, unknown>;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || "Brain realtime voice request failed"));
}

export function createBrainRealtimeAsrProvider(config: BrainRealtimeVoiceConfig = {}) {
  return {
    name: "brain-realtime-asr",
    label: "Lynn Brain StepFun Realtime ASR",
    async transcribe(audioBuffer: unknown, opts: Record<string, unknown> = {}) {
      const pcm = normalizeAudioInput(audioBuffer);
      if (!pcm.length) throw new Error("Brain realtime ASR received empty audio");
      const data = await postBrainVoice("/v1/voice/asr", {
        audio_base64: pcm.toString("base64"),
        mime_type: "audio/pcm;rate=24000",
        language: opts.language || config.language || "auto",
        filename: opts.filename || "audio.pcm",
      }, config);
      const text = stringValue(data.text) || stringValue(data.transcript);
      if (!text) throw new Error("Brain realtime ASR returned no transcript");
      return {
        provider: String(data.provider || "brain-stepfun-realtime"),
        text,
        transcript: text,
        language: stringValue(data.language) || stringValue(opts.language) || "auto",
        raw: data.raw,
      };
    },
    async health() {
      return {
        ok: true,
        fallbackOk: false,
        degraded: false,
        provider: "brain-realtime",
      };
    },
  };
}

export function createBrainRealtimeTtsProvider(config: BrainRealtimeVoiceConfig = {}) {
  return {
    name: "brain-realtime-tts",
    label: "Lynn Brain StepFun Realtime TTS",
    async synthesize(text: string, opts: Record<string, unknown> = {}) {
      const data = await postBrainVoice("/v1/voice/tts", {
        text,
        voice: opts.voice || config.default_voice || config.voice,
        speed: opts.speed || 1,
      }, config);
      const audioBase64 = stringValue(data.audio_base64) || stringValue(data.audio);
      if (!audioBase64) throw new Error("Brain realtime TTS returned no audio");
      const audio = Buffer.from(audioBase64, "base64");
      return {
        provider: String(data.provider || "brain-stepfun-realtime"),
        mimeType: stringValue(data.mime_type) || stringValue(data.mimeType) || "audio/wav",
        audio: (stringValue(data.mime_type) || stringValue(data.mimeType)) === "audio/wav"
          ? audio
          : pcm16ToWav(audio, { sampleRate: 24_000 }),
      };
    },
    async health() {
      return { ok: true, fallbackOk: false, degraded: false, provider: "brain-realtime" };
    },
  };
}
