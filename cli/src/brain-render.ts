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

export function summarizeUsage(usage: unknown): string | null {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const record = usage as Record<string, unknown>;
  const prompt = numberValue(record.prompt_tokens);
  const completion = numberValue(record.completion_tokens);
  const total = numberValue(record.total_tokens);
  const cacheHit = numberValue(record.prompt_cache_hit_tokens);
  const parts = [
    total !== null ? `${total} tokens` : null,
    prompt !== null ? `in ${prompt}` : null,
    completion !== null ? `out ${completion}` : null,
    cacheHit !== null ? `cache ${cacheHit}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
