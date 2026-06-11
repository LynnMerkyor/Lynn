import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import {
  decodePcm16Audio,
  pcm16ToWav,
} from "../chat/voice-audio-codec.js";

type WebSocketCtor = new (url: string, options?: Record<string, unknown>) => {
  on(event: string, cb: (...args: unknown[]) => void): unknown;
  send(data: string | Buffer, cb?: (err?: Error) => void): unknown;
  close(): unknown;
};

interface StepRealtimeConfig {
  api_key?: unknown;
  apiKey?: unknown;
  endpoint?: unknown;
  base_url?: unknown;
  baseUrl?: unknown;
  model?: unknown;
  default_voice?: unknown;
  voice?: unknown;
  timeout_ms?: unknown;
  timeoutMs?: unknown;
  websocketCtor?: WebSocketCtor;
  [key: string]: unknown;
}

interface StepRealtimeResult {
  text: string;
  audio: Buffer;
  messages: unknown[];
}

const DEFAULT_ENDPOINT = "wss://api.stepfun.com/v1/realtime/stateless";
const DEFAULT_MODEL = "step-overture-preview";
const DEFAULT_VOICE = "jingdiannvsheng";
const DEFAULT_TIMEOUT_MS = 30000;
const STEP_SAMPLE_RATE = 24000;
const STEPFUN_REALTIME_ASR_UNSUPPORTED =
  "StepFun Realtime stateless returns assistant response transcripts, not standalone user ASR transcripts";

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function resolveStepFunRealtimeConfig(config: StepRealtimeConfig = {}) {
  const apiKey = stringValue(config.api_key)
    || stringValue(config.apiKey)
    || stringValue(process.env.LYNN_STEP_REALTIME_KEY)
    || stringValue(process.env.STEPFUN_REALTIME_API_KEY)
    || stringValue(process.env.STEP37_KEY)
    || stringValue(process.env.STEPFUN_CODING_KEY)
    || stringValue(process.env.STEPFUN_CODING_API_KEY)
    || stringValue(process.env.STEPFUN_API_KEY)
    || stringValue(process.env.STEP_API_KEY);
  const endpoint = normalizeRealtimeEndpoint(
    stringValue(config.endpoint)
      || stringValue(config.base_url)
      || stringValue(config.baseUrl)
      || stringValue(process.env.LYNN_STEP_REALTIME_ENDPOINT)
      || stringValue(process.env.STEPFUN_REALTIME_ENDPOINT)
      || stringValue(process.env.STEP37_BASE)
      || stringValue(process.env.STEPFUN_BASE_URL),
  );
  return {
    apiKey,
    endpoint,
    model: stringValue(config.model)
      || stringValue(process.env.LYNN_STEP_REALTIME_MODEL)
      || stringValue(process.env.STEPFUN_REALTIME_MODEL)
      || DEFAULT_MODEL,
    voice: stringValue(config.default_voice)
      || stringValue(config.voice)
      || stringValue(process.env.LYNN_STEP_REALTIME_VOICE)
      || stringValue(process.env.STEPFUN_REALTIME_VOICE)
      || DEFAULT_VOICE,
    timeoutMs: numberValue(config.timeout_ms ?? config.timeoutMs, DEFAULT_TIMEOUT_MS),
    websocketCtor: config.websocketCtor || WebSocket as unknown as WebSocketCtor,
  };
}

export function hasStepFunRealtimeCredential(config: StepRealtimeConfig = {}): boolean {
  return !!resolveStepFunRealtimeConfig(config).apiKey;
}

function normalizeRealtimeEndpoint(value: string): string {
  if (!value) return DEFAULT_ENDPOINT;
  let endpoint = value;
  if (/^https:\/\//i.test(endpoint)) endpoint = endpoint.replace(/^https:/i, "wss:");
  if (/^http:\/\//i.test(endpoint)) endpoint = endpoint.replace(/^http:/i, "ws:");
  endpoint = endpoint.replace(/\/+$/, "");
  endpoint = endpoint
    .replace(/\/step_plan\/v1(?:\/chat\/completions)?$/i, "")
    .replace(/\/v1\/chat\/completions$/i, "");
  if (!/\/v1\/realtime\/stateless$/i.test(endpoint)) {
    if (/\/v1$/i.test(endpoint)) endpoint = `${endpoint}/realtime/stateless`;
    else endpoint = `${endpoint}/v1/realtime/stateless`;
  }
  return endpoint;
}

function sendJson(ws: InstanceType<WebSocketCtor>, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.send(JSON.stringify(value), (err?: Error) => err ? reject(err) : resolve());
  });
}

function bufferFromWsData(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (typeof data === "string") return Buffer.from(data, "utf-8");
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return Buffer.from(String(data || ""), "utf-8");
}

function downmixPcm16ToMono(pcm: Buffer, channels: number): Buffer {
  if (channels <= 1) return pcm;
  const frames = Math.floor(pcm.length / 2 / channels);
  const mono = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    let sum = 0;
    for (let ch = 0; ch < channels; ch += 1) {
      sum += pcm.readInt16LE((i * channels + ch) * 2);
    }
    mono.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sum / channels))), i * 2);
  }
  return mono;
}

function resamplePcm16Mono(pcm: Buffer, fromRate: number, toRate: number): Buffer {
  if (!pcm.length || !fromRate || fromRate === toRate) return pcm;
  const inSamples = Math.floor(pcm.length / 2);
  const outSamples = Math.max(1, Math.round(inSamples * toRate / fromRate));
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i += 1) {
    const src = i * fromRate / toRate;
    const i0 = Math.min(inSamples - 1, Math.floor(src));
    const i1 = Math.min(inSamples - 1, i0 + 1);
    const t = src - i0;
    const s0 = pcm.readInt16LE(i0 * 2);
    const s1 = pcm.readInt16LE(i1 * 2);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s0 + (s1 - s0) * t))), i * 2);
  }
  return out;
}

export function prepareStepFunRealtimePcm(audio: Buffer): Buffer {
  const decoded = decodePcm16Audio(audio);
  if (decoded.bitsPerSample !== 16) {
    throw new Error(`StepFun Realtime only accepts PCM16 input, got ${decoded.bitsPerSample}-bit`);
  }
  return resamplePcm16Mono(
    downmixPcm16ToMono(decoded.pcm, decoded.channels),
    decoded.sampleRate,
    STEP_SAMPLE_RATE,
  );
}

async function runStepFunRealtime(config: StepRealtimeConfig, input: {
  audio?: Buffer;
  text?: string;
  signal?: AbortSignal;
  mode: "asr" | "tts";
}): Promise<StepRealtimeResult> {
  const resolved = resolveStepFunRealtimeConfig(config);
  if (!resolved.apiKey) throw new Error("StepFun Realtime API key is not configured");
  const url = `${resolved.endpoint}?model=${encodeURIComponent(resolved.model)}`;
  const ws = new resolved.websocketCtor(url, {
    headers: {
      Authorization: `Bearer ${resolved.apiKey}`,
      "X-Trace-Id": randomUUID(),
    },
  });

  return await new Promise((resolve, reject) => {
    let settled = false;
    let text = "";
    const audioChunks: Buffer[] = [];
    const messages: unknown[] = [];
    const timer = setTimeout(() => finish(new Error("StepFun Realtime timed out")), resolved.timeoutMs);
    const abort = () => finish(new Error("StepFun Realtime aborted"));
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      try { ws.close(); } catch {}
      if (err) reject(err);
      else resolve({ text: text.trim(), audio: Buffer.concat(audioChunks), messages });
    };

    input.signal?.addEventListener("abort", abort, { once: true });

    ws.on("open", async () => {
      try {
        if (input.mode === "asr") {
          const pcm = prepareStepFunRealtimePcm(input.audio || Buffer.alloc(0));
          await sendJson(ws, { type: "input_audio_buffer.append", audio: pcm.toString("base64") });
          await sendJson(ws, { type: "input_audio_buffer.commit" });
          await sendJson(ws, {
            type: "response.create",
            response: {
              modalities: ["text"],
              instructions: "请只转写用户音频,不要回答、解释或改写。",
            },
          });
        } else {
          await sendJson(ws, {
            type: "response.create",
            response: {
              modalities: ["audio", "text"],
              voice: resolved.voice,
              instructions: "请按原文自然朗读,不要改写内容。",
              history: [{ role: "user", content: input.text || "" }],
            },
          });
        }
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });

    ws.on("message", (data: unknown) => {
      try {
        const raw = bufferFromWsData(data).toString("utf-8");
        const evt = JSON.parse(raw);
        messages.push(evt);
        const type = String(evt?.type || "");
        if (type === "response.raw_text.delta" && typeof evt.delta === "string") text += evt.delta;
        if (type === "response.audio_transcript.delta" && typeof evt.delta === "string") text += evt.delta;
        if (type === "response.audio_transcript.done" && typeof evt.transcript === "string" && !text.trim()) text = evt.transcript;
        if (type === "response.audio.delta" && typeof evt.delta === "string") audioChunks.push(Buffer.from(evt.delta, "base64"));
        if (type === "error") throw new Error(String(evt.error?.message || evt.message || "StepFun Realtime error"));
        if (type === "response.done") finish();
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });

    ws.on("error", (err: unknown) => finish(err instanceof Error ? err : new Error(String(err))));
    ws.on("close", () => {
      if (!settled) finish(new Error("StepFun Realtime socket closed before response.done"));
    });
  });
}

export function createStepFunRealtimeAsrProvider(config: StepRealtimeConfig = {}) {
  return {
    name: "stepfun-realtime-asr",
    label: "StepFun Realtime ASR",
    async transcribe(audioBuffer: unknown, opts: Record<string, unknown> = {}) {
      void config;
      void audioBuffer;
      void opts;
      throw new Error(STEPFUN_REALTIME_ASR_UNSUPPORTED);
    },
    async health() {
      return {
        ok: false,
        fallbackOk: false,
        degraded: true,
        provider: "stepfun-realtime",
        error: STEPFUN_REALTIME_ASR_UNSUPPORTED,
      };
    },
  };
}

export function createStepFunRealtimeTtsProvider(config: StepRealtimeConfig = {}) {
  return {
    name: "stepfun-realtime-tts",
    label: "StepFun Realtime TTS",
    async synthesize(text: string, opts: Record<string, unknown> = {}) {
      const result = await runStepFunRealtime(config, {
        mode: "tts",
        text,
        signal: opts.signal as AbortSignal | undefined,
      });
      if (!result.audio.length) throw new Error("StepFun Realtime returned no audio");
      return {
        provider: "stepfun-realtime",
        mimeType: "audio/wav",
        audio: pcm16ToWav(result.audio, { sampleRate: STEP_SAMPLE_RATE }),
      };
    },
    async health() {
      const ok = hasStepFunRealtimeCredential(config);
      return { ok, fallbackOk: false, degraded: !ok, provider: "stepfun-realtime" };
    },
  };
}
