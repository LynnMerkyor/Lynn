export const PROVIDER_STATES = Object.freeze([
  "unconfigured",
  "needs_auth",
  "ready",
  "checking",
  "degraded",
  "cooldown",
  "fallback_active",
  "disabled",
  "error",
] as const);

export type ProviderState = (typeof PROVIDER_STATES)[number];

export const PROVIDER_AUTH_STATUSES = Object.freeze([
  "not_required",
  "unknown",
  "authenticated",
  "missing",
  "expired",
  "invalid",
] as const);

export type ProviderAuthStatus = (typeof PROVIDER_AUTH_STATUSES)[number];

export const PROVIDER_HEALTH_STATUSES = Object.freeze([
  "unknown",
  "healthy",
  "checking",
  "degraded",
  "unhealthy",
  "error",
] as const);

export type ProviderHealthStatus = (typeof PROVIDER_HEALTH_STATUSES)[number];

export type ProviderTimestamp = number | string;

export interface ProviderModelRef {
  id: string;
  providerId?: string;
  displayName?: string;
}

export interface ProviderAuthInput {
  required: boolean;
  status: ProviderAuthStatus;
  safeReason?: string | null;
}

export interface ProviderAuthSnapshot {
  required: boolean;
  status: ProviderAuthStatus;
  safeReason?: string;
}

export interface ProviderHealthInput {
  status: ProviderHealthStatus;
  lastCheckedAt?: ProviderTimestamp | null;
  safeReason?: string | null;
}

export interface ProviderHealthSnapshot {
  status: ProviderHealthStatus;
  lastCheckedAt?: ProviderTimestamp;
  safeReason?: string;
}

export type ProviderFallbackReason =
  | "cooldown"
  | "probe_failed"
  | "auth_missing"
  | "error"
  | "empty_response"
  | "manual"
  | "unknown";

export interface ProviderFallbackEntry {
  providerId: string;
  displayName?: string;
  reason: ProviderFallbackReason | string;
  safeReason?: string;
  at?: ProviderTimestamp;
}

export interface ProviderFallbackMetadata {
  active: boolean;
  activeProviderId?: string;
  chain: readonly ProviderFallbackEntry[];
}

export interface ProviderCooldownMetadata {
  active: boolean;
  reason?: string;
  safeReason?: string;
  until?: ProviderTimestamp;
}

export interface ProviderErrorMetadata {
  active: boolean;
  code?: string;
  safeReason?: string | null;
}

export interface ProviderSnapshotInput {
  id: string;
  displayName: string;
  configured?: boolean;
  disabled?: boolean;
  selectedModel?: ProviderModelRef | null;
  auth?: ProviderAuthInput | null;
  health?: ProviderHealthInput | null;
  fallback?: ProviderFallbackMetadata | null;
  cooldown?: ProviderCooldownMetadata | null;
  error?: ProviderErrorMetadata | null;
  safeReason?: string | null;
}

export interface ProviderSnapshot {
  id: string;
  displayName: string;
  selectedModel: ProviderModelRef | null;
  state: ProviderState;
  auth: ProviderAuthSnapshot;
  health: ProviderHealthSnapshot;
  fallback: ProviderFallbackMetadata;
  cooldown: ProviderCooldownMetadata;
  lastCheckedAt?: ProviderTimestamp;
  safeReason: string;
}
