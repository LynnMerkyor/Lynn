import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { createCosyVoiceProvider } from "../plugins/tts-bridge/lib/providers/cosyvoice.js";
import { createTTSProvider, listTTSProviders } from "../plugins/tts-bridge/lib/tts-registry.js";
import { synthesizeStream } from "../plugins/tts-bridge/lib/tts-engine.js";
import registerAudioRoutes from "../plugins/tts-bridge/routes/audio.js";

const WAV_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00,
  0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
  0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
  0x22, 0x56, 0x00, 0x00, 0x44, 0xac, 0x00, 0x00,
  0x02, 0x00, 0x10, 0x00, 0x64, 0x61, 0x74, 0x61,
  0x02, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

function okStreamResponse() {
  return new Response(WAV_BYTES, {
    status: 200,
    headers: { "content-type": "audio/wav" },
  });
}

let originalFetch;

beforeEach(() => {
  originalFetch = global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("CosyVoice TTS stream provider", () => {
  it("is the default TTS provider after Spark stream recovery", () => {
    expect(createTTSProvider({}).name).toBe("cosyvoice");
    expect(listTTSProviders()[0]).toMatchObject({ id: "cosyvoice", default: true });
  });

  it("calls /v1/audio/speech/stream and returns the response body", async () => {
    const captured = {};
    global.fetch = vi.fn(async (url, init) => {
      captured.url = String(url);
      captured.body = JSON.parse(init.body);
      return okStreamResponse();
    });

    const provider = createCosyVoiceProvider({ base_url: "http://tts.local" });
    const result = await provider.synthesizeStream({ text: "你好 Lynn", voice: "中文女", speed: 1.1 });

    expect(captured.url).toBe("http://tts.local/v1/audio/speech/stream");
    expect(captured.body).toMatchObject({
      model: "cosyvoice2",
      input: "你好 Lynn",
      voice: "中文女",
      response_format: "wav",
      speed: 1.1,
    });
    expect(result.provider).toBe("cosyvoice");
    expect(result.mimeType).toBe("audio/wav");
    expect(result.stream).toBeTruthy();
  });

  it("tts-engine exposes synthesizeStream for the configured provider", async () => {
    global.fetch = vi.fn(async () => okStreamResponse());
    const result = await synthesizeStream({
      text: "测试一句",
      provider: "cosyvoice",
      config: { base_url: "http://tts.local" },
    });
    expect(result.provider).toBe("cosyvoice");
  });
});
describe("tts-bridge audio stream route", () => {
  it("proxies CosyVoice stream as a chunked audio response", async () => {
    global.fetch = vi.fn(async () => okStreamResponse());
    const app = new Hono();
    registerAudioRoutes(app, {
      dataDir: "",
      config: { get: (key) => key === "provider" ? "cosyvoice" : undefined },
      engine: { config: { voice: { tts: { provider: "cosyvoice", default_voice: "中文女", base_url: "http://tts.local" } } } },
      log: { warn: vi.fn() },
    });

    const res = await app.request("/audio/speech/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "今天状态不错" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("audio/wav");
    expect(res.headers.get("x-lynn-tts-provider")).toBe("cosyvoice");
    expect(new Uint8Array(await res.arrayBuffer()).length).toBeGreaterThan(40);
  });

  it("returns 409 when the selected provider cannot stream", async () => {
    const app = new Hono();
    registerAudioRoutes(app, {
      dataDir: "",
      config: { get: (key) => key === "provider" ? "edge" : undefined },
      engine: { config: { voice: { tts: { provider: "edge" } } } },
      log: { warn: vi.fn() },
    });

    const res = await app.request("/audio/speech/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "tts_stream_unavailable", provider: "edge" });
  });
});
