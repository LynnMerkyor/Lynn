import { normalizeUsageTelemetry } from "./usage-telemetry.js";

export interface RuntimeMetrics {
  decodeSamples: number[];
  cacheSamples: number[];
}

export function createRuntimeMetrics(): RuntimeMetrics {
  return { decodeSamples: [], cacheSamples: [] };
}

export function recordDecodeTps(metrics: RuntimeMetrics, value: string | null | undefined): void {
  const parsed = parseTps(value);
  if (parsed === null) return;
  pushBounded(metrics.decodeSamples, parsed);
}

export function recordUsageMetrics(metrics: RuntimeMetrics, usage: unknown): void {
  const telemetry = normalizeUsageTelemetry(usage);
  if (telemetry?.cacheHitRatio !== null && telemetry?.cacheHitRatio !== undefined) {
    pushBounded(metrics.cacheSamples, telemetry.cacheHitRatio);
  }
}

export function renderRuntimeMetrics(metrics: RuntimeMetrics): string | null {
  const parts = [
    renderAverageTps(metrics.decodeSamples),
    renderAverageCache(metrics.cacheSamples) || "prefix-cache --",
  ].filter((part): part is string => !!part);
  return parts.length ? parts.join(" · ") : null;
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
