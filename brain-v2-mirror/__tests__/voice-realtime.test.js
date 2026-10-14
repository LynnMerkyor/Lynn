import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { FakeWs } = vi.hoisted(() => {
  class FakeWs {
    static OPEN = 1;
    static instances = [];
    readyState = 1;
    handlers = {};
    sent = [];

    constructor(url, opts) {
      this.url = url;
      this.opts = opts;
      FakeWs.instances.push(this);
    }

    on(event, cb) {
      this.handlers[event] = cb;
      return this;
    }

    send(message, cb) {
      const parsed = JSON.parse(String(message));
      this.sent.push(parsed);
      cb?.();
      if (parsed.type === 'response.create') {
        queueMicrotask(() => {
          if (parsed.response?.modalities?.includes('audio')) {
            this.message({ type: 'response.audio.delta', delta: Buffer.from([1, 0, 2, 0]).toString('base64') });
          } else {
            this.message({ type: 'response.raw_text.delta', delta: '深圳今天有雨' });
          }
          this.message({ type: 'response.done' });
        });
      }
    }

    close() {}

    open() {
      this.handlers.open?.();
    }

    message(value) {
      this.handlers.message?.(Buffer.from(JSON.stringify(value)));
    }
  }
  return { FakeWs };
});

vi.mock('ws', () => ({ default: FakeWs, WebSocketServer: class {} }));

const { voiceAsr, voiceTts } = await import('../voice-realtime.js');
const { bridgeRealtimeSession } = await import('../voice-realtime-proxy.js');

describe('brain realtime voice proxy', () => {
  beforeEach(() => {
    FakeWs.instances = [];
    vi.stubEnv('STEP37_KEY', 'sk-test');
    vi.stubEnv('STEP37_BASE', 'https://api.stepfun.com/step_plan/v1');
    vi.stubEnv('LYNN_STEP_REALTIME_ENDPOINT', '');
    vi.stubEnv('STEPFUN_REALTIME_ENDPOINT', '');
    vi.stubEnv('LYNN_STEP_ASR_ENDPOINT', '');
    vi.stubEnv('LYNN_STEP_ASR_MODEL', '');
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it('rejects assistant response transcripts as standalone user ASR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('data: {"type":"response.audio_transcript.done","transcript":"Not user input"}\n\n')));
    await expect(voiceAsr({
      audio_pcm_base64: Buffer.from([0, 0, 1, 0]).toString('base64'),
      timeout_ms: 1000,
    })).rejects.toThrow(/no completed user transcript/);
    expect(FakeWs.instances).toHaveLength(0);
  });

  it('uses Step Plan ASR with the original PCM rate and fragmented transcription events', async () => {
    const finalText = '今天的蓝色月亮语音测试已经完成。';
    const frames = `data: ${JSON.stringify({ type: 'transcript.text.delta', delta: '今天' })}\r\n\r\ndata: ${JSON.stringify({ type: 'transcript.text.done', text: finalText })}\r\n\r\n`;
    const bytes = new TextEncoder().encode(frames);
    const fetchMock = vi.fn(async () => new Response(new ReadableStream({ start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.slice(offset, offset + 7));
      controller.close();
    } })));
    vi.stubGlobal('fetch', fetchMock);
    const audio = Buffer.from([0, 0, 1, 0]).toString('base64');
    const result = await voiceAsr({ audio_base64: audio, sample_rate: 16000, language: 'zh' });
    expect(result).toMatchObject({ ok: true, provider: 'stepfun-asr', text: finalText });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.stepfun.com/step_plan/v1/audio/asr/sse');
    const request = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(request.audio.data).toBe(audio);
    expect(request.audio.input).toMatchObject({ transcription: { model: 'stepaudio-2.5-asr', language: 'zh' }, format: { rate: 16000, bits: 16, channel: 1 } });
    expect(FakeWs.instances).toHaveLength(0);
  });

  it.each([
    ['data: {"type":"transcript.text.delta","delta":"partial"}\n\n', /no completed user transcript/],
    ['data: {"type":"error","error":{"message":"failed"}}\n\n', /error event/],
    ['data: {"type":"transcript.text.done","text":""}\n\n', /no completed user transcript/],
  ])('does not accept incomplete or failed ASR: %s', async (events, expected) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(events)));
    await expect(voiceAsr({ audio_pcm_base64: 'AAAAAA==' })).rejects.toThrow(expected);
  });

  it('reports upstream status without exposing its response body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('secret diagnostic', { status: 403 })));
    await expect(voiceAsr({ audio_pcm_base64: 'AAAAAA==' })).rejects.toThrow('StepFun ASR HTTP 403');
  });

  it('rejects invalid audio before making a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(voiceAsr({})).rejects.toThrow('missing audio');
    await expect(voiceAsr({ audio_pcm_base64: 'AAAAAA==', sample_rate: 0 })).rejects.toThrow('sample rate');
    await expect(voiceAsr({ audio_pcm_base64: 'AA==' })).rejects.toThrow('PCM16');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['', 'https://api.stepfun.com/step_plan/v1', 'wss://api.stepfun.com/step_plan/v1/realtime'],
    ['', 'https://api.stepfun.com/step_plan/v1/chat/completions', 'wss://api.stepfun.com/step_plan/v1/realtime'],
    ['', '', 'wss://api.stepfun.com/step_plan/v1/realtime'],
    ['wss://custom.example/v1/realtime', 'https://api.stepfun.com/step_plan/v1', 'wss://custom.example/v1/realtime'],
  ])('uses the selected realtime billing endpoint: %s %s', (explicit, base, expected) => {
    vi.stubEnv('LYNN_STEP_REALTIME_ENDPOINT', explicit);
    vi.stubEnv('STEP37_BASE', base);
    vi.stubEnv('STEPFUN_BASE_URL', '');
    vi.stubEnv('STEP_BASE', '');
    const client = { readyState: 1, on: vi.fn(), send: vi.fn(), close: vi.fn() };
    const bridge = bridgeRealtimeSession(client);
    const upstream = FakeWs.instances[0];
    expect(upstream.url).toBe(`${expected}?model=stepaudio-2.5-realtime`);
    upstream.open();
    expect(upstream.sent[0].type).toBe('session.update');
    bridge.close();
  });

  it('proxies TTS and wraps returned PCM as wav', async () => {
    const pending = voiceTts({ text: '你好 Lynn', timeout_ms: 1000 });
    const ws = FakeWs.instances[0];
    ws.open();
    const result = await pending;
    expect(result).toMatchObject({
      ok: true,
      provider: 'stepfun-realtime',
      mime_type: 'audio/wav',
    });
    const wav = Buffer.from(String(result.audio_base64), 'base64');
    expect(wav.subarray(0, 4).toString('utf-8')).toBe('RIFF');
    expect(ws.url).toBe('wss://api.stepfun.com/step_plan/v1/realtime?model=stepaudio-2.5-realtime');
    expect(ws.sent.map(event => event.type)).toEqual(['session.update', 'conversation.item.create', 'response.create']);
    expect(ws.sent[0].session).toMatchObject({ voice: 'jingdiannvsheng', turn_detection: null });
    expect(ws.sent[1].item.content[0].text).toContain('你好 Lynn');
    expect(ws.sent[2].response.modalities).toEqual(['audio', 'text']);
    expect(ws.sent[2].response).not.toHaveProperty('history');
  });

  it('sends the upstream connection error before closing the client once', () => {
    const client = { readyState: 1, on: vi.fn(), send: vi.fn(), close: vi.fn() };
    bridgeRealtimeSession(client);
    const upstream = FakeWs.instances[0];
    upstream.handlers.error(new Error('upstream connection rejected'));
    upstream.handlers.close(1006);
    expect(client.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(client.send.mock.calls[0][0])).toEqual({ type: 'error', message: 'upstream connection rejected' });
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it('preserves an explicitly configured stateless endpoint and protocol', async () => {
    vi.stubEnv('LYNN_STEP_REALTIME_ENDPOINT', 'wss://voice.example/v1/realtime/stateless');
    const pending = voiceTts({ text: '你好', timeout_ms: 1000 });
    const ws = FakeWs.instances[0];
    ws.open();
    await pending;
    expect(ws.url).toBe('wss://voice.example/v1/realtime/stateless?model=stepaudio-2.5-realtime');
    expect(ws.sent).toHaveLength(1);
    expect(ws.sent[0].response.history[0].content[0].text).toContain('你好');
  });
});
