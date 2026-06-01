import type { BrainStreamEvent } from "./brain-client.js";
import { t } from "./i18n.js";
import { brightCyan, cyan, dim, supportsColor, yellow } from "./terminal-style.js";
import { renderCard } from "./terminal-spinner.js";
import { normalizeUsageTelemetry, renderUsageTelemetry } from "./usage-telemetry.js";

export interface HumanBrainRenderState {
  provider?: string;
}

export function renderBrainEventForHuman(
  event: BrainStreamEvent,
  state: HumanBrainRenderState,
  stream: NodeJS.WriteStream,
): void {
  const color = supportsColor(stream);
  if (event.type === "provider") {
    state.provider = event.activeProvider;
    const fallback = event.fallbackFrom?.length
      ? ` fallback: ${event.fallbackFrom.map((entry) => `${entry.id}${entry.reason ? `(${entry.reason})` : ""}`).join(" -> ")} -> `
      : "";
    stream.write(`\n${renderCard({
      kind: "info",
      title: `route: ${providerLabel(event.activeProvider, color)}`,
      body: fallback ? [fallback.trim()] : undefined,
    }, color)}\n`);
    return;
  }
  if (event.type === "tool_progress") {
    if (event.event === "start") {
      stream.write(`${renderCard({
        kind: "tool",
        title: `${toolIcon(event.name)} ${event.name} · running`,
      }, color)}\n`);
      return;
    }
    if (event.event === "end") {
      const status = event.ok === false ? "failed" : "done";
      const timing = typeof event.ms === "number" ? ` ${formatDuration(event.ms)}` : "";
      stream.write(`${renderCard({
        kind: event.ok === false ? "error" : "ok",
        title: `${toolIcon(event.name)} ${event.name} · ${status}${timing}`,
        body: event.summary ? [event.summary] : undefined,
      }, color)}\n`);
      return;
    }
    stream.write(`${renderCard({
      kind: "tool",
      title: `${toolIcon(event.name)} ${event.name} · ${event.event}`,
    }, color)}\n`);
    return;
  }
  if (event.type === "brain.error") {
    stream.write(`\n${formatBrainErrorForHuman(event.error, event.code)}\n`);
  }
}

function providerLabel(provider: string, color: boolean): string {
  if (provider.includes("step-3.7")) return brightCyan("StepFun 3.7 Flash", color);
  if (provider.includes("mimo")) return cyan("MiMo V2.5 Pro", color);
  if (provider.includes("spark") || provider.includes("apex")) return yellow("Spark Qwen 3.6 35B A3B", color);
  return provider;
}

function toolIcon(name: string): string {
  const normalized = name.toLowerCase();
  if (normalized.includes("search")) return "🔎";
  if (normalized.includes("fetch") || normalized.includes("web")) return "🌐";
  if (normalized.includes("stock") || normalized.includes("finance")) return "📈";
  if (normalized.includes("weather")) return "🌦";
  if (normalized.includes("file") || normalized.includes("read")) return "📄";
  return "🔧";
}

function formatDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s`;
  return `${ms}ms`;
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
