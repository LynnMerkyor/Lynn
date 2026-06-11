export interface DecodedPcmAudio {
  pcm: Buffer;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}

const STEP_SAMPLE_RATE = 24_000;

export function decodePcm16Audio(audioBuffer: Buffer): DecodedPcmAudio {
  const buf = Buffer.from(audioBuffer);
  if (buf.length < 12 || buf.subarray(0, 4).toString("ascii") !== "RIFF" || buf.subarray(8, 12).toString("ascii") !== "WAVE") {
    return { pcm: buf, sampleRate: STEP_SAMPLE_RATE, channels: 1, bitsPerSample: 16 };
  }

  let sampleRate = STEP_SAMPLE_RATE;
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
      sampleRate = buf.readUInt32LE(dataStart + 4) || STEP_SAMPLE_RATE;
      bitsPerSample = buf.readUInt16LE(dataStart + 14) || 16;
    } else if (chunkId === "data") {
      pcm = Buffer.from(buf.subarray(dataStart, dataEnd));
    }
    offset = dataStart + chunkSize + (chunkSize % 2);
  }
  return { pcm: pcm.length ? pcm : buf, sampleRate, channels, bitsPerSample };
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

function resamplePcm16Mono(pcm: Buffer, fromRate: number, toRate = STEP_SAMPLE_RATE): Buffer {
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

export function prepareStepFunRealtimePcm24k(audio: Buffer): Buffer {
  const decoded = decodePcm16Audio(audio);
  if (decoded.bitsPerSample !== 16) {
    throw new Error(`StepFun Realtime ASR requires PCM16/WAV input, got ${decoded.bitsPerSample}-bit audio`);
  }
  return resamplePcm16Mono(downmixPcm16ToMono(decoded.pcm, decoded.channels), decoded.sampleRate, STEP_SAMPLE_RATE);
}

export function pcm16ToWav(pcm: Buffer, { sampleRate = STEP_SAMPLE_RATE, channels = 1 }: { sampleRate?: number; channels?: number } = {}): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * 2;
  const blockAlign = channels * 2;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
