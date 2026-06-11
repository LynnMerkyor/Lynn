import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(path.resolve("desktop/src/react/settings/tabs/VoiceTab.tsx"), "utf8");

describe("Voice settings StepFun Realtime contract", () => {
  it("keeps StepFun Realtime TTS on Lynn cloud key instead of asking the user for BYOK", () => {
    expect(source).toContain("Lynn 云端");
    expect(source).toContain("无需 Key");
    const needsAsrKeyLine = source.split("\n").find((line) => line.includes("needsAsrKey")) || "";
    const needsTtsKeyLine = source.split("\n").find((line) => line.includes("needsTtsKey")) || "";
    expect(needsAsrKeyLine).not.toContain("stepfun");
    expect(needsTtsKeyLine).not.toContain("stepfun");
  });

  it("does not expose StepFun Realtime as standalone ASR", () => {
    expect(source).toContain("{ value: 'spark', label: '语音输入转写 (本地 ASR · 默认)' }");
    expect(source).toContain("StepFun Realtime 不再作为独立 ASR 使用");
    expect(source).toContain("LEGACY_ASR_FALLBACKS.has(value)) return 'spark'");
  });

  it("migrates legacy Spark-era TTS engines back to the StepFun primary chain", () => {
    expect(source).toContain("const LEGACY_TTS_FALLBACKS = new Set(['spark', 'cosyvoice', 'edge', 'say'])");
    expect(source).toContain("LEGACY_TTS_FALLBACKS.has(value)) return 'stepfun-realtime'");
  });

  it("does not expose local TTS fallback engines as primary provider choices", () => {
    const asrBlock = source.match(/const ASR_PROVIDERS = \[[\s\S]*?\];/)?.[0] || "";
    const ttsBlock = source.match(/const TTS_PROVIDERS = \[[\s\S]*?\];/)?.[0] || "";
    expect(asrBlock).not.toContain("StepFun Realtime ASR");
    expect(ttsBlock).not.toContain("CosyVoice");
    expect(ttsBlock).not.toContain("Spark local");
  });
});
