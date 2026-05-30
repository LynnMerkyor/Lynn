import type { BrainStreamEvent } from "./brain-client.js";
import { t } from "./i18n.js";
import { normalizeUsageTelemetry, renderUsageTelemetry } from "./usage-telemetry.js";

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
    stream.write(`\n${formatBrainErrorForHuman(event.error, event.code)}\n`);
  }
}

export function formatBrainErrorForHuman(error: string, code?: string): string {
  if (/all providers failed/i.test(error)) return t("brain.error.allProvidersFailed");
  return `Brain error: ${error}${code ? ` (${code})` : ""}`;
}

export interface UsageSummaryOptions {
  durationMs?: number;
}

export function summarizeUsage(usage: unknown, options: UsageSummaryOptions = {}): string | null {
  return renderUsageTelemetry(normalizeUsageTelemetry(usage, options));
}
