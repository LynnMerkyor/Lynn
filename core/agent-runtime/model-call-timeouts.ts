import fs from "node:fs";
import path from "node:path";
import { resolveLynnHome } from "../../shared/client-agent-identity.js";
import { isBrainProvider } from "../../shared/brain-provider.js";
import { MAX_MODEL_TIMEOUT_MS, normalizeModelCallTimeouts, type ModelCallTimeouts } from "../../shared/model-call-timeouts.js";

export function readModelCallTimeoutPreferences(): unknown {
  try {
    const prefs = JSON.parse(fs.readFileSync(path.join(resolveLynnHome(), "user", "preferences.json"), "utf8"));
    return prefs.model_call_timeouts;
  } catch {
    return undefined;
  }
}

export function readModelCallTimeouts(): ModelCallTimeouts {
  return normalizeModelCallTimeouts(readModelCallTimeoutPreferences());
}

export function resolveModelCallTimeouts(preferences: unknown, provider?: string): ModelCallTimeouts {
  return describeModelCallTimeouts(preferences, provider).effective;
}

export function describeModelCallTimeouts(preferences: unknown, provider?: string) {
  const result = normalizeModelCallTimeouts(preferences);
  const sources = Object.fromEntries(Object.keys(result).map(key => [key,
    preferences && typeof preferences === "object" && (preferences as Record<string, unknown>)[key] === result[key as keyof ModelCallTimeouts]
      ? "preferences.model_call_timeouts" : "default",
  ])) as Record<keyof ModelCallTimeouts, string>;
  const apply = (key: keyof ModelCallTimeouts, name: string) => {
    const raw = process.env[name];
    if (raw == null || raw.trim() === "") return;
    const value = Number(raw);
    if (Number.isInteger(value) && value >= (key === "totalMs" ? 0 : 1) && value <= MAX_MODEL_TIMEOUT_MS) {
      result[key] = value;
      sources[key] = name;
    }
  };
  apply("firstChunkMs", "LYNN_MODEL_FIRST_CHUNK_TIMEOUT_MS");
  apply("idleMs", "LYNN_MODEL_IDLE_TIMEOUT_MS");
  apply("totalMs", "LYNN_MODEL_CALL_TIMEOUT_MS");
  apply("totalMs", "LYNN_MODEL_TOTAL_TIMEOUT_MS");
  if (isBrainProvider(provider)) apply("totalMs", "LYNN_BRAIN_MODEL_CALL_TIMEOUT_MS");
  return { effective: result, sources };
}

export function cliBrainHeaderTimeout(hasFallbackProvider: boolean) {
  const value = Number(process.env.LYNN_CLI_BRAIN_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0
    ? { timeoutMs: Math.max(250, Math.min(30_000, value)), source: "LYNN_CLI_BRAIN_TIMEOUT_MS" }
    : { timeoutMs: hasFallbackProvider ? 1200 : 5000, source: "default" };
}

export function modelTimeoutDiagnostics(preferences: unknown) {
  const fallbackValue = Number(process.env.LYNN_FALLBACK_MODEL_CALL_TIMEOUT_MS);
  const describeOuter = (name: string, fallback: number) => {
    const raw = process.env[name];
    return { timeoutMs: Number(raw || fallback), source: raw ? name : "default" };
  };
  return {
    model: describeModelCallTimeouts(preferences),
    brain: describeModelCallTimeouts(preferences, "brain"),
    localQwen: describeModelCallTimeouts(preferences),
    fallbackFinalization: Number.isFinite(fallbackValue) && fallbackValue > 0
      ? { timeoutMs: Math.floor(fallbackValue), source: "LYNN_FALLBACK_MODEL_CALL_TIMEOUT_MS" }
      : { timeoutMs: 30_000, source: "default" },
    cliBrainHeaders: { withFallback: cliBrainHeaderTimeout(true), withoutFallback: cliBrainHeaderTimeout(false) },
    turn: describeOuter("LYNN_TURN_HARD_ABORT_MS", 0),
    longResearchTurn: describeOuter("LYNN_TURN_LONG_RESEARCH_HARD_ABORT_MS", 240_000),
    scope: "Current process only; CLI and GUI can inherit different environment variables. Remote Brain / proxy / provider limits are not observable here. longResearchTurn applies only when turn is enabled.",
  };
}
