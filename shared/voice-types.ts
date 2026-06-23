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
  SPEAK_TEXT_APPEND: 0x33,
} as const;

export const STATE = {
  IDLE: "idle",
  LISTENING: "listening",
  THINKING: "thinking",
  SPEAKING: "speaking",
  DEGRADED: "degraded",
} as const;

export type VoiceState = typeof STATE[keyof typeof STATE];
export type FrameCode = typeof FRAME[keyof typeof FRAME];

export interface VoiceProviderHealth {
  ok?: boolean;
  fallbackOk?: boolean;
  degraded?: boolean;
  error?: string;
  [key: string]: unknown;
}

export interface VoiceProviderHealthSnapshot {
  asr?: VoiceProviderHealth;
  ser?: VoiceProviderHealth;
  tts?: VoiceProviderHealth;
}

export type VoiceTier = 1 | 2 | 3 | 4 | 5 | 6;
export type VoiceOrbColor = "green" | "yellow" | "red";

export interface VoiceTierInfo {
  tier: VoiceTier;
  orbColor: VoiceOrbColor;
  label: string;
  details: VoiceProviderHealthSnapshot;
}

export interface VoiceHealthPayload {
  providers?: VoiceProviderHealthSnapshot;
  [key: string]: unknown;
}
