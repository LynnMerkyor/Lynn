import crypto from 'node:crypto';
import WebSocket from 'ws';

type JsonObject = Record<string, unknown>;
type WsData = Buffer | ArrayBuffer | Buffer[] | Uint8Array;

const DEFAULT_ENDPOINT = 'wss://api.stepfun.com/step_plan/v1/realtime';
const DEFAULT_MODEL = 'stepaudio-2.5-realtime';
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
  endpoint = endpoint.replace(/\/chat\/completions$/i, '');
  if (!/\/v1\/realtime(?:\/stateless)?$/i.test(endpoint)) {
    endpoint = /\/v1$/i.test(endpoint) ? `${endpoint}/realtime` : `${endpoint}/v1/realtime`;
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

function decodeAudioPayload(body: JsonObject): Buffer {
  const raw = stringValue(body.audio_base64)
    || stringValue(body.audioBase64)
    || stringValue(body.audio);
  if (!raw) return Buffer.alloc(0);
  try {
    return Buffer.from(raw, 'base64');
  } catch {
    return Buffer.alloc(0);
  }
}

function extractPcm16FromWav(audio: Buffer): Buffer {
  if (audio.length < 12 || audio.subarray(0, 4).toString('ascii') !== 'RIFF' || audio.subarray(8, 12).toString('ascii') !== 'WAVE') {
    return audio;
  }
  let offset = 12;
  while (offset + 8 <= audio.length) {
    const chunkId = audio.subarray(offset, offset + 4).toString('ascii');
    const chunkSize = audio.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = Math.min(dataStart + chunkSize, audio.length);
    if (chunkId === 'data') return Buffer.from(audio.subarray(dataStart, dataEnd));
    offset = dataStart + chunkSize + (chunkSize % 2);
  }
  return audio;
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
          const history = userTextHistory(`请逐字自然朗读以下文本,只朗读冒号后的内容:\n${input.text || ''}`);
          const stateless = /\/realtime\/stateless$/i.test(config.endpoint);
          if (!stateless) {
            await sendJson(ws, {
              event_id: eventId(), type: 'session.update',
              session: { modalities: ['audio', 'text'], voice: config.voice, input_audio_format: 'pcm16', output_audio_format: 'pcm16', turn_detection: null },
            });
            await sendJson(ws, { event_id: eventId(), type: 'conversation.item.create', item: history[0] });
          }
          await sendJson(ws, {
            event_id: eventId(),
            type: 'response.create',
            response: {
              modalities: ['audio', 'text'],
              instructions: '你是一个纯文本朗读器。你的唯一任务是把用户要求朗读的文本原样读出来。不要回答、解释、改写、翻译、补充或加入闲聊。',
              ...(stateless ? { voice: config.voice, history } : {}),
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
  const config = resolveConfig(body);
  if (!config.apiKey) throw new Error('StepFun ASR API key is not configured');
  const encoded = stringValue(body.audio_pcm_base64) || stringValue(body.audioPcmBase64);
  const audio = encoded ? Buffer.from(encoded, 'base64') : decodeAudioPayload(body);
  if (!audio.length) throw new Error('missing audio');
  const isWav = audio.length >= 44 && audio.subarray(0, 4).toString() === 'RIFF' && audio.subarray(8, 12).toString() === 'WAVE';
  if (isWav && (audio.readUInt16LE(20) !== 1 || audio.readUInt16LE(22) !== 1 || audio.readUInt16LE(34) !== 16)) throw new Error('StepFun ASR requires mono PCM16 audio');
  const mimeRate = stringValue(body.mime_type).match(/rate=(\d+)/i)?.[1];
  const rate = isWav ? audio.readUInt32LE(24) : Number(body.sample_rate ?? body.sampleRate ?? mimeRate ?? 24000);
  if (!Number.isInteger(rate) || rate < 8000 || rate > 48000) throw new Error('invalid audio sample rate');
  const pcm = isWav ? extractPcm16FromWav(audio) : audio;
  if (!pcm.length || pcm.length % 2) throw new Error('invalid PCM16 audio');
  const endpoint = env('LYNN_STEP_ASR_ENDPOINT') || config.endpoint
    .replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:')
    .replace(/\/realtime(?:\/stateless)?$/i, '/audio/asr/sse');
  const language = stringValue(body.language);
  const abortSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]) : AbortSignal.timeout(config.timeoutMs);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ audio: { data: pcm.toString('base64'), input: {
      transcription: { model: env('LYNN_STEP_ASR_MODEL') || 'stepaudio-2.5-asr', ...(language && language !== 'auto' ? { language } : {}), enable_itn: true },
      format: { type: 'pcm', codec: 'pcm_s16le', rate, bits: 16, channel: 1 },
    } } }),
    signal: abortSignal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`StepFun ASR HTTP ${response.status}`);
  }
  if (!response.body) throw new Error('StepFun ASR returned no stream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let completed = false;
  const consume = (frame: string) => {
    const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    const event = JSON.parse(data) as JsonObject;
    if (event.type === 'error' || event.error) throw new Error('StepFun ASR returned an error event');
    if (event.type === 'transcript.text.delta' && typeof event.delta === 'string') text += event.delta;
    if (event.type === 'transcript.text.done') {
      if (typeof event.text === 'string') text = event.text;
      completed = true;
    }
  };
  try {
    while (!completed) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1 && !completed) {
        consume(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
      }
      if (chunk.done) {
        if (!completed && buffer.trim()) consume(buffer);
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (!completed || !text.trim()) throw new Error('StepFun ASR returned no completed user transcript');
  return { ok: true, provider: 'stepfun-asr', text: text.trim(), language: language || 'auto' };
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
