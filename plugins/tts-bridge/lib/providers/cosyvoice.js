/**
 * CosyVoice 2 TTS Provider · fallback path
 *
 * CosyVoice 2 runs only as fallback after Lynn Brain hosted StepFun Realtime.
 *
 * 协议:OpenAI 兼容 /v1/audio/speech(POST text → wav bytes)
 * 环境变量:LYNN_COSYVOICE_URL(默认 http://localhost:18021)
 */
import fs from "fs";

function resolveBaseUrl(config) {
  return String(config?.base_url || config?.baseUrl || process.env.LYNN_COSYVOICE_URL || "http://localhost:18021").replace(/\/+$/, "");
}

function buildSpeechBody({ text, voice, speed }) {
  return {
    model: "cosyvoice2",
    input: text,
    voice: voice || "中文女",
    response_format: "wav",
    speed: speed || 1.0,
  };
}

export function createCosyVoiceProvider(config = {}) {
  const baseUrl = resolveBaseUrl(config);
  return {
    name: "cosyvoice",
    label: "CosyVoice 2 (Spark fallback)",
    supportsStreaming: true,

    async synthesize({ text, voice, speed, outPath }) {
      if (!text || !text.trim()) {
        throw new Error("cosyvoice: empty text");
      }
      const dir = outPath.substring(0, outPath.lastIndexOf("/"));
      if (dir) fs.mkdirSync(dir, { recursive: true });

      const res = await fetch(`${baseUrl}/v1/audio/speech`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildSpeechBody({ text, voice, speed })),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`cosyvoice synthesize failed: HTTP ${res.status} ${errText.slice(0, 120)}`);
      }

      const arrayBuffer = await res.arrayBuffer();
      fs.writeFileSync(outPath, Buffer.from(arrayBuffer));
      return { ok: true, provider: "cosyvoice", path: outPath };
    },

    async synthesizeStream({ text, voice, speed } = {}) {
      if (!text || !text.trim()) {
        throw new Error("cosyvoice: empty text");
      }
      const res = await fetch(`${baseUrl}/v1/audio/speech/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildSpeechBody({ text, voice, speed })),
      });

      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => "");
        throw new Error(`cosyvoice stream failed: HTTP ${res.status} ${errText.slice(0, 120)}`);
      }

      return {
        ok: true,
        provider: "cosyvoice",
        stream: res.body,
        mimeType: res.headers.get("content-type") || "audio/wav",
      };
    },
  };
}
