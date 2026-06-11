/**
 * voice-ws.js — Lynn V0.79 Jarvis Runtime WebSocket
 *
 * Voice WS hub:client ↔ server ↔ ASR/Brain/TTS 双向 PCM 管道。
 *
 * 协议(每帧 4 字节 header + payload):
 *   [type:u8] [flags:u8] [seq:u16 BE] [payload:variable]
 *
 * Types:
 *   0x01 PCM_AUDIO           client → server  mic PCM 24kHz Int16,100ms/chunk
 *   0x02 PCM_TTS             server → client  TTS PCM 24kHz Int16 mono
 *   0x10 PING                client → server  RTT 测量
 *   0x11 PONG                server → client  RTT 回包
 *   0x12 TRANSCRIPT_PARTIAL  server → client  ASR 增量(Phase 2B+)
 *   0x13 TRANSCRIPT_FINAL    server → client  ASR 最终文本
 *   0x14 EMOTION             server → client  emotion2vec+ JSON
 *   0x15 STATE_CHANGE        server → client  idle/listening/thinking/speaking/degraded
 *   0x16 HEALTH_STATUS       server → client  provider health/fallback JSON
 *   0x17 ASSISTANT_REPLY     server → client  Lynn 文字回复
 *   0x20 INTERRUPT           client → server  用户开口/打断
 *   0x30 END_OF_TURN         client → server  一轮结束
 *   0x31 TEXT_TURN           client → server  降级 ASR 已得出的转写文本
 *   0x32 SPEAK_TEXT          client → server  播放已有聊天回复文本
 *
 * Phase 2A:PCM → Brain-hosted StepFun Realtime ASR/TTS → PCM_TTS 最小闭环。
 * Phase 2B:server-side energy VAD fallback for auto end-of-turn.
 * Phase 2D:Silero/TEN VAD interrupt arbitration / AEC reference signal coordination.
 */
import { Hono } from "hono";
import { debugLog } from "../../lib/debug-log.js";
import {
  bufferInt16LEToFloat32,
  decodePcm16Audio,
  extractPcm16FromWav,
  float32ToInt16LEBuffer,
  makeFrame,
  PCM_SAMPLE_RATE,
  PCM_TTS_CHUNK_BYTES,
  normalizeTtsAudioToPcm16Mono16k,
  parseFrame,
  pcm16Rms,
  pcm16ToWav,
} from "../chat/voice-audio-codec.js";
import { AEC_SAMPLES_PER_FRAME, TtsReferenceQueue, aecProcessFrame100ms } from "../chat/voice-aec.js";
import { VoiceSession } from "../chat/voice-session.js";
import { RealtimeVoiceSession } from "../chat/voice-realtime-session.js";
import {
  asRecord,
  cleanTextForTts,
  extractEmotionSegment,
  isSemanticTranscript,
  normalizeVoiceTranscript,
  resolveVoiceRuntimeAsrConfig,
  resolveVoiceRuntimeTtsConfig,
  splitTextForTts,
} from "../chat/voice-session-utils.js";
import { FRAME, STATE } from "../chat/voice-ws-types.js";
import type {
  CreateVoiceWsRouteDeps,
  VoiceEngine,
  VoiceErrorEvent,
  VoiceMessageEvent,
  VoiceRouteContext,
  VoiceSocket,
} from "../chat/voice-ws-types.js";

export { FRAME, STATE };
export {
  bufferInt16LEToFloat32,
  decodePcm16Audio,
  extractPcm16FromWav,
  float32ToInt16LEBuffer,
  makeFrame,
  PCM_SAMPLE_RATE,
  PCM_TTS_CHUNK_BYTES,
  normalizeTtsAudioToPcm16Mono16k,
  parseFrame,
  pcm16Rms,
  pcm16ToWav,
};

export { AEC_SAMPLES_PER_FRAME, TtsReferenceQueue, aecProcessFrame100ms };
export {
  cleanTextForTts,
  extractEmotionSegment,
  isSemanticTranscript,
  normalizeVoiceTranscript,
  resolveVoiceRuntimeAsrConfig,
  resolveVoiceRuntimeTtsConfig,
  splitTextForTts,
};
/**
 * 创建 Voice WS 路由
 *
 * @param {object} engine - Lynn engine 实例
 * @param {object} hub - WebSocket hub
 * @param {object} ctx - { upgradeWebSocket, asrProvider?, serProvider?, ttsProvider?, brainRunner? }
 * @returns {{wsRoute: Hono}}
 */
export function createVoiceWsRoute(engine: VoiceEngine, hub: unknown, { upgradeWebSocket, ...deps }: CreateVoiceWsRouteDeps) {
  const wsRoute = new Hono();

  const voiceHandler = upgradeWebSocket((_c: VoiceRouteContext) => {
    let session: VoiceSession | null = null;
    const mode = _c?.req?.query?.("mode") || deps.mode || "direct";

    return {
      onOpen(_event: unknown, ws: VoiceSocket) {
        // mode=realtime → StepFun Realtime full-duplex via Brain (primary); otherwise the
        // ASR→model→TTS VoiceSession (DGX/local fallback). Same /voice-ws binary protocol.
        session = mode === "realtime"
          ? (new RealtimeVoiceSession(ws, { ...deps, engine, hub, mode }) as unknown as VoiceSession)
          : new VoiceSession(ws, { ...deps, engine, hub, mode });
        session.onOpen();
        debugLog()?.log("voice-ws", "client connected");
      },

      onMessage(event: VoiceMessageEvent, _ws: VoiceSocket) {
        if (!session) return;

        // 二进制帧
        if (event.data instanceof ArrayBuffer || Buffer.isBuffer(event.data)) {
          const frame = parseFrame(event.data);
          if (!frame) return;

          switch (frame.type) {
            case FRAME.PCM_AUDIO:
              session.onAudio(frame);
              break;
            case FRAME.PING:
              session.onPing(frame);
              break;
            case FRAME.INTERRUPT:
              session.onInterrupt();
              break;
            case FRAME.END_OF_TURN:
              session.endOfTurn();
              break;
            case FRAME.TEXT_TURN:
              session.processTextTurn(frame.payload.toString("utf-8"));
              break;
            case FRAME.SPEAK_TEXT:
              session.processSpeakTextTurn(frame.payload.toString("utf-8"));
              break;
            case FRAME.SPEAK_TEXT_APPEND:
              session.appendSpeakText(frame.payload.toString("utf-8"));
              break;
            default:
              debugLog()?.log("voice-ws", `unknown frame type: 0x${frame.type.toString(16)}`);
          }
          return;
        }

        // 文本帧(future:用于 client → server 控制消息)
        debugLog()?.log("voice-ws", `text frame: ${String(event.data).slice(0, 100)}`);
      },

      onClose() {
        if (session) {
          session.onClose();
          session = null;
        }
      },

      onError(event: VoiceErrorEvent | unknown) {
        debugLog()?.log("voice-ws", `error: ${asRecord(event)?.message || event}`);
      },
    };
  }) as never;

  wsRoute.get("/voice-ws", voiceHandler);

  return { wsRoute };
}
