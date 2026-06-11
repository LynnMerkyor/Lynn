import crypto from 'node:crypto';
import WebSocket from 'ws';

type JsonObject = Record<string, unknown>;
type WsData = Buffer | ArrayBuffer | Buffer[] | Uint8Array;

const DEFAULT_ENDPOINT = 'wss://api.stepfun.com/v1/realtime/stateless';
const DEFAULT_MODEL = 'step-overture-preview';
const DEFAULT_VOICE = 'jingdiannvsheng';
const DEFAULT_TIMEOUT_MS = 30_000;

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function numberValue(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function env(...keys: string[]): string {
  for (const key of keys) {
    const value = stringValue(process.env[key]);
    if (value) return value;
  }
  return '';
}

function normalizeRealtimeEndpoint(value: string): string {
  if (!value) return DEFAULT_ENDPOINT;
  let endpoint = value;
  if (/^https:\/\//i.test(endpoint)) endpoint = endpoint.replace(/^https:/i, 'wss:');
  if (/^http:\/\//i.test(endpoint)) endpoint = endpoint.replace(/^http:/i, 'ws:');
  endpoint = endpoint.replace(/\/+$/, '');
  endpoint = endpoint
    .replace(/\/step_plan\/v1(?:\/chat\/completions)?$/i, '')
    .replace(/\/v1\/chat\/completions$/i, '');
  if (!/\/v1\/realtime\/stateless$/i.test(endpoint)) {
    endpoint = /\/v1$/i.test(endpoint) ? `${endpoint}/realtime/stateless` : `${endpoint}/v1/realtime/stateless`;
  }
  return endpoint;
}

function resolveConfig(body: JsonObject = {}) {
  const apiKey = env(
    'LYNN_STEP_REALTIME_KEY',
    'STEPFUN_REALTIME_API_KEY',
    'STEP37_KEY',
    'STEPFUN_CODING_KEY',
    'STEPFUN_CODING_API_KEY',
    'STEPFUN_API_KEY',
    'STEP_KEY',
    'STEP_API_KEY',
  );
  return {
    apiKey,
    endpoint: normalizeRealtimeEndpoint(
      env('LYNN_STEP_REALTIME_ENDPOINT', 'STEPFUN_REALTIME_ENDPOINT', 'STEP37_BASE', 'STEPFUN_BASE_URL', 'STEP_BASE'),
    ),
    model: env('LYNN_STEP_REALTIME_MODEL', 'STEPFUN_REALTIME_MODEL') || DEFAULT_MODEL,
    voice: stringValue(body.voice) || env('LYNN_STEP_REALTIME_VOICE', 'STEPFUN_REALTIME_VOICE') || DEFAULT_VOICE,
    timeoutMs: numberValue(body.timeout_ms ?? body.timeoutMs, DEFAULT_TIMEOUT_MS),
  };
}

function pcm16ToWav(pcm: Buffer, sampleRate = 24_000): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function shortId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

function eventId(): string {
  return `evt_${shortId()}`;
}

function userTextHistory(text: string): JsonObject[] {
  const clean = stringValue(text);
  return clean
    ? [{
        id: `msg_${shortId()}`,
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: clean }],
      }]
    : [];
}

function wsDataToJson(data: WsData): JsonObject {
  const raw = Buffer.isBuffer(data)
    ? data.toString('utf-8')
    : data instanceof ArrayBuffer
      ? Buffer.from(data).toString('utf-8')
      : Array.isArray(data)
        ? Buffer.concat(data).toString('utf-8')
        : Buffer.from(data as Uint8Array).toString('utf-8');
  return JSON.parse(raw) as JsonObject;
}

function sendJson(ws: WebSocket, value: JsonObject): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.send(JSON.stringify(value), (err?: Error) => err ? reject(err) : resolve());
  });
}

async function runRealtime(body: JsonObject, input: { mode: 'asr' | 'tts'; audioPcm?: Buffer; text?: string; signal?: AbortSignal }) {
  const config = resolveConfig(body);
  if (!config.apiKey) throw new Error('StepFun Realtime server key is not configured');
  const url = `${config.endpoint}?model=${encodeURIComponent(config.model)}`;
  const ws = new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'X-Trace-Id': crypto.randomUUID(),
    },
  });

  return await new Promise<{ text: string; audio: Buffer; raw: JsonObject[] }>((resolve, reject) => {
    let settled = false;
    let text = '';
    const audioChunks: Buffer[] = [];
    const raw: JsonObject[] = [];
    const timer = setTimeout(() => finish(new Error('StepFun Realtime timed out')), config.timeoutMs);
    const abort = () => finish(new Error('StepFun Realtime aborted'));
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', abort);
      try { ws.close(); } catch { /* best-effort */ }
      if (err) reject(err);
      else resolve({ text: text.trim(), audio: Buffer.concat(audioChunks), raw });
    };

    input.signal?.addEventListener('abort', abort, { once: true });

    ws.on('open', async () => {
      try {
        if (input.mode === 'asr') {
          const audio = input.audioPcm || Buffer.alloc(0);
          await sendJson(ws, { event_id: eventId(), type: 'input_audio_buffer.append', audio: audio.toString('base64') });
          await sendJson(ws, { event_id: eventId(), type: 'input_audio_buffer.commit' });
          await sendJson(ws, {
            event_id: eventId(),
            type: 'response.create',
            response: {
              modalities: ['text'],
              instructions: '请只转写用户音频,不要回答、解释或改写。',
              history: [],
            },
          });
        } else {
          await sendJson(ws, {
            event_id: eventId(),
            type: 'response.create',
            response: {
              modalities: ['audio', 'text'],
              voice: config.voice,
              instructions: '你是一个纯文本朗读器。你的唯一任务是把用户要求朗读的文本原样读出来。不要回答、解释、改写、翻译、补充或加入闲聊。',
              history: userTextHistory(`请逐字自然朗读以下文本,只朗读冒号后的内容:\n${input.text || ''}`),
            },
          });
        }
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });

    ws.on('message', (data: WsData) => {
      try {
        const evt = wsDataToJson(data);
        raw.push(evt);
        const type = String(evt.type || '');
        if (type === 'response.raw_text.delta' && typeof evt.delta === 'string') text += evt.delta;
        if (type === 'response.audio_transcript.delta' && typeof evt.delta === 'string') text += evt.delta;
        if (type === 'response.audio_transcript.done' && typeof evt.transcript === 'string' && !text.trim()) text = evt.transcript;
        if (type === 'response.audio.delta' && typeof evt.delta === 'string') audioChunks.push(Buffer.from(evt.delta, 'base64'));
        if (type === 'error') throw new Error(String((evt.error as JsonObject | undefined)?.message || evt.message || 'StepFun Realtime error'));
        if (type === 'response.done') finish();
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });
    ws.on('error', (err: Error) => finish(err instanceof Error ? err : new Error(String(err))));
    ws.on('close', (code?: number, reason?: Buffer) => {
      if (!settled) {
        const suffix = code || reason?.length ? ` (code ${code ?? 0}${reason?.length ? `: ${reason.toString('utf-8')}` : ''})` : '';
        finish(new Error(`StepFun Realtime socket closed before response.done${suffix}`));
      }
    });
  });
}

export async function voiceAsr(body: JsonObject, signal?: AbortSignal): Promise<JsonObject> {
  void body;
  void signal;
  throw new Error('StepFun Realtime stateless returns assistant response transcripts, not standalone user ASR transcripts');
}

export async function voiceTts(body: JsonObject, signal?: AbortSignal): Promise<JsonObject> {
  const text = stringValue(body.text);
  if (!text) throw new Error('missing text');
  const result = await runRealtime(body, {
    mode: 'tts',
    text,
    signal,
  });
  if (!result.audio.length) throw new Error('StepFun Realtime returned no audio');
  return {
    ok: true,
    provider: 'stepfun-realtime',
    mime_type: 'audio/wav',
    audio_base64: pcm16ToWav(result.audio, 24_000).toString('base64'),
    raw: result.raw,
  };
}
