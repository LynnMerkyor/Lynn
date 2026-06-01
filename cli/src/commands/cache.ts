import { getStringFlag, type ParsedArgs } from "../args.js";
import { writeJsonLine } from "../jsonl.js";
import { listSessions, readSessionLinesResult, resolveDataDir } from "../session/store.js";
import { computeSessionStats, type CliSessionStats } from "../session/stats.js";

export interface CacheDoctorResult {
  sessionPath: string;
  ok: boolean;
  warnings: string[];
  recommendations: string[];
  skippedLines: number;
  stats: CliSessionStats;
}

export async function runCache(args: ParsedArgs, json: boolean): Promise<number> {
  const subcommand = args.positionals[0] || "doctor";
  if (subcommand !== "doctor" && subcommand !== "stats") {
    throw new Error(`unknown cache command: ${subcommand}`);
  }
  const dataDir = resolveDataDir(getStringFlag(args.flags, "data-dir"));
  const sessionPath = await resolveCacheSessionPath(args, dataDir);
  const result = await inspectCacheSession(sessionPath);
  if (json) writeJsonLine({ type: "cache.doctor", ...result });
  else process.stdout.write(renderCacheDoctor(result));
  return result.ok ? 0 : 1;
}

export async function inspectCacheSession(sessionPath: string): Promise<CacheDoctorResult> {
  const read = await readSessionLinesResult(sessionPath);
  const stats = computeSessionStats(read.lines);
  const warnings: string[] = [];
  const recommendations: string[] = [];

  if (read.skipped > 0) {
    warnings.push(`${read.skipped} malformed session line(s) were skipped`);
    recommendations.push("Resume is still possible, but inspect the session if important context seems missing.");
  }
  if (!stats.stablePrefixes.length) {
    warnings.push("No stable prefix diagnostics were recorded");
    recommendations.push("Run long coding tasks with session saving enabled so Lynn can audit prefix stability.");
  } else if (stats.prefixDrift) {
    warnings.push("Stable prefix drift detected");
    recommendations.push("Keep durable instructions, memory, and project context before volatile runtime/tool state.");
  } else {
    recommendations.push("Stable prefix is consistent across recorded turns.");
  }
  if (stats.usageRecords === 0) {
    warnings.push("No usage telemetry records were found");
    recommendations.push("Cache hit ratio will appear once the provider returns usage telemetry.");
  } else if (stats.cacheHitRatio === null) {
    recommendations.push("Usage telemetry is present, but this provider did not report cache hit/miss tokens.");
  } else if (stats.cacheHitRatio < 0.5) {
    warnings.push(`Low cache hit ratio (${formatPercent(stats.cacheHitRatio)})`);
    recommendations.push("Check whether the stable prefix changes between turns or large volatile frames are inserted early.");
  } else {
    recommendations.push(`Cache hit ratio is ${formatPercent(stats.cacheHitRatio)} for reported tokens.`);
  }

  return {
    sessionPath,
    ok: warnings.length === 0,
    warnings,
    recommendations: dedupe(recommendations),
    skippedLines: read.skipped,
    stats,
  };
}

export function renderCacheDoctor(result: CacheDoctorResult): string {
  const stats = result.stats;
  const prefix = stats.stablePrefixes.length
    ? stats.stablePrefixes.map((entry) => [
      entry.hash,
      `x${entry.count}`,
      entry.chars !== null ? `${entry.chars} chars` : null,
      entry.frames !== null ? `${entry.frames} stable` : null,
      entry.volatileFrames !== null ? `${entry.volatileFrames} volatile` : null,
      entry.resumedMessages ? `${entry.resumedMessages} resumed` : null,
    ].filter(Boolean).join(" · ")).join("; ")
    : "none";
  const cache = stats.usageRecords
    ? [
      `${stats.usageRecords} usage record(s)`,
      `${stats.cacheHitTokens} hit`,
      `${stats.cacheMissTokens} miss`,
      stats.cacheHitRatio !== null ? formatPercent(stats.cacheHitRatio) : "ratio unavailable",
    ].join(" · ")
    : "none";
  return [
    "Lynn cache doctor",
    `session: ${result.sessionPath}`,
    `status: ${result.ok ? "OK" : "WARN"}`,
    `prefix: ${stats.prefixDrift ? "DRIFT · " : ""}${prefix}`,
    `cache: ${cache}`,
    `turns: user ${stats.userTurns} · assistant ${stats.assistantTurns} · tool ${stats.toolResults}`,
    result.warnings.length ? `warnings:\n${result.warnings.map((item) => `  - ${item}`).join("\n")}` : "warnings: none",
    result.recommendations.length ? `recommendations:\n${result.recommendations.map((item) => `  - ${item}`).join("\n")}` : "recommendations: none",
  ].join("\n") + "\n";
}

async function resolveCacheSessionPath(args: ParsedArgs, dataDir: string): Promise<string> {
  const explicit = args.positionals[1] || getStringFlag(args.flags, "session");
  if (explicit) return explicit;
  const sessions = await listSessions(dataDir);
  const latest = sessions[0]?.path;
  if (!latest) throw new Error(`No Lynn CLI sessions found in ${dataDir}`);
  return latest;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
