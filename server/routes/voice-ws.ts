/**
 * voice-ws.js — Lynn V0.79 Jarvis Runtime WebSocket
 *
 * Voice WS hub:client ↔ server ↔ ASR/Brain/TTS 双向 PCM 管道。
 *
 * 协议(每帧 4 字节 header + payload):
 *   [type:u8] [flags:u8] [seq:u16 BE] [payload:variable]
 *
 * Types:
 *   0x01 PCM_AUDIO           client → server  mic PCM 16kHz Int16,100ms/chunk
 *   0x02 PCM_TTS             server → client  TTS PCM 16kHz Int16 mono
 *   0x10 PING                client → server  RTT 测量
 *   0x11 PONG                server → client  RTT 回包
 *   0x12 TRANSCRIPT_PARTIAL  server → client  ASR 增量(Phase 2B+)
 *   0x13 TRANSCRIPT_FINAL    server → client  ASR 最终文本
 *   0x14 EMOTION             server → client  emotion2vec+ JSON
 *   0x15 STATE_CHANGE        server → client  idle/listening/thinking/speaking/degraded
 *   0x16 HEALTH_STATUS       server → client  provider health/fallback JSON
 *   0x17 ASSISTANT_REPLY     server → client  Lynn 文字回复
 *   0x20 INTERRUPT           client → server  用户开口/打断
 *   0x30 END_OF_TURN         client → server  一轮结束
 *   0x31 TEXT_TURN           client → server  降级 ASR 已得出的转写文本
 *   0x32 SPEAK_TEXT          client → server  播放已有聊天回复文本
 *
 * Phase 2A:PCM → ASR → Brain → CosyVoice2 → PCM_TTS 最小闭环。
 * Phase 2B:server-side energy VAD fallback for auto end-of-turn.
 * Phase 2D:Silero/TEN VAD interrupt arbitration / AEC reference signal coordination.
 */
import { Hono } from "hono";
import fs from "fs";
import { debugLog } from "../../lib/debug-log.js";
import { stripEmojiForTts } from "../../shared/tts-text-normalizer.js";
import { createASRFallbackProvider } from "../clients/asr/index.js";
import { createSERProvider, EMOTION_LLM_HINT } from "../clients/ser/index.js";
import { createTTSFallbackProvider } from "../clients/tts/index.js";
import { enrichHealthWithTier } from "../chat/voice-fallback-orchestrator.js";
import { aecAvailable as defaultAecAvailable, createAecProcessor as defaultCreateAecProcessor, aecProcessRender as defaultAecRender, aecProcessCapture as defaultAecCapture } from "../clients/aec/index.js";
import { FRAME, STATE } from "../chat/voice-ws-types.js";
import type { VoiceHealthPayload, VoiceProviderHealth } from "../chat/voice-fallback-orchestrator.js";
import type {
  AecCapture,
  AecProcessorHandle,
  AecRender,
  AsrProvider,
  BinaryInput,
  BrainRunner,
  CreateVoiceWsRouteDeps,
  CurrentReplyPlayed,
  DecodedPcmAudio,
  EmotionResult,
  ErleRecord,
  FrameCode,
  HealthProvider,
  JsonRecord,
  PendingInterruptedReply,
  ProviderHealth,
  SaveInterruptedTurn,
  SerProvider,
  TtsPiece,
  TtsProvider,
  TtsStreamError,
  VadConfig,
  VoiceEngine,
  VoiceErrorEvent,
  VoiceFrame,
  VoiceMessageEvent,
  VoiceRouteContext,
  VoiceSessionDeps,
  VoiceSocket,
  VoiceState,
} from "../chat/voice-ws-types.js";

export { FRAME, STATE };

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function toBuffer(value: BinaryInput): Buffer {
  if (!value) return Buffer.alloc(0);
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value));
  return Buffer.from(value);
}

function asEmotion(value: unknown): EmotionResult | null {
  const record = asRecord(value);
  return record ? record as EmotionResult : null;
}

function asTtsPiece(value: unknown): TtsPiece {
  return (asRecord(value) || {}) as TtsPiece;
}

function errorMessage(err: unknown, fallback = ""): string {
  return err instanceof Error ? err.message : (fallback || String(err || ""));
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "";
}

const PCM_SAMPLE_RATE = 16000;
const PCM_TTS_CHUNK_BYTES = 3200; // 100ms @ 16kHz Int16 mono
// 2026-05-01 P1-① — native AEC 强制 10ms 帧粒度(WebRTC API 约束,见 lib.rs)
const AEC_SAMPLES_PER_FRAME = 160;
const TTS_MAX_SEGMENT_CHARS = 80;
const TTS_RETRY_MIN_SEGMENT_CHARS = 24;
const TTS_SEGMENT_TIMEOUT_MS = 45000;
const EMOTION_CURRENT_TURN_WAIT_MS = 250;
// 2026-05-01 P0-③ 收紧默认值:对齐 OpenAI Realtime API 默认 silence_duration_ms=500ms
// (https://developers.openai.com/api/docs/guides/realtime-vad)
// 旧 800ms / 200ms 偏保守。客户端可仍通过 vadConfig 覆写。
const DEFAULT_VAD_CONFIG = Object.freeze({
  enabled: true,
  speechRms: 0.012,
  silenceRms: 0.006,
  minSpeechFrames: 1, // 100ms speech before auto-EOT is armed
  endSilenceFrames: 5, // 500ms trailing silence
});

/**
 * 解析二进制帧
 * @param {Buffer|ArrayBuffer} data
 * @returns {{type:number,flags:number,seq:number,payload:Buffer}|null}
 */
export function parseFrame(data: BinaryInput): VoiceFrame | null {
  const buf = toBuffer(data);
  if (buf.length < 4) return null;
  return {
    type: buf.readUInt8(0),
    flags: buf.readUInt8(1),
    seq: buf.readUInt16BE(2),
    payload: buf.subarray(4),
  };
}

/**
 * 构造二进制帧
 * @param {number} type
 * @param {number} flags
 * @param {number} seq
 * @param {Buffer|Uint8Array} payload
 * @returns {Buffer}
 */
export function makeFrame(type: FrameCode | number, flags: number, seq: number, payload?: BinaryInput): Buffer {
  const payloadBuf = toBuffer(payload);
  const buf = Buffer.alloc(4 + payloadBuf.length);
  buf.writeUInt8(type, 0);
  buf.writeUInt8(flags, 1);
  buf.writeUInt16BE(seq & 0xffff, 2);
  payloadBuf.copy(buf, 4);
  return buf;
}

function makeStateFrame(seq: number, state: VoiceState): Buffer {
  return makeFrame(FRAME.STATE_CHANGE, 0, seq, Buffer.from(state, "utf-8"));
}

function makeTranscriptFrame(type: FrameCode | number, seq: number, text: unknown): Buffer {
  return makeFrame(type, 0, seq, Buffer.from(String(text || ""), "utf-8"));
}

function makeJsonFrame(type: FrameCode | number, seq: number, value: unknown): Buffer {
  return makeFrame(type, 0, seq, Buffer.from(JSON.stringify(value ?? {}), "utf-8"));
}

export function pcm16Rms(pcmBuffer: BinaryInput): number {
  const buf = toBuffer(pcmBuffer);
  const samples = Math.floor(buf.length / 2);
  if (!samples) return 0;
  let sumSq = 0;
  for (let offset = 0; offset + 1 < buf.length; offset += 2) {
    const s = buf.readInt16LE(offset) / 32768;
    sumSq += s * s;
  }
  return Math.sqrt(sumSq / samples);
}

function normalizeVadConfig(config: Partial<VadConfig> = {}): VadConfig {
  return {
    ...DEFAULT_VAD_CONFIG,
    ...config,
    enabled: config.enabled !== false,
  };
}

export function pcm16ToWav(pcmBuffer: BinaryInput, { sampleRate = PCM_SAMPLE_RATE, channels = 1 }: { sampleRate?: number; channels?: number } = {}): Buffer {
  const pcm = toBuffer(pcmBuffer);
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * 2;
  const blockAlign = channels * 2;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function extractPcm16FromWav(audioBuffer: BinaryInput): Buffer {
  return decodePcm16Audio(audioBuffer).pcm;
}

export function decodePcm16Audio(audioBuffer: BinaryInput): DecodedPcmAudio {
  const buf = toBuffer(audioBuffer);
  if (buf.length < 12 || buf.subarray(0, 4).toString("ascii") !== "RIFF" || buf.subarray(8, 12).toString("ascii") !== "WAVE") {
    return { pcm: buf, sampleRate: PCM_SAMPLE_RATE, channels: 1, bitsPerSample: 16 };
  }
  let sampleRate = PCM_SAMPLE_RATE;
  let channels = 1;
  let bitsPerSample = 16;
  let pcm = Buffer.alloc(0);
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const chunkId = buf.subarray(offset, offset + 4).toString("ascii");
    const chunkSize = buf.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = Math.min(dataStart + chunkSize, buf.length);
    if (chunkId === "fmt " && chunkSize >= 16) {
      channels = Math.max(1, buf.readUInt16LE(dataStart + 2));
      sampleRate = buf.readUInt32LE(dataStart + 4) || PCM_SAMPLE_RATE;
      bitsPerSample = buf.readUInt16LE(dataStart + 14) || 16;
    } else if (chunkId === "data") {
      pcm = Buffer.from(buf.subarray(dataStart, dataEnd));
    }
    offset = dataStart + chunkSize + (chunkSize % 2);
  }
  return { pcm: pcm.length ? pcm : buf, sampleRate, channels, bitsPerSample };
}

function downmixPcm16ToMono(pcmBuffer: BinaryInput, channels = 1): Buffer {
  const pcm = toBuffer(pcmBuffer);
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

function resamplePcm16Mono(pcmBuffer: BinaryInput, fromRate: number, toRate = PCM_SAMPLE_RATE): Buffer {
  const pcm = toBuffer(pcmBuffer);
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

export function normalizeTtsAudioToPcm16Mono16k(audioBuffer: BinaryInput): Buffer {
  const decoded = decodePcm16Audio(audioBuffer);
  if (decoded.bitsPerSample !== 16) {
    throw new Error(`unsupported TTS WAV bit depth: ${decoded.bitsPerSample}`);
  }
  const mono = downmixPcm16ToMono(decoded.pcm, decoded.channels);
  return resamplePcm16Mono(mono, decoded.sampleRate, PCM_SAMPLE_RATE);
}

/**
 * 2026-05-01 P1-① — Int16 LE Buffer 读 N samples → Float32Array(归一到 [-1, 1])
 * 用于 native AEC 输入(WebRTC ProcessRender/ProcessCapture 接受 Float32)。
 */
export function bufferInt16LEToFloat32(buf: Buffer, sampleCount: number, byteOffset = 0): Float32Array {
  const out = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i += 1) {
    const offset = byteOffset + i * 2;
    if (offset + 1 < buf.length) {
      const s = buf.readInt16LE(offset);
      out[i] = s < 0 ? s / 0x8000 : s / 0x7fff;
    } else {
      out[i] = 0;
    }
  }
  return out;
}

export function float32ToInt16LEBuffer(samples: Float32Array | number[]): Buffer {
  const out = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i] || 0));
    const v = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i * 2);
  }
  return out;
}

/**
 * 2026-05-01 P1-① — TTS reference signal queue(Int16 LE 字节流)。
 *
 * server 在 send PCM_TTS 时同步 push,onAudio 时取等长 reference 喂 AEC processRender。
 * 容量上限防 TTS 远长于 mic 时(用户全程不开口)无限增长;头部丢老 sample,
 * 保留最近 N ms。
 */
class TtsReferenceQueue {
  maxSamples: number;
  bytes: Buffer;

  constructor({ maxSamples = PCM_SAMPLE_RATE * 10 }: { maxSamples?: number } = {}) {
    this.maxSamples = maxSamples; // 默认 10s 上限
    this.bytes = Buffer.alloc(0);
  }
  push(int16Bytes: BinaryInput): void {
    const bytes = toBuffer(int16Bytes);
    if (!bytes.length) return;
    this.bytes = Buffer.concat([this.bytes, bytes]);
    const maxBytes = this.maxSamples * 2;
    if (this.bytes.length > maxBytes) {
      this.bytes = this.bytes.subarray(this.bytes.length - maxBytes);
    }
  }
  /**
   * 取 sampleCount samples Int16 字节流;不足用 0 padding。
   *
   * 2026-05-01 修 1 — `trimSamples` 用于校准 reference vs mic 时序差。
   * 链路实际延迟 = 服务端→客户端网络 ~30ms + AudioWorklet jitter ~30ms +
   * 扬声器→空气→mic ~10-50ms + 客户端→服务端网络 ~30ms,合计约 60-150ms。
   * WebRTC AEC `EchoCanceller::Full { stream_delay_ms: None }` 信赖 estimator
   * 自学习 delay,通常足够;但环境抖动严重时可显式 trim 老 reference,
   * 让 take 出的 reference 时间戳更靠近"对应当前 mic 帧 echo 来源"。
   *
   * trimSamples=0 默认:FIFO 队首,reference 与 mic 间相对延迟由 estimator 学。
   * trimSamples>0:queue 充足时多丢 trimSamples 老 reference,等于"reference 提前
   * trimMs ms 入 process_render",经验值 60-100ms 适合普通有线/WiFi 环境。
   */
  take(sampleCount: number, trimSamples = 0): Buffer {
    const wantBytes = sampleCount * 2;
    if (trimSamples > 0) {
      // 仅在 queue 累积充足时才丢老,避免 take 出全 0 padding
      const trimBytes = trimSamples * 2;
      if (this.bytes.length >= wantBytes + trimBytes) {
        this.bytes = this.bytes.subarray(trimBytes);
      }
    }
    if (this.bytes.length >= wantBytes) {
      const head = this.bytes.subarray(0, wantBytes);
      this.bytes = this.bytes.subarray(wantBytes);
      return head;
    }
    // 不足 → 取出所有 + 0 padding
    const partial = this.bytes;
    this.bytes = Buffer.alloc(0);
    const padded = Buffer.alloc(wantBytes);
    partial.copy(padded, 0);
    return padded;
  }
  size(): number { return this.bytes.length / 2; }
  clear(): void { this.bytes = Buffer.alloc(0); }
}

/**
 * 2026-05-01 P1-① — 对单个 100ms PCM 帧跑 AEC。
 * 入:mic 100ms Int16 LE Buffer + reference 100ms Int16 LE Buffer
 * 出:cleaned 100ms Int16 LE Buffer
 *
 * 内部按 10ms (160 samples) 拆,for each pair:processRender(ref) + processCapture(mic)
 * 任何步骤抛 → 退化返回原 mic Buffer(不阻塞主链)。
 */
export function aecProcessFrame100ms(
  handle: AecProcessorHandle | null,
  micBuf: Buffer,
  refBuf: Buffer,
  deps: { processRender?: AecRender; processCapture?: AecCapture } = {},
): Buffer {
  if (!handle) return micBuf;
  const render = deps.processRender || defaultAecRender;
  const capture = deps.processCapture || defaultAecCapture;
  const samplesPerFrame = AEC_SAMPLES_PER_FRAME;
  const totalSamples = Math.floor(micBuf.length / 2);
  if (totalSamples % samplesPerFrame !== 0) return micBuf;
  const cleaned = Buffer.alloc(micBuf.length);
  try {
    for (let s = 0; s < totalSamples; s += samplesPerFrame) {
      const refFrame = bufferInt16LEToFloat32(refBuf, samplesPerFrame, s * 2);
      const micFrame = bufferInt16LEToFloat32(micBuf, samplesPerFrame, s * 2);
      render(handle, refFrame);
    const out = capture(handle, micFrame) || micFrame;
      const outBytes = float32ToInt16LEBuffer(out);
      outBytes.copy(cleaned, s * 2);
    }
    return cleaned;
  } catch (err) {
    debugLog()?.warn("voice-ws", `aec process frame failed: ${errorMessage(err)}`);
    return micBuf;
  }
}

/**
 * DS V4 Pro 反馈 #2 落地:emotion 只跑 4s 短段 = 开头 1s + 结尾 3s
 * 原因:整段喂 emotion2vec+ 时,长音频(>10s)会让 top1 偏 neutral,
 *      且 P99 从 < 100ms 拉到 > 300ms,失去"当前轮注入"时间窗口。
 *
 * 入参:16kHz mono WAV buffer(pcm16ToWav 产物)
 * 出参:同格式 WAV buffer,长度 ≤ 4s;如果原长 ≤ 4s 原样返回
 */
export function extractEmotionSegment(wavBuffer: Buffer, {
  headSeconds = 1,
  tailSeconds = 3,
}: { headSeconds?: number; tailSeconds?: number } = {}): Buffer {
  const targetSeconds = headSeconds + tailSeconds;
  const decoded = decodePcm16Audio(wavBuffer);
  const sampleRate = decoded.sampleRate || PCM_SAMPLE_RATE;
  const bytesPerSecond = sampleRate * 2; // Int16 mono
  const totalSeconds = decoded.pcm.length / bytesPerSecond;
  if (totalSeconds <= targetSeconds) {
    return wavBuffer; // 短段直接原样给,emotion server 也能 handle
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

function chunkBuffer(buf: Buffer, chunkBytes = PCM_TTS_CHUNK_BYTES): Buffer[] {
  const chunks: Buffer[] = [];
  for (let i = 0; i < buf.length; i += chunkBytes) {
    chunks.push(buf.subarray(i, Math.min(i + chunkBytes, buf.length)));
  }
  return chunks;
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

async function providerHealthStatus(provider: HealthProvider | null | undefined): Promise<ProviderHealth> {
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

function buildVoicePrompt(transcript: string, emotion: EmotionResult | null = null): string {
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

export function resolveVoiceRuntimeAsrConfig(config: JsonRecord = {}): JsonRecord {
  const provider = String(config.provider || "").trim();
  if (!provider || provider === "sensevoice") {
    return {
      ...config,
      provider: "qwen3-asr",
      fallback_provider: config.fallback_provider || config.fallbackProvider || "sensevoice",
    };
  }
  return config;
}

/**
 * DS V4 Pro 反馈 #3 落地:判定 transcript 是否"有意义"
 * 用于 interrupted T2 阶段:如果打断后用户只发出咳嗽/笑声/拟声词,
 * 则回滚 interrupt,不污染对话历史。
 */
export function isSemanticTranscript(text: unknown): boolean {
  const value = String(text || "").trim();
  if (!value) return false;
  if (value.length < 2) return false;
  // 过滤:仅由拟声词/笑声/语气助词构成的转写
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

async function defaultBrainRunner({ transcript, emotion, engine, signal }: {
  transcript: string;
  emotion?: EmotionResult | null;
  engine: VoiceEngine;
  signal?: AbortSignal;
}): Promise<string> {
  if (typeof engine?.executeIsolated === "function") {
    const result = await engine.executeIsolated(buildVoicePrompt(transcript, emotion), { signal });
    if (result?.error) throw new Error(String(result.error));
    return String(result?.replyText || "");
  }
  if (typeof engine?.voiceReply === "function") {
    return String(await engine.voiceReply(transcript, { signal }) || "");
  }
  return "";
}

async function waitForCurrentTurnEmotion(
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

/**
 * Voice session — 单条 WS 连接的状态封装
 */
class VoiceSession {
  ws: VoiceSocket;
  engine: VoiceEngine;
  hub: unknown;
  asrProvider: AsrProvider;
  serProvider: SerProvider;
  ttsProvider: TtsProvider;
  brainRunner: BrainRunner;
  saveInterruptedTurn: SaveInterruptedTurn | null;
  mode: "chat" | "direct";
  healthOnOpen: boolean;
  state: VoiceState;
  outSeq: number;
  lastInSeq: number;
  utteranceBuffer: Buffer[];
  totalBufferedSamples: number;
  maxBufferedSamples: number;
  transcriptPartial: string;
  startTs: number;
  pcmFramesIn: number;
  bytesIn: number;
  bytesOut: number;
  processingTurn: Promise<unknown> | null;
  turnAbort: AbortController | null;
  turnGeneration: number;
  pendingInterruptedReply: PendingInterruptedReply | null;
  currentReplyPlayed: CurrentReplyPlayed | null;
  activeSpeakingQueue: string[] | null;
  pendingAppendQueue: string[];
  aecProcessor: AecProcessorHandle | null;
  aecRender: AecRender;
  aecCapture: AecCapture;
  referenceQueue: TtsReferenceQueue;
  aecReferenceTrimSamples: number;
  vadConfig: VadConfig;
  vadSpeechFrames: number;
  vadSilenceFrames: number;
  vadArmed: boolean;
  erleRecord: ErleRecord | null;

  constructor(ws: VoiceSocket, {
    engine,
    hub,
    asrProvider,
    serProvider,
    ttsProvider,
    brainRunner,
    healthOnOpen = true,
    vadConfig = {},
    mode = "direct",
    saveInterruptedTurn = null,
    aec = null,
  }: VoiceSessionDeps) {
    this.ws = ws;
    this.engine = engine;
    this.hub = hub;
    this.asrProvider = (asrProvider || createASRFallbackProvider(resolveVoiceRuntimeAsrConfig(engine?.config?.voice?.asr || {}))) as AsrProvider;
    this.serProvider = (serProvider || createSERProvider(engine?.config?.voice?.ser || {})) as SerProvider;
    this.ttsProvider = (ttsProvider || createTTSFallbackProvider(engine?.config?.voice?.tts || {})) as TtsProvider;
    this.brainRunner = brainRunner || defaultBrainRunner;
    this.saveInterruptedTurn = saveInterruptedTurn; // DS 反馈 #3 T2 阶段的可注入钩子
    this.mode = mode === "chat" ? "chat" : "direct";
    this.healthOnOpen = healthOnOpen;
    this.state = STATE.IDLE;
    this.outSeq = 0;
    this.lastInSeq = -1;
    this.utteranceBuffer = []; // 累积当前 utterance 的 PCM (Int16Array[])
    this.totalBufferedSamples = 0;
    this.maxBufferedSamples = 16000 * 30; // 30s 上限
    this.transcriptPartial = "";
    this.startTs = Date.now();
    this.pcmFramesIn = 0;
    this.bytesIn = 0;
    this.bytesOut = 0;
    this.processingTurn = null;
    this.turnAbort = null;
    this.turnGeneration = 0;
    // DS V4 Pro 反馈 #3 — 打断 T1/T2 状态机:
    //   T1 (onInterrupt):截断 TTS/Brain,把已播放 segments 暂存到 pendingInterruptedReply
    //   T2 (processTurn 内 ASR final 后):
    //     有意义 transcript  → 保存已播放部分到历史 interrupted: true
    //     咳嗽/拟声/笑声     → 回滚,pendingInterruptedReply 直接丢弃(不污染上下文)
    this.pendingInterruptedReply = null;
    this.currentReplyPlayed = null; // 当前 TTS 正在播放的已完成 segments 文本
    // 2026-05-01 P0-① 增量 TTS:speakText 进入循环时设此引用,SPEAK_TEXT_APPEND 帧
    // 直接 push 进同一个 queue,无需新建 turn / 不抢锁。退出 speakText 时清 null。
    this.activeSpeakingQueue = null;
    // 2026-05-01 P0-① B2 race fix:client 后续 SPEAK_TEXT_APPEND 在 server 刚消费
    // 完 activeSpeakingQueue 但还没退到 IDLE 的"间隙"窗口到达时,不被丢/不被锁吞。
    // appendSpeakText 在 SPEAKING 期间 activeSpeakingQueue=null/空 时改 push 到这里;
    // speakText 退出 while 前 grace period 检查这个 queue;若有则继续消费。
    this.pendingAppendQueue = [];

    // 2026-05-01 P1-① — 服务端 AEC pipeline:
    //   * aec.available + native processor 创建成功 → 启用,reference signal 在 send PCM_TTS
    //     时 push,onAudio 时取等长 reference 喂 processRender + processCapture
    //   * 不可用(平台无 prebuilt / 加载失败 / 创建抛错)→ 退化为 mic 直传(等同现状)
    //   * deps 注入:测试用 mock createProcessor / processRender / processCapture
    const aecDeps = aec || null;
    const aecCreate = aecDeps?.createProcessor || (defaultAecAvailable ? defaultCreateAecProcessor : null);
    if (aecCreate) {
      try {
        this.aecProcessor = aecCreate({ sampleRate: PCM_SAMPLE_RATE, enableNs: true }) || null;
      } catch (err) {
        this.aecProcessor = null;
        debugLog()?.warn("voice-ws", `aec processor init failed: ${errorMessage(err)}`);
      }
    } else {
      this.aecProcessor = null;
    }
    this.aecRender = aecDeps?.processRender || defaultAecRender as AecRender;
    this.aecCapture = aecDeps?.processCapture || defaultAecCapture as AecCapture;
    this.referenceQueue = new TtsReferenceQueue();
    // 2026-05-01 修 1 — reference vs mic 时序校准,默认 0(信 WebRTC estimator
    // 自学习 delay);环境抖动严重 ERLE < 15dB 时设 60-100 即可。负值 / NaN → 退 0。
    const trimMs = Number(process.env.LYNN_AEC_REFERENCE_TRIM_MS);
    this.aecReferenceTrimSamples = (Number.isFinite(trimMs) && trimMs > 0)
      ? Math.round(trimMs * PCM_SAMPLE_RATE / 1000)
      : 0;
    this.vadConfig = normalizeVadConfig(vadConfig);
    this.vadSpeechFrames = 0;
    this.vadSilenceFrames = 0;
    this.vadArmed = false;

    // ERLE debug 双轨录制(Phase 2 Spike 5 用):
    //   设 LYNN_ERLE_RECORD_DIR=/path/to/dir 即启用
    //   session 结束(或 onClose)时产出 <session-id>-mic.wav + <session-id>-tts.wav
    //   时间对齐:同一 AudioContext 时序,不需额外 sync
    const erleDir = process.env.LYNN_ERLE_RECORD_DIR;
    this.erleRecord = erleDir ? {
      dir: erleDir,
      sessionId: `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      micChunks: [], // Buffer[]
      ttsChunks: [], // Buffer[]
      startTs: Date.now(),
    } : null;
  }

  setState(state: VoiceState): void {
    if (this.state === state) return;
    this.state = state;
    this.send(makeStateFrame(this.outSeq++, state));
    debugLog()?.log("voice-ws", `state → ${state}`);
  }

  send(buf: Buffer): void {
    if (this.ws.readyState !== 1) return;
    this.ws.send(buf);
    this.bytesOut += buf.length;
  }

  async checkHealth(): Promise<boolean> {
    const [asr, ser, tts] = await Promise.all([
      providerHealthStatus(this.asrProvider),
      providerHealthStatus(this.serProvider),
      providerHealthStatus(this.ttsProvider),
    ]);
    // SER is an optional side chain: emotion failure must not block the voice
    // turn or make Lynn look degraded when ASR/TTS are healthy.
    const ok = asr.ok && tts.ok;
    const rawHealth: VoiceHealthPayload = {
      ok,
      degraded: !ok || asr.degraded || tts.degraded,
      providers: {
        asr: asr as unknown as VoiceProviderHealth,
        ser: ser as unknown as VoiceProviderHealth,
        tts: tts as unknown as VoiceProviderHealth,
      },
    };
    // DS V4 Pro 反馈 #5 · Phase 2.5 降级编排:附加 tier + Orb 颜色 + 文案
    const health = enrichHealthWithTier(rawHealth);
    this.send(makeJsonFrame(FRAME.HEALTH_STATUS, this.outSeq++, health));
    if (!ok) {
      // Health probes can race with an active turn. In particular, CosyVoice
      // may be busy synthesizing while the on-open health check is still
      // pending; don't let that late probe visually interrupt a valid
      // speaking/thinking state. The explicit HEALTH_STATUS frame still carries
      // the degraded detail for diagnostics.
      if (this.state !== STATE.SPEAKING && this.state !== STATE.THINKING) {
        this.setState(STATE.DEGRADED);
      }
      debugLog()?.warn("voice-ws", `provider health degraded · tier=${health?.tier ?? "?"} asr=${asr.ok}/${asr.fallbackOk} ser=${ser.ok}/${ser.fallbackOk} tts=${tts.ok}/${tts.fallbackOk}`);
    }
    return ok;
  }

  onOpen(): void {
    if (this.healthOnOpen) {
      void this.checkHealth();
      void this.serProvider?.warmup?.();
    }
  }

  async onAudio(frame: VoiceFrame): Promise<void> {
    // 计 seq 顺序
    const expectedSeq = (this.lastInSeq + 1) & 0xffff;
    if (this.lastInSeq !== -1 && frame.seq !== expectedSeq) {
      debugLog()?.log("voice-ws", `seq out of order: expected ${expectedSeq}, got ${frame.seq}`);
    }
    this.lastInSeq = frame.seq;
    this.pcmFramesIn++;
    this.bytesIn += frame.payload.length;

    // Phase 2B:client-side Silero/TEN 未接入前,server 侧先做保守 energy VAD 兜底。
    if (this.state === STATE.IDLE || this.state === STATE.DEGRADED) {
      this.setState(STATE.LISTENING);
    }

    // 2026-05-01 P1-① — server 侧 AEC:取等长 reference(PCM_TTS 已 push),
    // 跑 processRender + processCapture 清 echo,再走后续 buffer / VAD / ERLE。
    let micPayload = frame.payload;
    if (this.aecProcessor && frame.payload.length > 0 && frame.payload.length % (AEC_SAMPLES_PER_FRAME * 2) === 0) {
      const sampleCount = frame.payload.length / 2;
      const referenceBuf = this.referenceQueue.take(sampleCount, this.aecReferenceTrimSamples);
      micPayload = aecProcessFrame100ms(this.aecProcessor, frame.payload, referenceBuf, {
        processRender: this.aecRender,
        processCapture: this.aecCapture,
      });
    }

    // Buffer 累积
    if (this.totalBufferedSamples < this.maxBufferedSamples) {
      this.utteranceBuffer.push(micPayload);
      this.totalBufferedSamples += micPayload.length / 2; // Int16 = 2 bytes/sample
    } else {
      // 30s 上限,强制 EOT
      void this.endOfTurn();
      return;
    }

    // ERLE 双轨:mic 入侧即录(AEC 后的 cleaned PCM,合 doc spike/05 README 期望)
    if (this.erleRecord) {
      this.erleRecord.micChunks.push(Buffer.from(micPayload));
    }

    this.updateEnergyVad(micPayload);
  }

  updateEnergyVad(pcmPayload: Buffer): void {
    const cfg = this.vadConfig;
    if (!cfg.enabled || this.processingTurn || this.state !== STATE.LISTENING) return;

    const rms = pcm16Rms(pcmPayload);
    if (rms >= cfg.speechRms) {
      this.vadSpeechFrames += 1;
      this.vadSilenceFrames = 0;
      if (this.vadSpeechFrames >= cfg.minSpeechFrames) {
        this.vadArmed = true;
      }
      return;
    }

    if (!this.vadArmed) return;
    if (rms <= cfg.silenceRms) {
      this.vadSilenceFrames += 1;
    } else {
      this.vadSilenceFrames = 0;
    }

    if (this.vadSilenceFrames >= cfg.endSilenceFrames) {
      debugLog()?.log("voice-ws", `energy VAD auto end-of-turn rms=${rms.toFixed(4)}`);
      void this.endOfTurn();
    }
  }

  async endOfTurn(): Promise<unknown> {
    if (this.processingTurn) return this.processingTurn;
    if (this.state === STATE.IDLE) return;
    if (this.utteranceBuffer.length === 0) {
      this.setState(STATE.IDLE);
      return;
    }

    const combinedPcm = Buffer.concat(this.utteranceBuffer);
    const wavAudio = pcm16ToWav(combinedPcm);
    this.utteranceBuffer = [];
    this.totalBufferedSamples = 0;
    this.resetVad();

    const generation = ++this.turnGeneration;
    this.processingTurn = this.processTurn(wavAudio)
      .catch((err) => {
        if (this.isStaleTurn(generation) || this.isIntentionalAbort(err)) {
          debugLog()?.log("voice-ws", `turn aborted: ${errorMessage(err, "stale turn")}`);
          return;
        }
        debugLog()?.error("voice-ws", `turn failed: ${errorMessage(err)}`);
        this.send(makeTranscriptFrame(FRAME.TRANSCRIPT_FINAL, this.outSeq++, ""));
        this.setState(STATE.DEGRADED);
      })
      .finally(() => {
        if (!this.isStaleTurn(generation)) {
          this.turnAbort = null;
          this.processingTurn = null;
        }
      });
    return this.processingTurn;
  }

  async processTurn(wavAudio: Buffer): Promise<void> {
    this.turnAbort = new AbortController();
    const signal = this.turnAbort.signal;

    await this.checkHealth();
    if (signal?.aborted) return;

    this.setState(STATE.THINKING);

    // 方案 C 微交互(2026-05-01 决策):因为 final ASR 需要整段等收敛(~0.8-1.2s),
    // 用户会感到"说完一拍停顿"。立刻推一个 PARTIAL "理解中…" 让 Overlay 能显,
    // 这是零成本心理补偿。Overlay 看到 partial 会显示为灰色占位,收到 final 时替换。
    this.send(makeTranscriptFrame(FRAME.TRANSCRIPT_PARTIAL, this.outSeq++, "理解中…"));

    const emotionPromise = this.serProvider?.classify
      ? Promise.resolve(this.serProvider.classify(extractEmotionSegment(wavAudio), { filename: "voice.wav" }))
        .then((emotion: unknown) => {
          const normalizedEmotion = asEmotion(emotion);
          if (!signal.aborted) this.send(makeJsonFrame(FRAME.EMOTION, this.outSeq++, normalizedEmotion));
          return normalizedEmotion;
        })
        .catch((err: unknown) => {
          debugLog()?.warn("voice-ws", `emotion classify failed: ${errorMessage(err)}`);
          return null;
        })
      : Promise.resolve(null);

    const asrResult = await this.asrProvider.transcribe(wavAudio, { language: "zh", filename: "voice.wav" });
    if (signal?.aborted) return;
    if (asrResult?.fallbackUsed) {
      this.setState(STATE.DEGRADED);
      debugLog()?.warn("voice-ws", `asr fallback used: ${asrResult.primaryError || "primary failed"}`);
    }
    const transcript = normalizeVoiceTranscript(asrResult?.text);
    this.send(makeTranscriptFrame(FRAME.TRANSCRIPT_FINAL, this.outSeq++, transcript));

    // DS V4 Pro 反馈 #3 · T2 阶段:根据 transcript 语义决定被打断 AI 回复的归宿
    await this.resolveInterruptedReply(transcript);

    if (this.mode === "chat") {
      this.setState(STATE.IDLE);
      return;
    }
    const currentTurnEmotion = await waitForCurrentTurnEmotion(emotionPromise);

    await this.respondToTranscript(transcript, { emotion: currentTurnEmotion, signal });
  }

  /**
   * T2 阶段核心:
   *   pendingInterruptedReply 存在 →
   *     transcript 有意义       → 保存(interrupted: true)到对话历史
   *     transcript 咳嗽/无意义  → 回滚丢弃,不污染上下文
   *   pendingInterruptedReply 不存在 → no-op
   */
  async resolveInterruptedReply(transcript: string): Promise<void> {
    const pending = this.pendingInterruptedReply;
    if (!pending) return;
    this.pendingInterruptedReply = null;
    if (!isSemanticTranscript(transcript)) {
      debugLog()?.log("voice-ws", `T2 rollback: interrupted reply discarded (non-semantic transcript: ${JSON.stringify(transcript)})`);
      return;
    }
    if (typeof this.saveInterruptedTurn !== "function") {
      // engine 未注入钩子不是致命错误,只记日志
      debugLog()?.log("voice-ws", `T2 pending: saveInterruptedTurn hook absent, reply not persisted (text len=${pending.text.length})`);
      return;
    }
    try {
      await this.saveInterruptedTurn({
        text: pending.text,
        interrupted: true,
        segmentsPlayed: pending.segmentsPlayed,
        totalSegments: pending.totalSegments,
        startedAt: pending.startedAt,
        interruptedAt: pending.interruptedAt,
        engine: this.engine,
      });
      debugLog()?.log("voice-ws", `T2 saved: interrupted reply persisted (played ${pending.segmentsPlayed}/${pending.totalSegments})`);
    } catch (err) {
      debugLog()?.warn("voice-ws", `T2 save failed: ${errorMessage(err)}`);
    }
  }

  async processTextTurn(text: unknown): Promise<unknown> {
    if (this.processingTurn) return this.processingTurn;
    const transcript = normalizeVoiceTranscript(text);
    if (!transcript) {
      this.setState(STATE.IDLE);
      return;
    }
    const generation = ++this.turnGeneration;
    this.processingTurn = this.processDirectTranscript(transcript)
      .catch((err) => {
        if (this.isStaleTurn(generation) || this.isIntentionalAbort(err)) {
          debugLog()?.log("voice-ws", `text turn aborted: ${errorMessage(err, "stale turn")}`);
          return;
        }
        debugLog()?.error("voice-ws", `text turn failed: ${errorMessage(err)}`);
        this.setState(STATE.DEGRADED);
      })
      .finally(() => {
        if (!this.isStaleTurn(generation)) {
          this.turnAbort = null;
          this.processingTurn = null;
        }
      });
    return this.processingTurn;
  }

  async processDirectTranscript(transcript: string): Promise<void> {
    this.turnAbort = new AbortController();
    const signal = this.turnAbort.signal;
    await this.checkHealth();
    if (signal?.aborted) return;
    this.setState(STATE.THINKING);
    this.send(makeTranscriptFrame(FRAME.TRANSCRIPT_FINAL, this.outSeq++, transcript));
    if (this.mode === "chat") {
      this.setState(STATE.IDLE);
      return;
    }
    await this.respondToTranscript(transcript, { emotion: null, signal });
  }

  async processSpeakTextTurn(text: unknown): Promise<unknown> {
    if (this.processingTurn) return this.processingTurn;
    const value = String(text || "").trim();
    if (!value) {
      this.setState(STATE.IDLE);
      return;
    }
    const generation = ++this.turnGeneration;
    this.turnAbort = new AbortController();
    const signal = this.turnAbort.signal;
    this.processingTurn = this.speakText(value, { signal, emitAssistantReply: true })
      .catch((err) => {
        if (this.isStaleTurn(generation) || this.isIntentionalAbort(err)) {
          debugLog()?.log("voice-ws", `speak text aborted: ${errorMessage(err, "stale turn")}`);
          return;
        }
        debugLog()?.error("voice-ws", `speak text failed: ${errorMessage(err)}`);
        this.setState(STATE.DEGRADED);
      })
      .finally(() => {
        if (!this.isStaleTurn(generation)) {
          this.turnAbort = null;
          this.processingTurn = null;
        }
      });
    return this.processingTurn;
  }

  async respondToTranscript(
    transcript: string,
    { emotion = null, signal }: { emotion?: EmotionResult | null; signal?: AbortSignal } = {},
  ): Promise<void> {
    if (!transcript) {
      this.setState(STATE.IDLE);
      return;
    }
    const replyText = String(await this.brainRunner({
      transcript,
      emotion,
      engine: this.engine,
      hub: this.hub,
      signal,
    }) || "").trim();
    if (signal?.aborted) return;
    const segments = splitTextForTts(replyText);
    if (segments.length === 0) {
      this.setState(STATE.IDLE);
      return;
    }
    await this.speakText(replyText, { signal, emitAssistantReply: true });
  }

  async speakText(
    text: unknown,
    { signal, emitAssistantReply = true }: { signal?: AbortSignal; emitAssistantReply?: boolean } = {},
  ): Promise<void> {
    const replyText = String(text || "").trim();
    if (!replyText) {
      this.setState(STATE.IDLE);
      return;
    }
    const segments = splitTextForTts(replyText);
    if (segments.length === 0) {
      this.setState(STATE.IDLE);
      return;
    }
    if (emitAssistantReply) this.send(makeTranscriptFrame(FRAME.ASSISTANT_REPLY, this.outSeq++, replyText));
    this.setState(STATE.SPEAKING);
    // DS 反馈 #3 · 追踪已播放进度,onInterrupt T1 时快照
    this.currentReplyPlayed = {
      fullText: replyText,
      segments: [...segments],
      playedSegments: [],
      startedAt: Date.now(),
    };
    // 2026-05-01 P0-① queue 化:while 循环消费 this.activeSpeakingQueue,
    // SPEAK_TEXT_APPEND 帧可在循环执行中往 queue 末尾 push 新 segment。
    // B2 race fix(2026-05-01):若 pendingAppendQueue 有早到的 segments(本来就为
    // SPEAKING 中"queue 刚空但 finally 还没跑"窗口设),merge 进 active。
    this.activeSpeakingQueue = [...segments];
    if (this.pendingAppendQueue.length > 0) {
      this.activeSpeakingQueue.push(...this.pendingAppendQueue);
      this.pendingAppendQueue = [];
    }
    // 2026-05-01 P0-② TTS 流式:provider 暴露 synthesizeStream 时优先用,首 PCM
    // 不等整段 WAV 渲染完,首音节延迟 ~400-1200ms → ~200-300ms。
    const supportsStream = typeof this.ttsProvider.synthesizeStream === "function";
    try {
      while (true) {
        if (signal?.aborted) break;
        // 优先消费 active queue
        if (this.activeSpeakingQueue.length > 0) {
          const segment = this.activeSpeakingQueue.shift();
          if (!segment) continue;
          await this.processSpeakingSegment(segment, signal, supportsStream);
          continue;
        }
        // active 空 → grace period 等 client SPEAK_TEXT_APPEND(B2 race fix)。
        // appendSpeakText 在 SPEAKING + queue truthy 时 push 进 active;
        // 在 processingTurn 仍非 null 但 queue 空/null 时 push 进 pendingAppendQueue。
        // grace 后两条都要检查。
        const graceMs = Number(process.env.LYNN_VOICE_APPEND_GRACE_MS) || 150;
        await new Promise((r) => setTimeout(r, graceMs));
        if (signal?.aborted) break;
        if (this.pendingAppendQueue.length > 0) {
          this.activeSpeakingQueue.push(...this.pendingAppendQueue);
          this.pendingAppendQueue = [];
          continue;
        }
        if (this.activeSpeakingQueue.length > 0) continue; // grace 期间有人 push 进了 active
        break; // 真空了
      }
    } finally {
      this.activeSpeakingQueue = null;
    }
    if (!signal?.aborted) {
      // 正常播完 → 清空跟踪,不触发 T2
      this.currentReplyPlayed = null;
      this.setState(STATE.IDLE);
    }
  }

  async processSpeakingSegment(segment: string, signal: AbortSignal | undefined, supportsStream: boolean): Promise<void> {
    try {
      if (supportsStream) {
        await this.streamSegmentToPcm(segment, signal);
      } else {
        await this.batchSegmentToPcm(segment, signal);
      }
    } catch (err) {
      // 2026-05-01 修 3:stream 路径已 yield 部分 PCM 后失败 → 不切小重试
      if (asRecord(err)?.yieldedAny) {
        this.setState(STATE.DEGRADED);
        debugLog()?.warn("voice-ws", `tts stream failed mid-segment after yielding PCM, no retry: ${errorMessage(err)}`);
        throw err;
      }
      const smallerMax = Math.max(TTS_RETRY_MIN_SEGMENT_CHARS, Math.ceil(segment.length / 2));
      const smaller = segment.length > TTS_RETRY_MIN_SEGMENT_CHARS
        ? splitTextForTts(segment, { maxChars: smallerMax }).filter((s) => s && s !== segment)
        : [];
      if (smaller.length > 1) {
        debugLog()?.warn("voice-ws", `tts segment failed, retrying as ${smaller.length} smaller chunks: ${errorMessage(err)}`);
        this.activeSpeakingQueue?.unshift(...smaller);
        return;
      }
      throw err;
    }
    if (!signal?.aborted && this.currentReplyPlayed) {
      this.currentReplyPlayed.playedSegments.push(segment);
    }
  }

  /**
   * 2026-05-01 — 推一个 100ms TTS PCM chunk 到客户端,同时:
   *   ① ERLE 双轨录 ttsChunks
   *   ② P1-① reference queue push(供 onAudio 时 AEC processRender 用)
   */
  emitTtsPcmChunk(chunk: Buffer): void {
    this.send(makeFrame(FRAME.PCM_TTS, 0, this.outSeq++, chunk));
    if (this.erleRecord) {
      this.erleRecord.ttsChunks.push(Buffer.from(chunk));
    }
    if (this.aecProcessor && this.referenceQueue) {
      this.referenceQueue.push(chunk);
    }
  }

  async streamSegmentToPcm(segment: string, signal?: AbortSignal): Promise<void> {
    let yieldedAny = false;
    let degradedFlagged = false;
    try {
      const stream = this.ttsProvider.synthesizeStream;
      if (!stream) return;
      for await (const piece of stream.call(this.ttsProvider, segment, {
        speed: 1.0,
        signal,
        timeoutMs: TTS_SEGMENT_TIMEOUT_MS,
      })) {
        if (signal?.aborted) break;
        // 2026-05-01 修 2:fallback wrapper 在 primary 流式 yield 几段后才挂 → fallback
        // synthesize 整段当第 N+1 个 chunk yield(`fallbackUsed: true`)。旧逻辑只在 firstChunk
        // 检测,会漏触发 DEGRADED。改成"任意 chunk 出现 fallbackUsed 就触发,只一次"。
        if (!degradedFlagged && piece?.fallbackUsed) {
          this.setState(STATE.DEGRADED);
          degradedFlagged = true;
          debugLog()?.warn("voice-ws", `tts stream fallback used: ${piece.primaryError || "primary failed"}`);
        }
        const audio = piece?.audio || piece?.audioBuffer || piece?.buffer
          || (piece?.path ? fs.readFileSync(piece.path) : null);
        if (!audio) continue;
        const pcm = normalizeTtsAudioToPcm16Mono16k(audio);
        for (const chunk of chunkBuffer(pcm)) {
          if (signal?.aborted) break;
          this.emitTtsPcmChunk(chunk);
          yieldedAny = true;
        }
      }
    } catch (err) {
      // 2026-05-01 修 3:stream 中途失败时已 yield PCM 不能撤回,切小重试会让用户
      // 重听段落;打 yieldedAny 标记给 caller,caller 决定是否切小重试。
      const wrapped: TtsStreamError = err instanceof Error ? err : new Error(String(err));
      wrapped.yieldedAny = yieldedAny;
      throw wrapped;
    }
  }

  /**
   * 旧 batch 路径(provider 不支持 stream 时):整段 synthesize → 切 PCM 一次性推
   */
  async batchSegmentToPcm(segment: string, signal?: AbortSignal): Promise<void> {
    const speech = asTtsPiece(await this.ttsProvider.synthesize(segment, {
      speed: 1.0,
      signal,
      timeoutMs: TTS_SEGMENT_TIMEOUT_MS,
    }));
    if (speech?.fallbackUsed) {
      this.setState(STATE.DEGRADED);
      debugLog()?.warn("voice-ws", `tts fallback used: ${speech.primaryError || "primary failed"}`);
    }
    const audio = speech?.audio || speech?.audioBuffer || speech?.buffer
      || (speech?.path ? fs.readFileSync(speech.path) : null);
    const pcm = normalizeTtsAudioToPcm16Mono16k(audio);
    for (const chunk of chunkBuffer(pcm)) {
      if (signal?.aborted) break;
      this.emitTtsPcmChunk(chunk);
    }
  }

  /**
   * 2026-05-01 P0-① — 增量 TTS append
   *
   * 状态机决策(B2 race fix 2026-05-01):
   *   SPEAKING + activeSpeakingQueue 存在 → push 进 active(主路径)
   *   SPEAKING + 处理中(processingTurn 非空)即使 activeSpeakingQueue 还没创建
   *     /已被 finally 清 null → push 到 pendingAppendQueue,speakText 的 grace
   *     period 会取走;避免被 fresh processSpeakTextTurn 锁吞。
   *   LISTENING / DEGRADED → drop。LISTENING 表示用户已开口(onInterrupt 后),
   *     残段不该让 server 重新发声压过用户输入。
   *   IDLE 且无 processingTurn → fresh speakText(兼容旧路径)。
   */
  appendSpeakText(text: unknown): void {
    const value = String(text || "").trim();
    if (!value) return;
    const segments = splitTextForTts(value);
    if (segments.length === 0) return;
    // 主路径:active queue 存在
    if (this.activeSpeakingQueue && this.state === STATE.SPEAKING) {
      this.activeSpeakingQueue.push(...segments);
      if (this.currentReplyPlayed) {
        this.currentReplyPlayed.segments.push(...segments);
        this.currentReplyPlayed.fullText = `${this.currentReplyPlayed.fullText || ""}${value}`;
      }
      debugLog()?.log("voice-ws", `append speak text: +${segments.length} segments (queue=${this.activeSpeakingQueue.length})`);
      return;
    }
    // 用户已开口 / 主链异常,残段不该播
    if (this.state === STATE.LISTENING || this.state === STATE.DEGRADED) {
      debugLog()?.log("voice-ws", `append speak text dropped (state=${this.state}): residual after interrupt/degraded`);
      return;
    }
    // B2 race window:processingTurn 仍在(可能 SPEAKING 间隙 / IDLE 但 finally 还没跑完)
    // → push 到 pendingAppendQueue,speakText grace period 接收。
    if (this.processingTurn) {
      this.pendingAppendQueue.push(...segments);
      if (this.currentReplyPlayed) {
        this.currentReplyPlayed.segments.push(...segments);
        this.currentReplyPlayed.fullText = `${this.currentReplyPlayed.fullText || ""}${value}`;
      }
      debugLog()?.log("voice-ws", `append speak text → pending (race window, +${segments.length}, pending=${this.pendingAppendQueue.length})`);
      return;
    }
    // 真正 IDLE → fresh speakText
    void this.processSpeakTextTurn(value);
  }

  onPing(frame: VoiceFrame): void {
    // 原 payload 直接回(含 client_send_ts,client 计算 RTT)
    this.send(makeFrame(FRAME.PONG, 0, frame.seq, frame.payload));
  }

  /**
   * DS V4 Pro 反馈 #3 · T1 阶段(VAD 检测到用户开口):
   *   仅执行截断 + 快照已播放部分到 pendingInterruptedReply
   *   不写对话历史 — 等 ASR final 后由 resolveInterruptedReply 决策
   */
  onInterrupt(): void {
    if (this.state === STATE.SPEAKING || this.state === STATE.THINKING) {
      // 快照已播放 segments(仅 SPEAKING 态有意义;THINKING 态 currentReplyPlayed=null)
      if (this.currentReplyPlayed && Array.isArray(this.currentReplyPlayed.playedSegments) && this.currentReplyPlayed.playedSegments.length > 0) {
        const played = this.currentReplyPlayed;
        this.pendingInterruptedReply = {
          text: played.playedSegments.join(""),
          segmentsPlayed: played.playedSegments.length,
          totalSegments: Array.isArray(played.segments) ? played.segments.length : played.playedSegments.length,
          startedAt: played.startedAt,
          interruptedAt: Date.now(),
        };
        debugLog()?.log("voice-ws", `T1 snapshot: interrupted at ${played.playedSegments.length}/${Array.isArray(played.segments) ? played.segments.length : "?"} segments`);
      }
      this.currentReplyPlayed = null;
      this.turnGeneration += 1;
      this.turnAbort?.abort();
      this.turnAbort = null;
      this.processingTurn = null;
      this.utteranceBuffer = [];
      this.totalBufferedSamples = 0;
      this.resetVad();
      debugLog()?.log("voice-ws", "interrupt received");
      this.setState(STATE.LISTENING);
    }
  }

  isStaleTurn(generation: number): boolean {
    return generation !== this.turnGeneration;
  }

  isIntentionalAbort(err: unknown): boolean {
    return errorName(err) === "AbortError";
  }

  resetVad(): void {
    this.vadSpeechFrames = 0;
    this.vadSilenceFrames = 0;
    this.vadArmed = false;
  }

  onClose(): void {
    const elapsed = (Date.now() - this.startTs) / 1000;
    debugLog()?.log("voice-ws",
      `session closed after ${elapsed.toFixed(1)}s, ` +
      `pcm_frames_in=${this.pcmFramesIn} bytes_in/out=${this.bytesIn}/${this.bytesOut}`,
    );
    // ERLE 双轨:session 结束落盘 mic.wav + tts.wav
    if (this.erleRecord) {
      try {
        if (!fs.existsSync(this.erleRecord.dir)) {
          fs.mkdirSync(this.erleRecord.dir, { recursive: true });
        }
        const micPath = `${this.erleRecord.dir}/${this.erleRecord.sessionId}-mic.wav`;
        const ttsPath = `${this.erleRecord.dir}/${this.erleRecord.sessionId}-tts.wav`;
        const micPcm = Buffer.concat(this.erleRecord.micChunks);
        const ttsPcm = Buffer.concat(this.erleRecord.ttsChunks);
        if (micPcm.length) fs.writeFileSync(micPath, pcm16ToWav(micPcm));
        if (ttsPcm.length) fs.writeFileSync(ttsPath, pcm16ToWav(ttsPcm));
        debugLog()?.log("voice-ws",
          `ERLE recorded: mic ${(micPcm.length / 32000).toFixed(1)}s → ${micPath}, ` +
          `tts ${(ttsPcm.length / 32000).toFixed(1)}s → ${ttsPath}`,
        );
      } catch (err) {
        debugLog()?.warn("voice-ws", `ERLE record write failed: ${errorMessage(err)}`);
      }
    }
  }
}

/**
 * 创建 Voice WS 路由
 *
 * @param {object} engine - Lynn engine 实例
 * @param {object} hub - WebSocket hub
 * @param {object} ctx - { upgradeWebSocket, asrProvider?, serProvider?, ttsProvider?, brainRunner? }
 * @returns {{wsRoute: Hono}}
 */
export function createVoiceWsRoute(engine: VoiceEngine, hub: unknown, { upgradeWebSocket, ...deps }: CreateVoiceWsRouteDeps) {
  const wsRoute = new Hono();

  const voiceHandler = upgradeWebSocket((_c: VoiceRouteContext) => {
    let session: VoiceSession | null = null;
    const mode = _c?.req?.query?.("mode") || deps.mode || "direct";

    return {
      onOpen(_event: unknown, ws: VoiceSocket) {
        session = new VoiceSession(ws, { ...deps, engine, hub, mode });
        session.onOpen();
        debugLog()?.log("voice-ws", "client connected");
      },

      onMessage(event: VoiceMessageEvent, _ws: VoiceSocket) {
        if (!session) return;

        // 二进制帧
        if (event.data instanceof ArrayBuffer || Buffer.isBuffer(event.data)) {
          const frame = parseFrame(event.data);
          if (!frame) return;

          switch (frame.type) {
            case FRAME.PCM_AUDIO:
              session.onAudio(frame);
              break;
            case FRAME.PING:
              session.onPing(frame);
              break;
            case FRAME.INTERRUPT:
              session.onInterrupt();
              break;
            case FRAME.END_OF_TURN:
              session.endOfTurn();
              break;
            case FRAME.TEXT_TURN:
              session.processTextTurn(frame.payload.toString("utf-8"));
              break;
            case FRAME.SPEAK_TEXT:
              session.processSpeakTextTurn(frame.payload.toString("utf-8"));
              break;
            case FRAME.SPEAK_TEXT_APPEND:
              session.appendSpeakText(frame.payload.toString("utf-8"));
              break;
            default:
              debugLog()?.log("voice-ws", `unknown frame type: 0x${frame.type.toString(16)}`);
          }
          return;
        }

        // 文本帧(future:用于 client → server 控制消息)
        debugLog()?.log("voice-ws", `text frame: ${String(event.data).slice(0, 100)}`);
      },

      onClose() {
        if (session) {
          session.onClose();
          session = null;
        }
      },

      onError(event: VoiceErrorEvent | unknown) {
        debugLog()?.log("voice-ws", `error: ${asRecord(event)?.message || event}`);
      },
    };
  }) as never;

  wsRoute.get("/voice-ws", voiceHandler);

  return { wsRoute };
}
