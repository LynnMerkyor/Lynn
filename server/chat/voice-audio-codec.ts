import { FRAME } from "./voice-ws-types.js";
import type {
  BinaryInput,
  DecodedPcmAudio,
  FrameCode,
  VoiceFrame,
  VoiceState,
} from "./voice-ws-types.js";

export const PCM_SAMPLE_RATE = 24000;
export const PCM_TTS_CHUNK_BYTES = 4800; // 100ms @ 24kHz Int16 mono, StepFun Realtime native rate

export function toBuffer(value: BinaryInput): Buffer {
  if (!value) return Buffer.alloc(0);
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value));
  return Buffer.from(value);
}

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

export function makeStateFrame(seq: number, state: VoiceState): Buffer {
  return makeFrame(FRAME.STATE_CHANGE, 0, seq, Buffer.from(state, "utf-8"));
}

export function makeTranscriptFrame(type: FrameCode | number, seq: number, text: unknown): Buffer {
  return makeFrame(type, 0, seq, Buffer.from(String(text || ""), "utf-8"));
}

export function makeJsonFrame(type: FrameCode | number, seq: number, value: unknown): Buffer {
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

export function chunkBuffer(buf: Buffer, chunkBytes = PCM_TTS_CHUNK_BYTES): Buffer[] {
  const chunks: Buffer[] = [];
  for (let i = 0; i < buf.length; i += chunkBytes) {
    chunks.push(buf.subarray(i, Math.min(i + chunkBytes, buf.length)));
  }
  return chunks;
}
