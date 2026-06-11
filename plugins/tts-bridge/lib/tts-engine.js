/**
 * tts-engine.js — 语音合成引擎（多 Provider 封装）
 *
 * 默认通过 Lynn Brain 托管 StepFun Realtime。Spark/CosyVoice、macOS say、
 * Edge/OpenAI 只作为 fallback 或显式选择。
 */

import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createTTSProvider } from "./tts-registry.js";

export async function synthesize({ text, voice, speed, outPath, provider = "stepfun-realtime", config = {} }) {
  const tts = createTTSProvider({ ...config, provider });
  return tts.synthesize({ text, voice, speed, outPath });
}

export async function synthesizeStream({ text, voice, speed, provider = "stepfun-realtime", config = {} }) {
  const tts = createTTSProvider({ ...config, provider });
  if (typeof tts.synthesizeStream !== "function") {
    const outPath = path.join(os.tmpdir(), `lynn-tts-${Date.now()}-${Math.random().toString(16).slice(2)}.wav`);
    const result = await tts.synthesize({ text, voice, speed, outPath });
    const audio = fs.readFileSync(result.path || outPath);
    fs.rmSync(result.path || outPath, { force: true });
    return {
      ok: true,
      provider: result.provider || provider,
      stream: Readable.toWeb(Readable.from([audio])),
      mimeType: result.mimeType || "audio/wav",
    };
  }
  return tts.synthesizeStream({ text, voice, speed });
}
