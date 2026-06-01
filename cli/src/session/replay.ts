import type { CliSessionLine } from "./store.js";
import { normalizeUsageTelemetry } from "../usage-telemetry.js";

export interface CliSessionReplayEvent {
  index: number;
  ts: string;
  time: string;
  type: CliSessionLine["type"];
  label: string;
  content: string;
  detail: string | null;
}

export function buildSessionReplayEvents(lines: readonly CliSessionLine[]): CliSessionReplayEvent[] {
  return lines.map((line, idx) => {
    const data = objectRecord(line.data);
    if (line.type === "metadata") {
      const metadata = summarizeMetadata(data);
      return {
        index: idx + 1,
        ts: line.ts,
        time: formatTime(line.ts),
        type: line.type,
        label: typeof data?.kind === "string" ? `metadata ${data.kind}` : "metadata",
        content: metadata.content,
        detail: metadata.detail,
      };
    }
    if (line.type === "tool") {
      const name = typeof data?.name === "string" ? data.name : "tool";
      const toolCallId = typeof data?.tool_call_id === "string" ? data.tool_call_id : "";
      return {
        index: idx + 1,
        ts: line.ts,
        time: formatTime(line.ts),
        type: line.type,
        label: `tool ${name}`,
        content: compactText(line.content || "(no tool result)", 110),
        detail: toolCallId ? `tool_call_id ${toolCallId}` : null,
      };
    }
    return {
      index: idx + 1,
      ts: line.ts,
      time: formatTime(line.ts),
      type: line.type,
      label: line.type,
      content: compactText(line.content || "(empty)", line.type === "assistant" ? 140 : 110),
      detail: null,
    };
  });
}

export function renderSessionReplay(sessionPath: string, lines: readonly CliSessionLine[]): string {
  const events = buildSessionReplayEvents(lines);
  const width = Math.max(2, String(Math.max(events.length, 1)).length);
  const body = events.map((event) => {
    const head = `${String(event.index).padStart(width, "0")}. ${event.time} ${event.label.padEnd(18)}`;
    const detail = event.detail ? `\n${" ".repeat(width + 22)}${event.detail}` : "";
    return `${head} ${event.content}${detail}`;
  });
  return [
    "Lynn session replay",
    `path: ${sessionPath}`,
    `events: ${events.length}`,
    "",
    ...body,
  ].join("\n") + "\n";
}

function summarizeMetadata(data: Record<string, unknown> | null): { content: string; detail: string | null } {
  if (!data) return { content: "metadata", detail: null };
  const parts: string[] = [];
  const details: string[] = [];
  const usage = summarizeUsage(data);
  const prefix = summarizePrefix(data);
  if (usage) parts.push(usage);
  if (prefix) parts.push(prefix);
  if (data.maxStepsReached === true) parts.push("max steps reached");
  if (typeof data.cwd === "string" && data.cwd) details.push(`cwd ${data.cwd}`);
  if (typeof data.resumedFrom === "string" && data.resumedFrom) details.push(`resumed from ${data.resumedFrom}`);
  const images = Array.isArray(data.images) ? data.images.filter((item) => typeof item === "string") : [];
  if (images.length) details.push(`images ${images.length}`);
  return {
    content: parts.length ? parts.join(" · ") : compactText(JSON.stringify(data), 140),
    detail: details.length ? details.join(" · ") : null,
  };
}

function summarizeUsage(data: Record<string, unknown>): string | null {
  const records = usageRecordsFromMetadata(data);
  if (!records.length) return null;
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let cacheHitTokens = 0;
  let cacheMissTokens = 0;
  let durationMs = 0;
  for (const record of records) {
    const telemetry = normalizeUsageTelemetry(record.usage, { durationMs: record.durationMs });
    if (!telemetry) continue;
    const prompt = telemetry.promptTokens ?? 0;
    const completion = telemetry.completionTokens ?? 0;
    promptTokens += prompt;
    completionTokens += completion;
    totalTokens += telemetry.totalTokens ?? prompt + completion;
    cacheHitTokens += telemetry.cacheHitTokens ?? 0;
    cacheMissTokens += telemetry.cacheMissTokens ?? telemetry.cacheWriteTokens ?? 0;
    if (typeof record.durationMs === "number" && Number.isFinite(record.durationMs) && record.durationMs > 0) {
      durationMs += record.durationMs;
    }
  }
  const parts = [
    totalTokens ? `usage ${totalTokens} tokens` : null,
    promptTokens ? `in ${promptTokens}` : null,
    completionTokens ? `out ${completionTokens}` : null,
    cacheHitTokens || cacheMissTokens ? cacheSummary(cacheHitTokens, cacheMissTokens) : null,
    durationMs > 0 && completionTokens > 0 ? `${formatTps(completionTokens / (durationMs / 1000))} TPS` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

function summarizePrefix(data: Record<string, unknown>): string | null {
  const diagnostics = objectRecord(data.cacheDiagnostics);
  const hash = typeof diagnostics?.stablePrefixHash === "string" ? diagnostics.stablePrefixHash : "";
  if (!hash) return null;
  const chars = typeof diagnostics?.stablePrefixChars === "number" ? diagnostics.stablePrefixChars : null;
  const frames = typeof diagnostics?.stableFrameCount === "number" ? diagnostics.stableFrameCount : null;
  const volatile = typeof diagnostics?.volatileFrameCount === "number" ? diagnostics.volatileFrameCount : null;
  const resumed = typeof diagnostics?.resumeMessageCount === "number" ? diagnostics.resumeMessageCount : null;
  return [
    `cache prefix ${hash}`,
    chars !== null ? `${chars} chars` : null,
    frames !== null ? `${frames} frames` : null,
    volatile !== null ? `${volatile} volatile` : null,
    resumed ? `${resumed} resumed` : null,
  ].filter(Boolean).join(" · ");
}

function usageRecordsFromMetadata(data: Record<string, unknown>): Array<{ usage: unknown; durationMs?: number }> {
  const records = data.usageRecords;
  if (Array.isArray(records)) {
    return records
      .map((record) => objectRecord(record))
      .filter((record): record is Record<string, unknown> => !!record)
      .map((record) => ({
        usage: record.usage,
        durationMs: typeof record.durationMs === "number" ? record.durationMs : undefined,
      }))
      .filter((record) => record.usage !== undefined);
  }
  if (data.usage !== undefined) {
    return [{ usage: data.usage, durationMs: typeof data.durationMs === "number" ? data.durationMs : undefined }];
  }
  return [];
}

function cacheSummary(hit: number, miss: number): string {
  const total = hit + miss;
  const ratio = total > 0 ? Math.round((hit / total) * 100) : null;
  return `prefix-cache ${hit} hit · miss ${miss}${ratio !== null ? ` (${ratio}%)` : ""}`;
}

function compactText(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function formatTime(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return date.toISOString().slice(11, 19);
}

function formatTps(value: number): string {
  if (value >= 100) return String(Math.round(value));
  if (value >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
