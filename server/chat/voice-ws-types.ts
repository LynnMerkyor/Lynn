export const FRAME = {
  PCM_AUDIO: 0x01,
  PCM_TTS: 0x02,
  PING: 0x10,
  PONG: 0x11,
  TRANSCRIPT_PARTIAL: 0x12,
  TRANSCRIPT_FINAL: 0x13,
  EMOTION: 0x14,
  STATE_CHANGE: 0x15,
  HEALTH_STATUS: 0x16,
  ASSISTANT_REPLY: 0x17,
  INTERRUPT: 0x20,
  END_OF_TURN: 0x30,
  TEXT_TURN: 0x31,
  SPEAK_TEXT: 0x32,
  // 2026-05-01 P0-① 增量 TTS:LLM token streaming → incremental sentence splitter →
  // 已 SPEAKING 时直接 append 新 segments,不创建新 turn,首音节延迟从 ~3s 砍到 ~0.9s。
  SPEAK_TEXT_APPEND: 0x33,
} as const;

export const STATE = {
  IDLE: "idle",
  LISTENING: "listening",
  THINKING: "thinking",
  SPEAKING: "speaking",
  DEGRADED: "degraded",
} as const;

export type JsonRecord = Record<string, unknown>;
export type VoiceState = typeof STATE[keyof typeof STATE];
export type FrameCode = typeof FRAME[keyof typeof FRAME];
export type BinaryInput = Buffer | ArrayBuffer | Uint8Array | null | undefined;

export interface VoiceFrame {
  type: number;
  flags: number;
  seq: number;
  payload: Buffer;
}

export interface DecodedPcmAudio {
  pcm: Buffer;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}

export interface VadConfig {
  enabled: boolean;
  speechRms: number;
  silenceRms: number;
  minSpeechFrames: number;
  endSilenceFrames: number;
}

export interface ProviderHealth {
  name: string;
  ok: boolean;
  fallbackOk: boolean;
  degraded: boolean;
  error?: string;
}

export interface HealthProvider {
  name?: string;
  health?: () => unknown | Promise<unknown>;
}

export interface AsrResult {
  text?: unknown;
  fallbackUsed?: boolean;
  primaryError?: unknown;
}

export interface AsrProvider extends HealthProvider {
  transcribe(audio: Buffer, opts?: JsonRecord): AsrResult | Promise<AsrResult>;
}

export interface EmotionResult extends JsonRecord {
  tag?: string;
}

export interface SerProvider extends HealthProvider {
  warmup?: () => unknown | Promise<unknown>;
  classify?: (audio: Buffer, opts?: JsonRecord) => unknown | Promise<unknown>;
}

export interface TtsPiece extends JsonRecord {
  audio?: BinaryInput;
  audioBuffer?: BinaryInput;
  buffer?: BinaryInput;
  path?: string;
  fallbackUsed?: boolean;
  primaryError?: unknown;
}

export interface TtsProvider extends HealthProvider {
  synthesize(segment: string, opts?: JsonRecord): TtsPiece | Promise<TtsPiece>;
  synthesizeStream?: (segment: string, opts: JsonRecord) => AsyncIterable<TtsPiece>;
}

export interface VoiceEngine {
  config?: {
    voice?: {
      asr?: JsonRecord;
      ser?: JsonRecord;
      tts?: JsonRecord;
      realtime?: JsonRecord;
      router?: JsonRecord;
      browserAec?: unknown;
    };
  };
  executeIsolated?: (prompt: string, opts: { signal?: AbortSignal }) => Promise<{ error?: unknown; replyText?: unknown } | null | undefined>;
  voiceReply?: (transcript: string, opts: { signal?: AbortSignal }) => Promise<unknown>;
}

export interface VoiceSocket {
  readyState: number;
  send(data: Buffer): unknown;
}

export type BrainRunner = (input: {
  transcript: string;
  emotion?: EmotionResult | null;
  engine: VoiceEngine;
  hub: unknown;
  signal?: AbortSignal;
}) => Promise<unknown>;

export type SaveInterruptedTurn = (input: JsonRecord) => Promise<unknown> | unknown;
export type AecProcessorHandle = object | null | undefined;
export type AecRender = (handle: AecProcessorHandle, samples: Float32Array) => unknown;
export type AecCapture = (handle: AecProcessorHandle, samples: Float32Array) => Float32Array;

export interface AecDeps {
  createProcessor?: (opts: JsonRecord) => AecProcessorHandle | null;
  processRender?: AecRender;
  processCapture?: AecCapture;
}

export interface VoiceSessionDeps {
  engine: VoiceEngine;
  hub: unknown;
  asrProvider?: AsrProvider | null;
  serProvider?: SerProvider | null;
  ttsProvider?: TtsProvider | null;
  brainRunner?: BrainRunner | null;
  healthOnOpen?: boolean;
  vadConfig?: Partial<VadConfig>;
  mode?: string;
  saveInterruptedTurn?: SaveInterruptedTurn | null;
  aec?: AecDeps | null;
}

export interface CurrentReplyPlayed {
  fullText: string;
  segments: string[];
  playedSegments: string[];
  startedAt: number;
}

export interface PendingInterruptedReply {
  text: string;
  segmentsPlayed: number;
  totalSegments: number;
  startedAt: number;
  interruptedAt: number;
}

export interface ErleRecord {
  dir: string;
  sessionId: string;
  micChunks: Buffer[];
  ttsChunks: Buffer[];
  startTs: number;
}

export interface CreateVoiceWsRouteDeps extends VoiceSessionDeps {
  upgradeWebSocket: (factory: (c: VoiceRouteContext) => JsonRecord) => unknown;
}

export interface VoiceRouteContext {
  req?: {
    query?: (name: string) => string | undefined;
  };
}

export interface VoiceMessageEvent {
  data: ArrayBuffer | Buffer | string;
}

export interface VoiceErrorEvent {
  message?: string;
}

export interface TtsStreamError extends Error {
  yieldedAny?: boolean;
}
