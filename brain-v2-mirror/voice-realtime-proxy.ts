// @ts-nocheck
// Brain v2 · StepFun Realtime full-duplex WS proxy (2026-06-11)
//
// Why this exists: StepFun Realtime is a SINGLE bidirectional conversation engine — you
// stream mic PCM up, its server-side VAD decides turn boundaries, it runs ASR+model+TTS
// internally and streams the assistant's PCM audio + transcripts back. It is NOT a
// standalone ASR (that's why voice-realtime.ts::voiceAsr throws). This proxy exposes that
// engine to clients WITHOUT shipping the StepFun key: client ↔ Brain WS ↔ StepFun WS.
//
// Protocol (Brain ↔ local-server/CLI bridge):
//   client → brain:
//     - binary frame            = raw little-endian PCM16 mic chunk (appended to input buffer)
//     - {type:'config', voice?, mode?:'duplex'|'ptt'}   set/update session
//     - {type:'commit'}         PTT: end-of-utterance → force a response
//     - {type:'interrupt'}      barge-in → cancel the in-flight assistant response
//     - {type:'text', text}     inject a text turn (e.g. typed message read aloud)
//   brain → client:
//     - binary frame            = raw PCM16 assistant audio chunk (24kHz mono) to play
//     - {type:'ready'} | {type:'speech_started'} | {type:'speech_stopped'}
//     - {type:'user_transcript', text, final}      what the user said
//     - {type:'assistant_transcript', text, done}  what the assistant is saying
//     - {type:'response_done'} | {type:'error', message}
import crypto from 'node:crypto';
// default WebSocket for the OPEN/CLOSED readyState constants; named WebSocketServer for the
// server (ws 8.x ESM only attaches it as a named export, NOT as WebSocket.Server — verified
// at runtime, that mismatch crashed the brain once).
import WebSocket, { WebSocketServer } from 'ws';

const STATEFUL_ENDPOINT = 'wss://api.stepfun.com/v1/realtime';
const DEFAULT_MODEL = 'stepaudio-2.5-realtime';
const DEFAULT_VOICE = 'jingdiannvsheng';
const SAMPLE_RATE = 24_000;

function stringValue(v) { return typeof v === 'string' ? v.trim() : ''; }

function env(...keys) {
  for (const k of keys) { const v = stringValue(process.env[k]); if (v) return v; }
  return '';
}

function resolveRealtimeKey() {
  return env(
    'LYNN_STEP_REALTIME_KEY', 'STEPFUN_REALTIME_API_KEY',
    'STEP37_KEY', 'STEPFUN_CODING_KEY', 'STEPFUN_CODING_API_KEY',
    'STEPFUN_API_KEY', 'STEP_KEY', 'STEP_API_KEY',
  );
}

function resolveRealtimeEndpoint() {
  const base = env('LYNN_STEP_REALTIME_ENDPOINT', 'STEPFUN_REALTIME_ENDPOINT');
  if (base) {
    let e = base.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:').replace(/\/+$/, '');
    if (!/\/v1\/realtime$/i.test(e)) e = /\/v1$/i.test(e) ? `${e}/realtime` : `${e}/v1/realtime`;
    return e;
  }
  return STATEFUL_ENDPOINT;
}

function eventId() { return `evt_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`; }

function wsDataToText(data) {
  if (Buffer.isBuffer(data)) return data.toString('utf-8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf-8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf-8');
  return Buffer.from(data).toString('utf-8');
}

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data.map(toBuffer));
  return Buffer.from(data);
}

// Build the session.update payload. duplex → server VAD auto-segments turns; ptt → no auto
// turn detection, the client drives turns with explicit commit.
function buildSessionConfig({ voice, mode }) {
  return {
    event_id: eventId(),
    type: 'session.update',
    session: {
      modalities: ['audio', 'text'],
      voice: voice || DEFAULT_VOICE,
      input_audio_format: 'pcm16',
      output_audio_format: 'pcm16',
      input_audio_transcription: { model: '' },
      turn_detection: mode === 'ptt' ? null : { type: 'server_vad' },
    },
  };
}

/**
 * Bridge one already-accepted client WebSocket to a fresh StepFun Realtime session.
 * Caller is responsible for auth (device signature) BEFORE calling this.
 *
 * @param clientWs  an open `ws` WebSocket to the client (local-server bridge / CLI)
 * @param opts      { voice?, mode?: 'duplex'|'ptt', log?, onClose? }
 * @returns         { close } — call to tear the session down
 */
export function bridgeRealtimeSession(clientWs, opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const apiKey = resolveRealtimeKey();
  let mode = opts.mode === 'ptt' ? 'ptt' : 'duplex';
  let voice = stringValue(opts.voice) || DEFAULT_VOICE;
  let closed = false;
  let upstream = null;

  const sendClientJson = (obj) => {
    if (closed || clientWs.readyState !== WebSocket.OPEN) return;
    try { clientWs.send(JSON.stringify(obj)); } catch { /* best-effort */ }
  };
  const sendClientAudio = (pcm) => {
    if (closed || clientWs.readyState !== WebSocket.OPEN || !pcm.length) return;
    try { clientWs.send(pcm, { binary: true }); } catch { /* best-effort */ }
  };
  const sendUpstream = (obj) => {
    if (!upstream || upstream.readyState !== WebSocket.OPEN) return;
    try { upstream.send(JSON.stringify(obj)); } catch { /* best-effort */ }
  };

  const teardown = (err) => {
    if (closed) return;
    closed = true;
    if (err) sendClientJson({ type: 'error', message: err.message || String(err) });
    try { upstream?.close(); } catch { /* best-effort */ }
    try { clientWs.close(); } catch { /* best-effort */ }
    if (typeof opts.onClose === 'function') { try { opts.onClose(err); } catch { /* ignore */ } }
  };

  if (!apiKey) { teardown(new Error('StepFun Realtime key not configured on brain')); return { close: teardown }; }

  // ── open the upstream StepFun session ──
  upstream = new WebSocket(`${resolveRealtimeEndpoint()}?model=${encodeURIComponent(env('LYNN_STEP_REALTIME_MODEL', 'STEPFUN_REALTIME_MODEL') || DEFAULT_MODEL)}`, {
    headers: { Authorization: `Bearer ${apiKey}`, 'X-Trace-Id': crypto.randomUUID() },
  });

  upstream.on('open', () => {
    sendUpstream(buildSessionConfig({ voice, mode }));
    sendClientJson({ type: 'ready', sampleRate: SAMPLE_RATE, mode });
    log('info', 'voice-realtime-proxy: upstream open mode=' + mode);
  });

  upstream.on('message', (data, isBinary) => {
    // StepFun sends JSON text events; audio arrives as base64 inside response.audio.delta.
    if (isBinary) { sendClientAudio(toBuffer(data)); return; }
    let evt;
    try { evt = JSON.parse(wsDataToText(data)); } catch { return; }
    const type = String(evt.type || '');
    switch (type) {
      case 'response.audio.delta':
        if (typeof evt.delta === 'string') sendClientAudio(Buffer.from(evt.delta, 'base64'));
        break;
      case 'response.audio_transcript.delta':
        if (typeof evt.delta === 'string') sendClientJson({ type: 'assistant_transcript', text: evt.delta, done: false });
        break;
      case 'response.audio_transcript.done':
        sendClientJson({ type: 'assistant_transcript', text: String(evt.transcript || ''), done: true });
        break;
      case 'conversation.item.input_audio_transcription.completed':
      case 'conversation.item.input_audio_transcription.done':
        sendClientJson({ type: 'user_transcript', text: String(evt.transcript || ''), final: true });
        break;
      case 'input_audio_buffer.speech_started':
        sendClientJson({ type: 'speech_started' });
        break;
      case 'input_audio_buffer.speech_stopped':
        sendClientJson({ type: 'speech_stopped' });
        break;
      case 'response.done':
        sendClientJson({ type: 'response_done' });
        break;
      case 'error':
        sendClientJson({ type: 'error', message: String(evt.error?.message || evt.message || 'StepFun Realtime error') });
        break;
      default:
        break;
    }
  });

  upstream.on('error', (err) => teardown(err instanceof Error ? err : new Error(String(err))));
  upstream.on('close', (code, reason) => {
    if (!closed) teardown(new Error(`StepFun Realtime closed (code ${code ?? 0}${reason?.length ? `: ${reason.toString('utf-8')}` : ''})`));
  });

  // ── client → upstream ──
  clientWs.on('message', (data, isBinary) => {
    if (closed) return;
    if (isBinary) {
      const pcm = toBuffer(data);
      if (pcm.length) sendUpstream({ event_id: eventId(), type: 'input_audio_buffer.append', audio: pcm.toString('base64') });
      return;
    }
    let msg;
    try { msg = JSON.parse(wsDataToText(data)); } catch { return; }
    const type = String(msg.type || '');
    switch (type) {
      case 'config':
        if (stringValue(msg.voice)) voice = stringValue(msg.voice);
        if (msg.mode === 'ptt' || msg.mode === 'duplex') mode = msg.mode;
        sendUpstream(buildSessionConfig({ voice, mode }));
        break;
      case 'commit': // PTT end-of-utterance
        sendUpstream({ event_id: eventId(), type: 'input_audio_buffer.commit' });
        sendUpstream({ event_id: eventId(), type: 'response.create', response: { modalities: ['audio', 'text'], voice } });
        break;
      case 'interrupt': // barge-in
        sendUpstream({ event_id: eventId(), type: 'response.cancel' });
        break;
      case 'text':
        if (stringValue(msg.text)) {
          sendUpstream({
            event_id: eventId(), type: 'conversation.item.create',
            item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: stringValue(msg.text) }] },
          });
          sendUpstream({ event_id: eventId(), type: 'response.create', response: { modalities: ['audio', 'text'], voice } });
        }
        break;
      default:
        break;
    }
  });

  clientWs.on('close', () => teardown());
  clientWs.on('error', (err) => teardown(err instanceof Error ? err : new Error(String(err))));

  return { close: teardown };
}

/**
 * Attach the realtime WS upgrade handler to a Node http.Server. Kept here (not in the typed
 * server.ts) because the project's `ws` typings don't expose WebSocket.Server cleanly.
 *
 * deps: { verifySignedRequest, log, host, port, AuthError }
 */
export function attachRealtimeUpgrade(server, deps = {}) {
  const { verifySignedRequest, log = () => {}, host = '127.0.0.1', port = 8790, AuthError } = deps;
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    let pathname = '/';
    try { pathname = new URL(req.url || '/', 'http://' + host + ':' + port).pathname; } catch { /* default */ }
    if (pathname !== '/v1/voice/realtime' && pathname !== '/v2/voice/realtime') { socket.destroy(); return; }
    void (async () => {
      try {
        if (verifySignedRequest) await verifySignedRequest(req, { pathname, method: 'GET', log });
      } catch (err) {
        const status = (AuthError && err instanceof AuthError) ? err.status : 401;
        try { socket.write('HTTP/1.1 ' + status + ' Unauthorized\r\nConnection: close\r\n\r\n'); } catch { /* best-effort */ }
        socket.destroy();
        log('warn', 'voice-realtime upgrade rejected: ' + ((err && err.message) || String(err)));
        return;
      }
      wss.handleUpgrade(req, socket, head, (clientWs) => {
        let voice = '';
        let mode = 'duplex';
        try {
          const u = new URL(req.url || '/', 'http://' + host + ':' + port);
          voice = u.searchParams.get('voice') || '';
          if (u.searchParams.get('mode') === 'ptt') mode = 'ptt';
        } catch { /* defaults */ }
        log('info', 'voice-realtime session start mode=' + mode);
        bridgeRealtimeSession(clientWs, { voice, mode, log });
      });
    })();
  });
  return wss;
}
