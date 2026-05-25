import { deriveProviderSnapshot } from "./provider-state-machine.js";
import type {
  ProviderAuthStatus,
  ProviderCooldownMetadata,
  ProviderErrorMetadata,
  ProviderFallbackEntry,
  ProviderFallbackMetadata,
  ProviderHealthInput,
  ProviderHealthStatus,
  ProviderModelRef,
  ProviderSnapshot,
} from "../shared/provider-state.js";

type ProviderSummaryLike = {
  type?: string;
  display_name?: string;
  base_url?: string;
  has_credentials?: boolean;
  logged_in?: boolean;
  models?: unknown[];
};

type ProviderRegistryEntryLike = {
  authType?: string;
  baseUrl?: string;
  displayName?: string;
};

type BuildProviderSummaryStateInput = {
  id: string;
  summary: ProviderSummaryLike;
  rawProvider?: unknown;
  registryEntry?: ProviderRegistryEntryLike | null;
  isOAuth?: boolean;
  loggedIn?: boolean;
};

const HEALTH_STATUSES = new Set<ProviderHealthStatus>([
  "unknown",
  "healthy",
  "checking",
  "degraded",
  "unhealthy",
  "error",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = asString(value);
    if (text) return text;
  }
  return undefined;
}

function firstBoolean(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    const bool = asBoolean(value);
    if (bool !== undefined) return bool;
  }
  return undefined;
}

function providerType(
  summary: ProviderSummaryLike,
  rawProvider: Record<string, unknown> | null,
  registryEntry?: ProviderRegistryEntryLike | null,
): string {
  return firstString(summary.type, rawProvider?.auth_type, registryEntry?.authType) || "api-key";
}

function buildAuth(type: string, summary: ProviderSummaryLike, loggedIn?: boolean): {
  required: boolean;
  status: ProviderAuthStatus;
  safeReason?: string;
} {
  if (type === "none") return { required: false, status: "not_required" };
  const authenticated = type === "oauth" ? loggedIn === true : summary.has_credentials === true;
  return {
    required: true,
    status: authenticated ? "authenticated" : "missing",
    ...(authenticated ? {} : { safeReason: "Credentials are missing." }),
  };
}

function isConfigured(type: string, summary: ProviderSummaryLike, rawProvider: Record<string, unknown> | null, registryEntry?: ProviderRegistryEntryLike | null): boolean {
  const explicit = firstBoolean(rawProvider?.configured, rawProvider?.is_configured);
  if (explicit !== undefined) return explicit;
  if (type === "none") return Boolean(summary.base_url || registryEntry?.baseUrl);
  return true;
}

function selectedModel(summary: ProviderSummaryLike): ProviderModelRef | null {
  const firstModel = Array.isArray(summary.models) ? summary.models[0] : null;
  if (typeof firstModel === "string" && firstModel.trim()) {
    return { id: firstModel.trim() };
  }
  const model = asRecord(firstModel);
  const id = firstString(model?.id);
  if (!id) return null;
  return {
    id,
    ...(firstString(model?.name, model?.displayName) ? { displayName: firstString(model?.name, model?.displayName) } : {}),
  };
}

function healthSnapshot(rawProvider: Record<string, unknown> | null): ProviderHealthInput | null {
  const rawHealth = asRecord(rawProvider?.health) || asRecord(rawProvider?.health_status);
  const statusText = firstString(rawHealth?.status, rawProvider?.health_status);
  const status = HEALTH_STATUSES.has(statusText as ProviderHealthStatus)
    ? statusText as ProviderHealthStatus
    : undefined;
  const safeReason = firstString(rawHealth?.safeReason, rawHealth?.safe_reason, rawProvider?.health_reason);
  const lastCheckedAt = rawHealth?.lastCheckedAt ?? rawHealth?.last_checked_at ?? rawProvider?.health_checked_at;
  if (!status && !safeReason && lastCheckedAt === undefined) return null;
  return {
    status: status || "unknown",
    ...(safeReason ? { safeReason } : {}),
    ...(typeof lastCheckedAt === "string" || typeof lastCheckedAt === "number" ? { lastCheckedAt } : {}),
  };
}

function fallbackSnapshot(rawProvider: Record<string, unknown> | null): ProviderFallbackMetadata | null {
  const rawFallback = asRecord(rawProvider?.fallback) || asRecord(rawProvider?.fallback_meta);
  if (!rawFallback) return null;
  const rawChain = Array.isArray(rawFallback.chain)
    ? rawFallback.chain
    : Array.isArray(rawFallback.fallback_from)
      ? rawFallback.fallback_from
      : [];
  const chain = rawChain
    .map((entry): ProviderFallbackEntry | null => {
      const record = asRecord(entry);
      const providerId = firstString(record?.providerId, record?.provider_id, record?.provider, record?.id);
      if (!providerId) return null;
      return {
        providerId,
        reason: firstString(record?.reason) || "unknown",
        ...(firstString(record?.displayName, record?.display_name, record?.name) ? { displayName: firstString(record?.displayName, record?.display_name, record?.name) } : {}),
        ...(firstString(record?.safeReason, record?.safe_reason) ? { safeReason: firstString(record?.safeReason, record?.safe_reason) } : {}),
        ...(typeof record?.at === "string" || typeof record?.at === "number" ? { at: record.at } : {}),
      };
    })
    .filter((entry): entry is ProviderFallbackEntry => entry !== null);
  const active = firstBoolean(rawFallback.active) ?? chain.length > 0;
  const activeProviderId = firstString(rawFallback.activeProviderId, rawFallback.active_provider_id);
  return {
    active,
    ...(activeProviderId ? { activeProviderId } : {}),
    chain,
  };
}

function cooldownSnapshot(rawProvider: Record<string, unknown> | null): ProviderCooldownMetadata | null {
  const rawCooldown = asRecord(rawProvider?.cooldown) || asRecord(rawProvider?.cooldown_meta);
  if (!rawCooldown) return null;
  const active = firstBoolean(rawCooldown.active) ?? false;
  const until = rawCooldown.until ?? rawCooldown.until_at;
  return {
    active,
    ...(firstString(rawCooldown.reason) ? { reason: firstString(rawCooldown.reason) } : {}),
    ...(firstString(rawCooldown.safeReason, rawCooldown.safe_reason) ? { safeReason: firstString(rawCooldown.safeReason, rawCooldown.safe_reason) } : {}),
    ...(typeof until === "string" || typeof until === "number" ? { until } : {}),
  };
}

function errorSnapshot(rawProvider: Record<string, unknown> | null): ProviderErrorMetadata | null {
  const rawError = asRecord(rawProvider?.error);
  const active = firstBoolean(rawError?.active, rawProvider?.error_active) ?? false;
  const safeReason = firstString(rawError?.safeReason, rawError?.safe_reason, rawProvider?.error_reason);
  const code = firstString(rawError?.code, rawProvider?.error_code);
  if (!active && !safeReason && !code) return null;
  return {
    active,
    ...(code ? { code } : {}),
    ...(safeReason ? { safeReason } : {}),
  };
}

export function buildProviderSummaryStateSnapshot(input: BuildProviderSummaryStateInput): ProviderSnapshot {
  const rawProvider = asRecord(input.rawProvider);
  const type = providerType(input.summary, rawProvider, input.registryEntry);
  const loggedIn = input.loggedIn ?? input.summary.logged_in === true;
  return deriveProviderSnapshot({
    id: input.id,
    displayName: firstString(input.summary.display_name, input.registryEntry?.displayName, input.id) || input.id,
    configured: isConfigured(type, input.summary, rawProvider, input.registryEntry),
    disabled: firstBoolean(rawProvider?.disabled, rawProvider?.is_disabled) === true,
    selectedModel: selectedModel(input.summary),
    auth: buildAuth(input.isOAuth === true ? "oauth" : type, input.summary, loggedIn),
    health: healthSnapshot(rawProvider),
    fallback: fallbackSnapshot(rawProvider),
    cooldown: cooldownSnapshot(rawProvider),
    error: errorSnapshot(rawProvider),
    safeReason: firstString(rawProvider?.safeReason, rawProvider?.safe_reason),
  });
}
