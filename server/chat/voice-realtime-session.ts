// @ts-nocheck
// Lynn local-server · Realtime voice session (2026-06-11)
//
// A drop-in alternative to VoiceSession for the StepFun-Realtime full-duplex path. It speaks
// the SAME /voice-ws binary protocol to the GUI/CLI, but instead of the ASR→model→TTS pipeline
// it bridges the client straight to the Brain-hosted StepFun Realtime session
// (wss://…/api/v2/v1/voice/realtime, device-signed, key stays on Brain):
//
//   GUI/CLI  ──/voice-ws──▶  this session  ──signed WS──▶  Brain  ──▶  StepFun Realtime
//     PCM_AUDIO 0x01  ───────────────────────────────────────▶ input_audio_buffer (binary)
//     PCM_TTS   0x02  ◀───────── assistant audio (binary) ◀────────────────────────────
//     TRANSCRIPT/STATE/ASSISTANT_REPLY ◀── transcripts + VAD/turn events (JSON) ◀───────
//
// server VAD ⇒ full-duplex (no key press); PTT ⇒ END_OF_TURN drives an explicit commit.
import WebSocket from 'ws';
import { makeFrame, makeStateFrame, makeTranscriptFrame, PCM_TTS_CHUNK_BYTES } from './voice-audio-codec.js';
import { FRAME, STATE } from './voice-ws-types.js';
import { readSignedClientAgentHeaders } from '../../shared/client-agent-identity.js';
import { BRAIN_API_ROOTS } from '../../shared/brain-provider.js';

const REALTIME_PATHNAME = '/v1/voice/realtime';

function toWsUrl(apiRoot, { voice, mode }) {
  const base = String(apiRoot || '').replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:').replace(/\/+$/, '');
  const qs = [];
  if (mode === 'ptt') qs.push('mode=ptt');
  if (voice) qs.push('voice=' + encodeURIComponent(voice));
  return `${base}${REALTIME_PATHNAME}${qs.length ? '?' + qs.join('&') : ''}`;
}

export class RealtimeVoiceSession {
  constructor(clientWs, deps = {}) {
    this.client = clientWs;
    this.deps = deps;
    this.mode = deps.mode === 'ptt' ? 'ptt' : 'duplex';
    this.voice = (deps.voice || deps.ttsVoice || '').toString();
    this.seq = 0;
    this.upstream = null;
    this.closed = false;
    this.audioBuf = Buffer.alloc(0);
    this.log = typeof deps.log === 'function' ? deps.log : () => {};
  }

  // ── frame senders to the GUI/CLI ──
  _send(buf) {
    if (this.closed || !this.client || this.client.readyState !== 1 /* OPEN */) return;
    try { this.client.send(buf, { binary: true }); } catch { /* best-effort */ }
  }
  _state(state) { this._send(makeStateFrame(this.seq++, state)); }
  _transcript(type, text) { if (text) this._send(makeTranscriptFrame(type, this.seq++, text)); }
  _assistantReply(text) { if (text) this._send(makeFrame(FRAME.ASSISTANT_REPLY, 0, this.seq++, Buffer.from(String(text), 'utf-8'))); }

  // Emit assistant PCM to the client in ~100ms (PCM_TTS_CHUNK_BYTES) chunks.
  _emitAudio(pcm) {
    if (!pcm || !pcm.length) return;
    this.audioBuf = this.audioBuf.length ? Buffer.concat([this.audioBuf, pcm]) : pcm;
    while (this.audioBuf.length >= PCM_TTS_CHUNK_BYTES) {
      const chunk = this.audioBuf.subarray(0, PCM_TTS_CHUNK_BYTES);
      this.audioBuf = this.audioBuf.subarray(PCM_TTS_CHUNK_BYTES);
      this._send(makeFrame(FRAME.PCM_TTS, 0, this.seq++, chunk));
    }
  }
  _flushAudio() {
    if (this.audioBuf.length) { this._send(makeFrame(FRAME.PCM_TTS, 0, this.seq++, this.audioBuf)); this.audioBuf = Buffer.alloc(0); }
  }

  _sendUpstream(obj) {
    if (this.closed || !this.upstream || this.upstream.readyState !== WebSocket.OPEN) return;
    try { this.upstream.send(JSON.stringify(obj)); } catch { /* best-effort */ }
  }
  _sendUpstreamAudio(pcm) {
    if (this.closed || !this.upstream || this.upstream.readyState !== WebSocket.OPEN || !pcm?.length) return;
    try { this.upstream.send(pcm, { binary: true }); } catch { /* best-effort */ }
  }

  // ── VoiceSession-compatible lifecycle (called by the /voice-ws route) ──
  onOpen() {
    let url;
    try { url = toWsUrl((BRAIN_API_ROOTS && BRAIN_API_ROOTS[0]) || '', { voice: this.voice, mode: this.mode }); }
    catch { this._degraded('brain url'); return; }
    let headers = {};
    try { headers = readSignedClientAgentHeaders({ method: 'GET', pathname: REALTIME_PATHNAME }) || {}; }
    catch { /* unsigned — brain strict will reject and we degrade */ }

    this.upstream = new WebSocket(url, { headers });
    this.upstream.on('open', () => { this.log('info', 'realtime-voice: brain session open mode=' + this.mode); this._state(STATE.LISTENING); });
    this.upstream.on('message', (data, isBinary) => this._onUpstream(data, isBinary));
    this.upstream.on('error', (err) => this._degraded((err && err.message) || 'upstream error'));
    this.upstream.on('close', () => { if (!this.closed) this._degraded('brain session closed'); });
  }

  _onUpstream(data, isBinary) {
    if (this.closed) return;
    if (isBinary) { this._emitAudio(Buffer.isBuffer(data) ? data : Buffer.from(data)); return; }
    let evt;
    try { evt = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf-8') : String(data)); } catch { return; }
    switch (String(evt.type || '')) {
      case 'ready': break;
      case 'speech_started': this._state(STATE.LISTENING); break;
      case 'speech_stopped': this._state(STATE.THINKING); break;
      // IMPORTANT: forward the user's words as a PARTIAL (display-only) transcript, NOT FINAL.
      // In the GUI, a TRANSCRIPT_FINAL frame drives onTranscriptFinal → sendPrompt() → a SECOND
      // turn through the chat model, whose reply is then TTS'd back through StepFun — a double
      // response that collides with StepFun's own audio. In realtime mode StepFun IS the engine
      // (ASR+model+TTS), so the transcript is purely for showing what was heard.
      case 'user_transcript': this._transcript(FRAME.TRANSCRIPT_PARTIAL, String(evt.text || '')); break;
      case 'assistant_transcript':
        this._state(STATE.SPEAKING);
        // Use the streaming deltas; the final `done` carries the full text — forward both, the
        // GUI replaces on `done`. We forward as ASSISTANT_REPLY (text) for the bubble.
        if (evt.done) this._assistantReply(String(evt.text || ''));
        else this._transcript(FRAME.TRANSCRIPT_PARTIAL, String(evt.text || ''));
        break;
      case 'response_done':
        this._flushAudio();
        this._state(this.mode === 'ptt' ? STATE.IDLE : STATE.LISTENING);
        break;
      case 'error': this._degraded(String(evt.message || 'realtime error')); break;
      default: break;
    }
  }

  _degraded(reason) {
    this.log('warn', 'realtime-voice degraded: ' + reason);
    try { this._state(STATE.DEGRADED); } catch { /* ignore */ }
    // Note: the /voice-ws route's fallback orchestration (DGX) should take over when the GUI
    // sees DEGRADED; we do not auto-switch providers here (single-responsibility).
  }

  onAudio(frame) {
    // frame.payload = raw PCM16 mic chunk (24kHz mono) → straight up to StepFun.
    const pcm = frame?.payload;
    if (pcm && pcm.length) this._sendUpstreamAudio(Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm));
  }

  onPing(frame) {
    // mirror the seq back as PONG so the client RTT meter works
    const seq = frame?.seq ?? 0;
    this._send(makeFrame(FRAME.PONG, 0, seq));
  }

  onInterrupt() { this._sendUpstream({ type: 'interrupt' }); this._flushAudio(); }

  endOfTurn() { if (this.mode === 'ptt') this._sendUpstream({ type: 'commit' }); }

  // A degraded-ASR transcript arriving from the client is not used in realtime mode (StepFun
  // does its own ASR); inject it as a user text turn so the conversation still advances.
  processTextTurn(text) { const t = String(text || '').trim(); if (t) this._sendUpstream({ type: 'text', text: t }); }

  // "read this chat reply aloud" — send the text to StepFun realtime to synthesize.
  processSpeakTextTurn(text) { const t = String(text || '').trim(); if (t) { this._state(STATE.SPEAKING); this._sendUpstream({ type: 'text', text: t }); } }
  appendSpeakText(text) { const t = String(text || '').trim(); if (t) this._sendUpstream({ type: 'text', text: t }); }

  onClose() {
    this.closed = true;
    try { this.upstream?.close(); } catch { /* best-effort */ }
    this.upstream = null;
  }
}
