export interface UsageTelemetry {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  cacheHitTokens: number | null;
  cacheMissTokens: number | null;
  cacheWriteTokens: number | null;
  cacheHitRatio: number | null;
  durationMs?: number;
  tps: number | null;
}

export interface UsageTelemetryOptions {
  durationMs?: number;
}

const PROMPT_TOKEN_PATHS = [
  "prompt_tokens",
  "input_tokens",
  "usage.prompt_tokens",
  "usage.input_tokens",
];

const COMPLETION_TOKEN_PATHS = [
  "completion_tokens",
  "output_tokens",
  "usage.completion_tokens",
  "usage.output_tokens",
];

const TOTAL_TOKEN_PATHS = [
  "total_tokens",
  "usage.total_tokens",
];

const CACHE_HIT_PATHS = [
  "prompt_cache_hit_tokens",
  "cached_tokens",
  "cache_read_input_tokens",
  "cache_read_tokens",
  "cache_hit_tokens",
  "input_cached_tokens",
  "prompt_tokens_details.cached_tokens",
  "input_tokens_details.cached_tokens",
  "input_tokens_details.cache_read",
  "usage.prompt_cache_hit_tokens",
  "usage.cached_tokens",
  "usage.prompt_tokens_details.cached_tokens",
  "usage.input_tokens_details.cached_tokens",
];

const CACHE_MISS_PATHS = [
  "prompt_cache_miss_tokens",
  "cache_miss_tokens",
  "cache_creation_input_tokens",
  "cache_creation_tokens",
  "input_tokens_details.cache_miss",
  "usage.prompt_cache_miss_tokens",
  "usage.cache_creation_input_tokens",
];

const CACHE_WRITE_PATHS = [
  "cache_write_input_tokens",
  "cache_write_tokens",
  "cache_creation_input_tokens",
  "cache_creation_tokens",
  "input_tokens_details.cache_creation",
  "usage.cache_write_input_tokens",
  "usage.cache_creation_input_tokens",
];

export function normalizeUsageTelemetry(usage: unknown, options: UsageTelemetryOptions = {}): UsageTelemetry | null {
  const record = objectRecord(usage);
  if (!record) return null;

  const promptTokens = firstNumber(record, PROMPT_TOKEN_PATHS);
  const completionTokens = firstNumber(record, COMPLETION_TOKEN_PATHS);
  const totalTokens = firstNumber(record, TOTAL_TOKEN_PATHS)
    ?? (promptTokens !== null && completionTokens !== null ? promptTokens + completionTokens : null);
  const cacheHitTokens = firstNumber(record, CACHE_HIT_PATHS);
  const cacheMissTokens = firstNumber(record, CACHE_MISS_PATHS);
  const cacheWriteTokens = firstNumber(record, CACHE_WRITE_PATHS);
  const cacheHitRatio = computeCacheHitRatio({
    promptTokens,
    cacheHitTokens,
    cacheMissTokens,
    cacheWriteTokens,
  });
  const durationMs = options.durationMs ?? firstNumber(record, ["duration_ms", "durationMs"]) ?? undefined;
  const tps = completionTokens !== null && durationMs !== undefined && durationMs >= 0
    ? completionTokens / (Math.max(1, durationMs) / 1000)
    : null;

  if (
    promptTokens === null
    && completionTokens === null
    && totalTokens === null
    && cacheHitTokens === null
    && cacheMissTokens === null
    && cacheWriteTokens === null
    && tps === null
  ) {
    return null;
  }

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cacheHitTokens,
    cacheMissTokens,
    cacheWriteTokens,
    cacheHitRatio,
    durationMs,
    tps,
  };
}

export function renderUsageTelemetry(telemetry: UsageTelemetry | null): string | null {
  if (!telemetry) return null;
  const parts = [
    telemetry.totalTokens !== null ? `${telemetry.totalTokens} tokens` : null,
    telemetry.promptTokens !== null ? `in ${telemetry.promptTokens}` : null,
    telemetry.completionTokens !== null ? `out ${telemetry.completionTokens}` : null,
    renderCachePart(telemetry),
    telemetry.tps !== null && Number.isFinite(telemetry.tps) ? `${formatTps(telemetry.tps)} TPS` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

function renderCachePart(telemetry: UsageTelemetry): string | null {
  const hit = telemetry.cacheHitTokens;
  const miss = telemetry.cacheMissTokens;
  const write = telemetry.cacheWriteTokens;
  if (hit === null && miss === null && write === null) return null;
  const ratio = telemetry.cacheHitRatio !== null ? ` (${Math.round(telemetry.cacheHitRatio * 100)}%)` : "";
  const segments = [
    hit !== null ? `${hit}` : "0",
    miss !== null ? `miss ${miss}` : null,
    write !== null && write !== miss ? `write ${write}` : null,
  ].filter(Boolean);
  return `cache ${segments.join(" · ")}${ratio}`;
}

function computeCacheHitRatio(input: {
  promptTokens: number | null;
  cacheHitTokens: number | null;
  cacheMissTokens: number | null;
  cacheWriteTokens: number | null;
}): number | null {
  const hit = input.cacheHitTokens;
  if (hit === null) return null;
  const miss = input.cacheMissTokens ?? input.cacheWriteTokens;
  if (miss !== null && hit + miss > 0) return hit / (hit + miss);
  if (input.promptTokens !== null && input.promptTokens > 0) return hit / input.promptTokens;
  return null;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function firstNumber(record: Record<string, unknown>, paths: string[]): number | null {
  for (const path of paths) {
    const value = path.split(".").reduce<unknown>((acc, part) => {
      if (!acc || typeof acc !== "object" || Array.isArray(acc)) return undefined;
      return (acc as Record<string, unknown>)[part];
    }, record);
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function formatTps(value: number): string {
  if (value >= 100) return String(Math.round(value));
  if (value >= 10) return value.toFixed(1);
  return value.toFixed(2);
}
