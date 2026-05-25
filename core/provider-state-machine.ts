import type {
  ProviderAuthInput,
  ProviderAuthSnapshot,
  ProviderCooldownMetadata,
  ProviderFallbackEntry,
  ProviderFallbackMetadata,
  ProviderHealthInput,
  ProviderHealthSnapshot,
  ProviderModelRef,
  ProviderSnapshot,
  ProviderSnapshotInput,
  ProviderState,
  ProviderTimestamp,
} from "../shared/provider-state.js";

const AUTHENTICATED_STATUSES = new Set(["authenticated", "not_required"]);
const MAX_REASON_LENGTH = 500;

function cleanText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed
    .slice(0, MAX_REASON_LENGTH)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]")
    .replace(/\b(sk|tp)-[A-Za-z0-9_-]{8,}/gi, "[redacted]")
    .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*[^,\s;]+/gi, "$1=[redacted]");
}

function cleanTimestamp(value: ProviderTimestamp | null | undefined): ProviderTimestamp | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}

function cleanModelRef(model: ProviderModelRef | null | undefined): ProviderModelRef | null {
  if (!model || typeof model.id !== "string" || !model.id.trim()) return null;
  const cleaned: ProviderModelRef = { id: model.id.trim() };
  const providerId = cleanText(model.providerId);
  const displayName = cleanText(model.displayName);
  if (providerId) cleaned.providerId = providerId;
  if (displayName) cleaned.displayName = displayName;
  return cleaned;
}

function normalizeAuth(auth: ProviderAuthInput | null | undefined): ProviderAuthSnapshot {
  if (!auth) {
    return { required: false, status: "not_required" };
  }
  const snapshot: ProviderAuthSnapshot = {
    required: auth.required === true,
    status: auth.status,
  };
  const safeReason = cleanText(auth.safeReason);
  if (safeReason) snapshot.safeReason = safeReason;
  return snapshot;
}

function normalizeHealth(health: ProviderHealthInput | null | undefined): ProviderHealthSnapshot {
  const snapshot: ProviderHealthSnapshot = {
    status: health?.status || "unknown",
  };
  const lastCheckedAt = cleanTimestamp(health?.lastCheckedAt);
  const safeReason = cleanText(health?.safeReason);
  if (lastCheckedAt !== undefined) snapshot.lastCheckedAt = lastCheckedAt;
  if (safeReason) snapshot.safeReason = safeReason;
  return snapshot;
}

function normalizeFallback(fallback: ProviderFallbackMetadata | null | undefined): ProviderFallbackMetadata {
  const chain = Array.isArray(fallback?.chain)
    ? fallback.chain
      .map((entry): ProviderFallbackEntry | null => {
        if (!entry || typeof entry.providerId !== "string" || !entry.providerId.trim()) return null;
        const cleaned: ProviderFallbackEntry = {
          providerId: entry.providerId.trim(),
          reason: cleanText(entry.reason) || "unknown",
        };
        const displayName = cleanText(entry.displayName);
        const safeReason = cleanText(entry.safeReason);
        const at = cleanTimestamp(entry.at);
        if (displayName) cleaned.displayName = displayName;
        if (safeReason) cleaned.safeReason = safeReason;
        if (at !== undefined) cleaned.at = at;
        return cleaned;
      })
      .filter((entry): entry is ProviderFallbackEntry => entry !== null)
    : [];
  const activeProviderId = cleanText(fallback?.activeProviderId);
  return {
    active: fallback?.active === true,
    ...(activeProviderId ? { activeProviderId } : {}),
    chain,
  };
}

function normalizeCooldown(cooldown: ProviderCooldownMetadata | null | undefined): ProviderCooldownMetadata {
  const reason = cleanText(cooldown?.reason);
  const safeReason = cleanText(cooldown?.safeReason);
  const until = cleanTimestamp(cooldown?.until);
  return {
    active: cooldown?.active === true,
    ...(reason ? { reason } : {}),
    ...(safeReason ? { safeReason } : {}),
    ...(until !== undefined ? { until } : {}),
  };
}

function needsAuth(auth: ProviderAuthSnapshot): boolean {
  return auth.required && !AUTHENTICATED_STATUSES.has(auth.status);
}

function deriveState(input: {
  configured: boolean;
  disabled: boolean;
  auth: ProviderAuthSnapshot;
  health: ProviderHealthSnapshot;
  fallback: ProviderFallbackMetadata;
  cooldown: ProviderCooldownMetadata;
  errorActive: boolean;
}): ProviderState {
  if (input.disabled) return "disabled";
  if (!input.configured) return "unconfigured";
  if (needsAuth(input.auth)) return "needs_auth";
  if (input.health.status === "checking") return "checking";
  if (input.errorActive || input.health.status === "error" || input.health.status === "unhealthy") return "error";
  if (input.fallback.active) return "fallback_active";
  if (input.cooldown.active) return "cooldown";
  if (input.health.status === "degraded") return "degraded";
  return "ready";
}

function defaultSafeReason(state: ProviderState, input: {
  auth: ProviderAuthSnapshot;
  health: ProviderHealthSnapshot;
  fallback: ProviderFallbackMetadata;
  cooldown: ProviderCooldownMetadata;
  errorReason?: string;
}): string {
  switch (state) {
    case "disabled":
      return "Provider is disabled.";
    case "unconfigured":
      return "Provider is not configured.";
    case "needs_auth":
      return input.auth.safeReason || "Sign in or add credentials to use this provider.";
    case "checking":
      return input.health.safeReason || "Checking provider health.";
    case "error":
      return input.errorReason || input.health.safeReason || "Provider is currently unavailable.";
    case "fallback_active":
      return input.fallback.chain[0]?.safeReason
        || input.cooldown.safeReason
        || "Using a fallback provider.";
    case "cooldown":
      return input.cooldown.safeReason || input.cooldown.reason || "Provider is cooling down.";
    case "degraded":
      return input.health.safeReason || "Provider is responding with degraded health.";
    case "ready":
      return "Provider is ready.";
  }
}

export function deriveProviderSnapshot(input: ProviderSnapshotInput): ProviderSnapshot {
  const id = cleanText(input.id) || "";
  const displayName = cleanText(input.displayName) || id || "Provider";
  const selectedModel = cleanModelRef(input.selectedModel);
  const auth = normalizeAuth(input.auth);
  const health = normalizeHealth(input.health);
  const fallback = normalizeFallback(input.fallback);
  const cooldown = normalizeCooldown(input.cooldown);
  const errorReason = cleanText(input.error?.safeReason);
  const configured = input.configured ?? Boolean(id);
  const disabled = input.disabled === true;
  const state = deriveState({
    configured,
    disabled,
    auth,
    health,
    fallback,
    cooldown,
    errorActive: input.error?.active === true,
  });
  const safeReason = cleanText(input.safeReason)
    || defaultSafeReason(state, { auth, health, fallback, cooldown, errorReason });
  const lastCheckedAt = health.lastCheckedAt;

  return {
    id,
    displayName,
    selectedModel,
    state,
    auth,
    health,
    fallback,
    cooldown,
    ...(lastCheckedAt !== undefined ? { lastCheckedAt } : {}),
    safeReason,
  };
}
