import { normalizeUsageTelemetry } from "./usage-telemetry.js";

export interface RuntimeMetrics {
  decodeSamples: number[];
  cacheSamples: number[];
  usageSamples: number;
  /** Session-cumulative cloud token spend (sum of per-round FINAL usage frames only). */
  sessionPromptTokens: number;
  sessionCompletionTokens: number;
}

export function createRuntimeMetrics(): RuntimeMetrics {
  return { decodeSamples: [], cacheSamples: [], usageSamples: 0, sessionPromptTokens: 0, sessionCompletionTokens: 0 };
}

export function recordDecodeTps(metrics: RuntimeMetrics, value: string | null | undefined): void {
  const parsed = parseTps(value);
  if (parsed === null) return;
  pushBounded(metrics.decodeSamples, parsed);
}

export function recordUsageMetrics(metrics: RuntimeMetrics, usage: unknown): void {
  const telemetry = normalizeUsageTelemetry(usage);
  if (telemetry) metrics.usageSamples += 1;
  if (telemetry?.cacheHitRatio !== null && telemetry?.cacheHitRatio !== undefined) {
    pushBounded(metrics.cacheSamples, telemetry.cacheHitRatio);
  }
  // Cumulative spend: callers must pass the per-round FINAL usage frame only (streaming
  // mid-frames are cumulative within a round; summing every frame would overcount).
  if (typeof telemetry?.promptTokens === "number") metrics.sessionPromptTokens += telemetry.promptTokens;
  if (typeof telemetry?.completionTokens === "number") metrics.sessionCompletionTokens += telemetry.completionTokens;
}

export function renderRuntimeMetrics(metrics: RuntimeMetrics): string | null {
  const parts = [
    renderAverageTps(metrics.decodeSamples),
    renderAverageCache(metrics.cacheSamples) || renderCacheTracking(metrics),
    renderSessionTotals(metrics),
  ].filter((part): part is string => !!part);
  return parts.length ? parts.join(" · ") : null;
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

/** Session-cumulative cloud spend — every token is cloud-billed on the StepFun-only route. */
function renderSessionTotals(metrics: RuntimeMetrics): string | null {
  const total = metrics.sessionPromptTokens + metrics.sessionCompletionTokens;
  if (total <= 0) return null;
  return `Σ ${formatTokenCount(total)} tok (in ${formatTokenCount(metrics.sessionPromptTokens)} · out ${formatTokenCount(metrics.sessionCompletionTokens)})`;
}

function renderAverageTps(samples: number[]): string | null {
  if (!samples.length) return null;
  const avg = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  return `avg decode ${formatMetricTps(avg)} TPS`;
}

function renderAverageCache(samples: number[]): string | null {
  if (!samples.length) return null;
  const avg = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  return `prefix-cache ${Math.round(avg * 100)}% recent`;
}

function renderCacheTracking(metrics: RuntimeMetrics): string {
  return metrics.usageSamples > 0 ? "prefix-cache hit tracking" : "prefix-cache warming";
}

function parseTps(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = value.match(/([0-9]+(?:\.[0-9]+)?)\s*TPS/i);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatMetricTps(value: number): string {
  if (value >= 100) return String(Math.round(value));
  if (value >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

function pushBounded(values: number[], value: number): void {
  values.push(value);
  if (values.length > 8) values.shift();
}
