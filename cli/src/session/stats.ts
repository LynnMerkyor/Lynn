import type { CliSessionLine } from "./store.js";
import { normalizeUsageTelemetry } from "../usage-telemetry.js";

export interface CliUsageRecord {
  usage: unknown;
  durationMs?: number;
}

export interface CliSessionStats {
  totalLines: number;
  userTurns: number;
  assistantTurns: number;
  toolResults: number;
  metadataLines: number;
  usageRecords: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  cacheHitRatio: number | null;
  avgTps: number | null;
  stablePrefixes: Array<{
    hash: string;
    count: number;
    chars: number | null;
    frames: number | null;
    volatileFrames: number | null;
    resumedMessages: number | null;
  }>;
  prefixDrift: boolean;
  tools: Array<{ name: string; count: number }>;
}

export function computeSessionStats(lines: readonly CliSessionLine[]): CliSessionStats {
  const toolCounts = new Map<string, number>();
  const prefixCounts = new Map<string, {
    count: number;
    chars: number | null;
    frames: number | null;
    volatileFrames: number | null;
    resumedMessages: number | null;
  }>();
  const usages: CliUsageRecord[] = [];
  let userTurns = 0;
  let assistantTurns = 0;
  let toolResults = 0;
  let metadataLines = 0;

  for (const line of lines) {
    if (line.type === "user") userTurns += 1;
    else if (line.type === "assistant") assistantTurns += 1;
    else if (line.type === "tool") {
      toolResults += 1;
      const name = typeof line.data?.name === "string" ? line.data.name : "tool";
      toolCounts.set(name, (toolCounts.get(name) || 0) + 1);
    } else if (line.type === "metadata") {
      metadataLines += 1;
      const records = usageRecordsFromMetadata(line.data);
      usages.push(...records);
      const prefix = stablePrefixFromMetadata(line.data);
      if (prefix) {
        const previous = prefixCounts.get(prefix.hash);
        prefixCounts.set(prefix.hash, {
          count: (previous?.count || 0) + 1,
          chars: prefix.chars ?? previous?.chars ?? null,
          frames: prefix.frames ?? previous?.frames ?? null,
          volatileFrames: prefix.volatileFrames ?? previous?.volatileFrames ?? null,
          resumedMessages: prefix.resumedMessages ?? previous?.resumedMessages ?? null,
        });
      }
    }
  }

  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let cacheHitTokens = 0;
  let cacheMissTokens = 0;
  let totalDurationMs = 0;

  for (const record of usages) {
    const telemetry = normalizeUsageTelemetry(record.usage, { durationMs: record.durationMs });
    if (!telemetry) continue;
    const prompt = telemetry.promptTokens ?? 0;
    const completion = telemetry.completionTokens ?? 0;
    const total = telemetry.totalTokens ?? prompt + completion;
    promptTokens += prompt;
    completionTokens += completion;
    totalTokens += total;
    cacheHitTokens += telemetry.cacheHitTokens ?? 0;
    cacheMissTokens += telemetry.cacheMissTokens ?? telemetry.cacheWriteTokens ?? 0;
    if (typeof record.durationMs === "number" && Number.isFinite(record.durationMs) && record.durationMs > 0) {
      totalDurationMs += record.durationMs;
    }
  }

  const cacheTotal = cacheHitTokens + cacheMissTokens;
  const cacheHitRatio = cacheTotal > 0
    ? cacheHitTokens / cacheTotal
    : promptTokens > 0 && cacheHitTokens > 0
      ? cacheHitTokens / promptTokens
      : null;
  const avgTps = totalDurationMs > 0 && completionTokens > 0
    ? completionTokens / (totalDurationMs / 1000)
    : null;

  return {
    totalLines: lines.length,
    userTurns,
    assistantTurns,
    toolResults,
    metadataLines,
    usageRecords: usages.length,
    promptTokens,
    completionTokens,
    totalTokens,
    cacheHitTokens,
    cacheMissTokens,
    cacheHitRatio,
    avgTps,
    stablePrefixes: [...prefixCounts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([hash, value]) => ({ hash, ...value })),
    prefixDrift: prefixCounts.size > 1,
    tools: [...toolCounts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, count]) => ({ name, count })),
  };
}

export function renderSessionStats(sessionPath: string, stats: CliSessionStats): string {
  const tools = stats.tools.length
    ? stats.tools.map((tool) => `${tool.name} x${tool.count}`).join(", ")
    : "none";
  const usage = stats.usageRecords > 0
    ? [
        `${stats.totalTokens} tokens`,
        `in ${stats.promptTokens}`,
        `out ${stats.completionTokens}`,
        stats.cacheHitTokens || stats.cacheMissTokens
          ? `cache ${stats.cacheHitTokens}${stats.cacheHitRatio !== null ? ` (${Math.round(stats.cacheHitRatio * 100)}%)` : ""}`
          : null,
        stats.avgTps !== null ? `${formatTps(stats.avgTps)} TPS` : null,
      ].filter(Boolean).join(" · ")
    : "no usage records";
  const prefix = renderPrefixStats(stats);
  return [
    "Lynn session stats",
    `path: ${sessionPath}`,
    `turns: user ${stats.userTurns} · assistant ${stats.assistantTurns} · tool ${stats.toolResults} · metadata ${stats.metadataLines}`,
    `usage: ${usage}`,
    `prefix: ${prefix}`,
    `tools: ${tools}`,
  ].join("\n") + "\n";
}

function usageRecordsFromMetadata(data: Record<string, unknown> | undefined): CliUsageRecord[] {
  if (!data) return [];
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

function stablePrefixFromMetadata(data: Record<string, unknown> | undefined): {
  hash: string;
  chars: number | null;
  frames: number | null;
  volatileFrames: number | null;
  resumedMessages: number | null;
} | null {
  const diagnostics = objectRecord(data?.cacheDiagnostics);
  if (!diagnostics) return null;
  const hash = typeof diagnostics.stablePrefixHash === "string" ? diagnostics.stablePrefixHash : "";
  if (!hash) return null;
  const chars = typeof diagnostics.stablePrefixChars === "number" && Number.isFinite(diagnostics.stablePrefixChars)
    ? diagnostics.stablePrefixChars
    : null;
  const frames = typeof diagnostics.stableFrameCount === "number" && Number.isFinite(diagnostics.stableFrameCount)
    ? diagnostics.stableFrameCount
    : null;
  const volatileFrames = typeof diagnostics.volatileFrameCount === "number" && Number.isFinite(diagnostics.volatileFrameCount)
    ? diagnostics.volatileFrameCount
    : null;
  const resumedMessages = typeof diagnostics.resumeMessageCount === "number" && Number.isFinite(diagnostics.resumeMessageCount)
    ? diagnostics.resumeMessageCount
    : null;
  return { hash, chars, frames, volatileFrames, resumedMessages };
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

function renderPrefixStats(stats: CliSessionStats): string {
  if (!stats.stablePrefixes.length) return "no stable prefix records";
  const summary = stats.stablePrefixes
    .map((entry) => [
      entry.hash,
      `x${entry.count}`,
      entry.chars !== null ? `${entry.chars} chars` : null,
      entry.frames !== null ? `${entry.frames} frames` : null,
      entry.volatileFrames !== null ? `${entry.volatileFrames} volatile` : null,
      entry.resumedMessages ? `${entry.resumedMessages} resumed` : null,
    ].filter(Boolean).join(" · "))
    .join("; ");
  return stats.prefixDrift ? `DRIFT · ${summary}` : summary;
}
