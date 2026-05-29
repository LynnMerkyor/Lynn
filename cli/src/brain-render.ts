import type { BrainStreamEvent } from "./brain-client.js";

export interface HumanBrainRenderState {
  provider?: string;
}

export function renderBrainEventForHuman(
  event: BrainStreamEvent,
  state: HumanBrainRenderState,
  stream: NodeJS.WriteStream,
): void {
  if (event.type === "provider") {
    state.provider = event.activeProvider;
    const fallback = event.fallbackFrom?.length
      ? ` fallback: ${event.fallbackFrom.map((entry) => `${entry.id}${entry.reason ? `(${entry.reason})` : ""}`).join(" -> ")} -> `
      : "";
    stream.write(`\nroute: ${fallback}${event.activeProvider}\n`);
    return;
  }
  if (event.type === "tool_progress") {
    if (event.event === "start") {
      stream.write(`\nserver tool: ${event.name} ...\n`);
      return;
    }
    if (event.event === "end") {
      const status = event.ok === false ? "failed" : "done";
      const timing = typeof event.ms === "number" ? ` ${event.ms}ms` : "";
      stream.write(`server tool: ${event.name} ${status}${timing}\n`);
      return;
    }
    stream.write(`\nserver tool: ${event.name} ${event.event}\n`);
    return;
  }
  if (event.type === "brain.error") {
    stream.write(`\nBrain error: ${event.error}${event.code ? ` (${event.code})` : ""}\n`);
  }
}

export interface UsageSummaryOptions {
  durationMs?: number;
}

export function summarizeUsage(usage: unknown, options: UsageSummaryOptions = {}): string | null {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const record = usage as Record<string, unknown>;
  const prompt = numberValue(record.prompt_tokens);
  const completion = numberValue(record.completion_tokens);
  const total = numberValue(record.total_tokens);
  const cacheHit = numberValue(record.prompt_cache_hit_tokens);
  const cacheMiss = numberValue(record.prompt_cache_miss_tokens);
  const cacheRatio = cacheHit !== null && prompt !== null && prompt > 0
    ? `${Math.round((cacheHit / prompt) * 100)}%`
    : cacheHit !== null && cacheMiss !== null && cacheHit + cacheMiss > 0
      ? `${Math.round((cacheHit / (cacheHit + cacheMiss)) * 100)}%`
      : null;
  const tps = completion !== null && options.durationMs && options.durationMs > 0
    ? completion / (options.durationMs / 1000)
    : null;
  const parts = [
    total !== null ? `${total} tokens` : null,
    prompt !== null ? `in ${prompt}` : null,
    completion !== null ? `out ${completion}` : null,
    cacheHit !== null ? `cache ${cacheHit}${cacheRatio ? ` (${cacheRatio})` : ""}` : null,
    tps !== null && Number.isFinite(tps) ? `${formatTps(tps)} TPS` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatTps(value: number): string {
  if (value >= 100) return String(Math.round(value));
  if (value >= 10) return value.toFixed(1);
  return value.toFixed(2);
}
