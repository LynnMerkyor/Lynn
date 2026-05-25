import { lookupKnown } from "../shared/known-models.js";
import type { ModelRef, ProviderId, ResolvedModel } from "./types.js";

export const DEFAULT_COMPACTION_RESERVE_TOKENS = 16_384;
export const DEFAULT_COMPACTION_KEEP_RECENT_TOKENS = 20_000;
export const MIN_COMPACTION_KEEP_RECENT_TOKENS = 8_192;
export const MAX_COMPACTION_KEEP_RECENT_TOKENS = 65_536;

const KEEP_RECENT_GAP_TOKENS = 4_096;

export interface CompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
}

type ContextModelRef = Pick<ResolvedModel, "id" | "provider" | "contextWindow"> | ModelRef | null | undefined;
type KnownModelMetadata = { contextWindow?: unknown; context?: unknown };

function resolveKeepRecentRatio(contextWindow: number | null): number {
  if (!contextWindow || contextWindow >= 64_000) return 0.20;
  if (contextWindow >= 32_000) return 0.25;
  if (contextWindow >= 16_000) return 0.30;
  return 0.40;
}

// 动态 reserve：小窗口模型减少输出预留
function resolveReserveTokens(contextWindow: number | null): number {
  if (!contextWindow || contextWindow >= 32_000) return 16_384;
  if (contextWindow >= 16_000) return 8_192;
  return 4_096;
}

function normalizePositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

export function resolveModelContextWindow(model: ContextModelRef): number | null {
  if (typeof model === "string") return null;
  const direct = normalizePositiveInteger((model as { contextWindow?: unknown } | null | undefined)?.contextWindow);
  if (direct) return direct;

  const modelId = typeof model?.id === "string" ? model.id.trim() : "";
  if (!modelId) return null;

  const provider = typeof model?.provider === "string" ? model.provider : "";
  const known = lookupKnown(provider as ProviderId, modelId) as KnownModelMetadata | null;
  return normalizePositiveInteger(known?.contextWindow || known?.context);
}

export function resolveCompactionSettings(model: ContextModelRef): CompactionSettings {
  const contextWindow = resolveModelContextWindow(model);
  if (!contextWindow) {
    return {
      enabled: true,
      reserveTokens: DEFAULT_COMPACTION_RESERVE_TOKENS,
      keepRecentTokens: DEFAULT_COMPACTION_KEEP_RECENT_TOKENS,
    };
  }

  const reserveTokens = resolveReserveTokens(contextWindow);
  const keepRecentRatio = resolveKeepRecentRatio(contextWindow);
  const compactionThreshold = Math.max(4_096, contextWindow - reserveTokens);
  const maxKeepRecentTokens = Math.max(4_096, compactionThreshold - KEEP_RECENT_GAP_TOKENS);
  const minKeepRecentTokens = Math.min(MIN_COMPACTION_KEEP_RECENT_TOKENS, maxKeepRecentTokens);
  const ratioKeepRecentTokens = Math.round(contextWindow * keepRecentRatio);
  const keepRecentTokens = Math.max(
    minKeepRecentTokens,
    Math.min(MAX_COMPACTION_KEEP_RECENT_TOKENS, maxKeepRecentTokens, ratioKeepRecentTokens),
  );

  return {
    enabled: true,
    reserveTokens,
    keepRecentTokens,
  };
}
