/**
 * audio.js — TTS 音频文件 HTTP 路由
 *
 * 提供 /audio/:filename 端点供前端播放已生成的语音文件。
 */
import { Hono } from "hono";
import fs from "fs";
import path from "path";
import os from "os";
import { synthesizeStream } from "../lib/tts-engine.js";
import { normalizeSpeechText } from "../tools/tts-speak.js";

function voiceForProvider(provider, requestedVoice, defaultVoice) {
  if (provider === "say") return "";
  if (provider === "edge") {
    if (String(requestedVoice || defaultVoice || "").startsWith("zh-")) return requestedVoice || defaultVoice;
    return "zh-CN-XiaoxiaoNeural";
  }
  return requestedVoice || defaultVoice;
}

function resolveVoiceConfig(ctx) {
  const engineConfig = ctx.engine?.config || {};
  const voiceConfig = engineConfig.voice?.tts || {};
  return {
    provider: voiceConfig.provider || ctx.config?.get?.("provider") || "cosyvoice",
    default_voice: voiceConfig.default_voice || ctx.config?.get?.("default_voice") || "中文女",
    base_url: voiceConfig.base_url || ctx.config?.get?.("base_url") || "",
    api_key: voiceConfig.api_key || ctx.config?.get?.("api_key") || "",
    voice_clone_audio_path: voiceConfig.voice_clone_audio_path || ctx.config?.get?.("voice_clone_audio_path") || "",
    voice_description: voiceConfig.voice_description || ctx.config?.get?.("voice_description") || "",
  };
}

export default function registerAudioRoutes(app, ctx) {
  const audioDirs = [
    path.join(os.homedir(), ".lynn", "audio"),
    path.join(ctx.dataDir || "", "audio"),
  ].filter(Boolean);
  for (const dir of audioDirs) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  }

  app.get("/audio/:filename", async (c) => {
    const filename = c.req.param("filename");
    if (!filename || path.basename(filename) !== filename) {
      return c.json({ error: "invalid_filename" }, 400);
    }
    const filePath = audioDirs
      .map((dir) => path.join(dir, filename))
      .find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    if (!filePath) {
      return c.json({ error: "not_found" }, 404);
    }
    const stat = fs.statSync(filePath);
    const ext = path.extname(filename).toLowerCase();
    const mime = ext === ".mp3" ? "audio/mpeg" : ext === ".wav" ? "audio/wav" : "application/octet-stream";
    c.header("Content-Type", mime);
    c.header("Content-Length", String(stat.size));
    c.header("Accept-Ranges", "bytes");
    c.header("Cache-Control", "private, max-age=3600");
    return c.body(fs.createReadStream(filePath));
  });

  const handleSpeechStream = async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const text = String(body.text || "").trim();
    if (!text) return c.json({ error: "tts_stream_empty_text" }, 400);

    const voiceConfig = resolveVoiceConfig(ctx);
    const provider = voiceConfig.provider || "cosyvoice";
    if (provider !== "cosyvoice") {
      return c.json({ error: "tts_stream_unavailable", provider }, 409);
    }

    try {
      const speechText = await normalizeSpeechText(text).then((value) => String(value || "").slice(0, 3000));
      const result = await synthesizeStream({
        text: speechText,
        voice: voiceForProvider(provider, body.voice, voiceConfig.default_voice),
        speed: body.speed || voiceConfig.speed || 1,
        provider,
        config: voiceConfig,
      });
      c.header("Content-Type", result.mimeType || "audio/wav");
      c.header("Cache-Control", "no-store");
      c.header("X-Lynn-TTS-Provider", result.provider || provider);
      return c.body(result.stream);
    } catch (err) {
      ctx.log?.warn?.("tts_speak_stream failed:", err?.message || err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  };

  app.post("/audio/speech/stream", handleSpeechStream);
  app.post("/audio/stream", handleSpeechStream);
}
