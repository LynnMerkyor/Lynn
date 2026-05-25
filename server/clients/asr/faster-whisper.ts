/**
 * faster-whisper ASR Provider · v0.77
 *
 * 自托管 faster-whisper 服务（GPU 服务器或本地）。
 * 环境变量：LYNN_ASR_URL（默认 http://localhost:8004）
 */

const ASR_URL = process.env.LYNN_ASR_URL || "http://localhost:8004";

interface FasterWhisperConfig {
  [key: string]: unknown;
}

interface TranscribeOptions {
  language?: string;
  filename?: string;
}

export function createFasterWhisperProvider(_config: FasterWhisperConfig = {}) {
  return {
    name: "faster-whisper",
    label: "Faster Whisper (自托管)",

    async transcribe(audioBuffer: unknown, { language = "zh", filename = "audio.webm" }: TranscribeOptions = {}) {
      const form = new FormData();
      form.append("file", new Blob([audioBuffer as BlobPart], { type: "audio/webm" }), filename);
      form.append("language", language);
      form.append("response_format", "json");

      const res = await fetch(`${ASR_URL}/v1/audio/transcriptions`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) throw new Error(`transcribe failed: HTTP ${res.status}`);
      return (await res.json()) as Record<string, unknown>; // { text, language, duration }
    },

    async health() {
      try {
        const r = await fetch(`${ASR_URL}/health`, { signal: AbortSignal.timeout(2000) });
        return r.ok;
      } catch { return false; }
    },
  };
}
