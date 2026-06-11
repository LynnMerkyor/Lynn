import { debugLog } from "../../lib/debug-log.js";
import {
  bufferInt16LEToFloat32,
  float32ToInt16LEBuffer,
  PCM_SAMPLE_RATE,
  toBuffer,
} from "./voice-audio-codec.js";
import {
  aecProcessCapture as defaultAecCapture,
  aecProcessRender as defaultAecRender,
} from "../clients/aec/index.js";
import type { AecCapture, AecProcessorHandle, AecRender, BinaryInput } from "./voice-ws-types.js";

// Native AEC consumes 10ms frames at the current voice PCM sample rate.
export const AEC_SAMPLES_PER_FRAME = 160;

/**
 * TTS reference signal queue(Int16 LE bytes).
 *
 * The server pushes outbound PCM_TTS chunks here, then pulls matching reference
 * audio for AEC when microphone frames arrive. The queue keeps only recent
 * samples so a long silent listener does not grow memory without bound.
 */
export class TtsReferenceQueue {
  maxSamples: number;
  bytes: Buffer;

  constructor({ maxSamples = PCM_SAMPLE_RATE * 10 }: { maxSamples?: number } = {}) {
    this.maxSamples = maxSamples;
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
   * Take `sampleCount` samples as Int16 bytes. If the queue is short, zero-pad.
   * `trimSamples` can discard older reference samples to tune speaker→mic delay.
   */
  take(sampleCount: number, trimSamples = 0): Buffer {
    const wantBytes = sampleCount * 2;
    if (trimSamples > 0) {
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
    const partial = this.bytes;
    this.bytes = Buffer.alloc(0);
    const padded = Buffer.alloc(wantBytes);
    partial.copy(padded, 0);
    return padded;
  }

  size(): number {
    return this.bytes.length / 2;
  }

  clear(): void {
    this.bytes = Buffer.alloc(0);
  }
}

/**
 * Run AEC for one 100ms PCM frame by feeding WebRTC's native 10ms render/capture
 * pairs. Any AEC failure degrades to the original mic buffer.
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
    const message = err instanceof Error ? err.message : String(err || "");
    debugLog()?.warn("voice-ws", `aec process frame failed: ${message}`);
    return micBuf;
  }
}
