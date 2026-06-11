import { beforeEach, describe, expect, it, vi } from 'vitest';

const { FakeWs } = vi.hoisted(() => {
  class FakeWs {
    static instances = [];
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

vi.mock('ws', () => ({ default: FakeWs }));

const { voiceAsr, voiceTts } = await import('../voice-realtime.js');

describe('brain realtime voice proxy', () => {
  beforeEach(() => {
    FakeWs.instances = [];
    process.env.STEP37_KEY = 'sk-test';
    process.env.STEP37_BASE = 'https://api.stepfun.com/step_plan/v1';
  });

  it('rejects standalone ASR so assistant response transcripts cannot become user input', async () => {
    await expect(voiceAsr({
      audio_pcm_base64: Buffer.from([0, 0, 1, 0]).toString('base64'),
      timeout_ms: 1000,
    })).rejects.toThrow(/not standalone user ASR transcripts/);
    expect(FakeWs.instances).toHaveLength(0);
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
    expect(ws.sent).toHaveLength(1);
    expect(ws.sent[0].response.modalities).toEqual(['audio', 'text']);
  });
});
