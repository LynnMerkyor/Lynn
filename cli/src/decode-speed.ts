import { formatTps } from "./usage-telemetry.js";

export interface DecodeSpeedTracker {
  add(delta: string, nowMs?: number): string | null;
}

export function createDecodeSpeedTracker(startedAtMs = Date.now()): DecodeSpeedTracker {
  let firstTokenAt: number | null = null;
  let estimatedTokens = 0;

  return {
    add(delta: string, nowMs = Date.now()): string | null {
      const tokens = estimateDecodeTokens(delta);
      if (tokens <= 0) return null;
      if (firstTokenAt === null) firstTokenAt = Math.max(startedAtMs, nowMs);
      estimatedTokens += tokens;
      const elapsedSeconds = Math.max(0.25, (nowMs - firstTokenAt) / 1000);
      return `${formatTps(estimatedTokens / elapsedSeconds)} TPS`;
    },
  };
}

export function estimateDecodeTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let nonCjkChars = 0;
  for (const char of Array.from(text)) {
    if (/\s/u.test(char)) continue;
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char)) cjk += 1;
    else nonCjkChars += 1;
  }
  return cjk + Math.ceil(nonCjkChars / 4);
}
