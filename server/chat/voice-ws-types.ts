export { FRAME, STATE } from "../../shared/voice-types.js";
export type { FrameCode, VoiceState } from "../../shared/voice-types.js";

export type JsonRecord = Record<string, unknown>;
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
