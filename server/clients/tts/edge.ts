/**
 * Edge TTS fallback provider for Lynn Jarvis Runtime.
 *
 * Uses Microsoft Edge read-aloud WebSocket directly so we can request raw
 * 16kHz PCM instead of the npm package's hardcoded MP3 output.
 */
import { randomUUID } from "node:crypto";
// @ts-ignore -- ws is a runtime dependency without bundled declarations in this project.
import { WebSocket } from "ws";

const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const EDGE_TTS_HOST = "speech.platform.bing.com";
const EDGE_TTS_BASE = `${EDGE_TTS_HOST}/consumer/speech/synthesize/readaloud`;
const EDGE_TTS_WS_URL = `wss://${EDGE_TTS_BASE}/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`;
const EDGE_TTS_VOICE_LIST_URL = `https://${EDGE_TTS_BASE}/voices/list?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`;
const DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural";
const DEFAULT_OUTPUT_FORMAT = "raw-16khz-16bit-mono-pcm";

type WebSocketSendCallback = (err?: Error) => void;

interface WebSocketLike {
  on(event: "message", cb: (rawData: Buffer, isBinary: boolean) => void): unknown;
  on(event: "error", cb: (err: unknown) => void): unknown;
  on(event: "open", cb: () => void): unknown;
  on(event: string, cb: (...args: unknown[]) => void): unknown;
  send(message: string, options: { compress: boolean }, cb: WebSocketSendCallback): unknown;
  close(): unknown;
}

interface WebSocketOptions {
  host: string;
  origin: string;
  headers: Record<string, string>;
}

type WebSocketCtor = new (url: string, options: WebSocketOptions) => WebSocketLike;

interface EdgeTtsConfig {
  default_voice?: string;
  voice?: string;
  output_format?: string;
  outputFormat?: string;
  timeout_ms?: number | string;
  timeoutMs?: number | string;
  websocketCtor?: WebSocketCtor;
  [key: string]: unknown;
}

interface EdgeSynthesizeOptions {
  voice?: string;
  speed?: number | string;
  pitch?: string;
  volume?: string;
  signal?: AbortSignal | null;
  timeoutMs?: number | string;
  [key: string]: unknown;
}

interface EdgeWebSocketRequest {
  text: string;
  voice: string;
  rate: string;
  pitch: string;
  volume: string;
  outputFormat: string;
  timeoutMs: number | string;
  signal: AbortSignal | null;
  websocketCtor: WebSocketCtor;
}

function requestId(): string {
  return randomUUID().replaceAll("-", "");
}

function escapeXml(value: unknown): string {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function speedToRate(speed: unknown): string {
  const n = Number(speed);
  if (!Number.isFinite(n) || n <= 0) return "+0%";
  const pct = Math.max(-80, Math.min(200, Math.round((n - 1) * 100)));
  return `${pct >= 0 ? "+" : ""}${pct}%`;
}

function extractAudioPayload(data: Buffer | ArrayBuffer | ArrayBufferView): Buffer {
  const buf = Buffer.isBuffer(data)
    ? data
    : ArrayBuffer.isView(data)
      ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
      : Buffer.from(data);
  const marker = Buffer.from("Path:audio\r\n", "utf-8");
  const markerIndex = buf.indexOf(marker);
  if (markerIndex < 0) return buf;
  return buf.subarray(markerIndex + marker.length);
}

export function createEdgeTtsProvider(config: EdgeTtsConfig = {}) {
  const defaultVoice = config.default_voice || config.voice || DEFAULT_VOICE;
  const outputFormat = config.output_format || config.outputFormat || DEFAULT_OUTPUT_FORMAT;
  const timeoutMs = Number(config.timeout_ms || config.timeoutMs || 15000);
  const websocketCtor = config.websocketCtor || (WebSocket as unknown as WebSocketCtor);

  return {
    name: "edge-tts",
    label: "Edge TTS (fallback)",

    async synthesize(text: unknown, { voice = defaultVoice, speed = 1.0, pitch = "+0Hz", volume = "+0%", signal = null, timeoutMs: callTimeoutMs = timeoutMs }: EdgeSynthesizeOptions = {}) {
      const input = String(text || "").trim();
      if (!input) throw new Error("edge-tts: empty text");

      const audio = await synthesizeWithEdgeWebSocket({
        text: input,
        voice: voice || defaultVoice,
        rate: speedToRate(speed),
        pitch,
        volume,
        outputFormat,
        timeoutMs: callTimeoutMs,
        signal,
        websocketCtor,
      });

      return {
        ok: true,
        provider: "edge-tts",
        mimeType: outputFormat.startsWith("raw-") ? "audio/pcm; rate=16000" : "audio/wav",
        audio,
      };
    },

    async health() {
      try {
        const r = await fetch(EDGE_TTS_VOICE_LIST_URL, { signal: AbortSignal.timeout(2500) });
        return r.ok;
      } catch {
        return false;
      }
    },
  };
}

function synthesizeWithEdgeWebSocket({
  text,
  voice,
  rate,
  pitch,
  volume,
  outputFormat,
  timeoutMs,
  signal,
  websocketCtor,
}: EdgeWebSocketRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const audioChunks: Buffer[] = [];
    const ws = new websocketCtor(`${EDGE_TTS_WS_URL}&ConnectionId=${requestId()}`, {
      host: EDGE_TTS_HOST,
      origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/103 Safari/537.36 Edg/103",
      },
    });

    const finish = (err: unknown, audio: Buffer | null = null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      try { ws.close(); } catch {
        // Best-effort cleanup only; network socket may already be closed.
      }
      if (err) reject(err);
      else resolve(audio || Buffer.concat(audioChunks));
    };

    const onAbort = () => finish(new Error("edge-tts synthesize aborted"));
    if (signal?.aborted) {
      finish(new Error("edge-tts synthesize aborted"));
      return;
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });

    timer = setTimeout(() => {
      finish(new Error(`edge-tts synthesize timed out after ${timeoutMs}ms`));
    }, Number(timeoutMs));

    ws.on("message", (rawData, isBinary) => {
      if (isBinary) {
        audioChunks.push(extractAudioPayload(rawData));
        return;
      }
      const data = rawData.toString("utf8");
      if (data.includes("turn.end")) {
        finish(null, Buffer.concat(audioChunks));
      }
    });

    ws.on("error", (err) => finish(err instanceof Error ? err : new Error(String(err))));

    ws.on("open", () => {
      const speechConfig = JSON.stringify({
        context: {
          synthesis: {
            audio: {
              metadataoptions: { sentenceBoundaryEnabled: false, wordBoundaryEnabled: false },
              outputFormat,
            },
          },
        },
      });
      const configMessage = `X-Timestamp:${Date()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n${speechConfig}`;
      ws.send(configMessage, { compress: true }, (configError) => {
        if (configError) {
          finish(configError);
          return;
        }
        const ssml = [
          `X-RequestId:${requestId()}`,
          "Content-Type:application/ssml+xml",
          `X-Timestamp:${Date()}Z`,
          "Path:ssml",
          "",
          `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>`,
          `<voice name='${escapeXml(voice)}'><prosody pitch='${escapeXml(pitch)}' rate='${escapeXml(rate)}' volume='${escapeXml(volume)}'>`,
          escapeXml(text),
          "</prosody></voice></speak>",
        ].join("\r\n");
        ws.send(ssml, { compress: true }, (ssmlError) => {
          if (ssmlError) finish(ssmlError);
        });
      });
    });
  });
}
