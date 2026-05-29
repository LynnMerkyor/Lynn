export type LynnApprovalMode = "ask" | "on-failure" | "never" | "yolo";
export type LynnSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface LynnPermissionProfile {
  approval: LynnApprovalMode;
  sandbox: LynnSandboxMode;
}

export const DEFAULT_PERMISSION_PROFILE: LynnPermissionProfile = Object.freeze({
  approval: "ask",
  sandbox: "workspace-write",
});

export function normalizeApprovalMode(value: unknown): LynnApprovalMode | null {
  if (value === "ask" || value === "on-failure" || value === "never" || value === "yolo") return value;
  return null;
}

export function normalizeSandboxMode(value: unknown): LynnSandboxMode | null {
  if (value === "read-only" || value === "workspace-write" || value === "danger-full-access") return value;
  return null;
}

export function normalizePermissionProfile(
  value: unknown,
  fallback: LynnPermissionProfile = DEFAULT_PERMISSION_PROFILE,
): LynnPermissionProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...fallback };
  const record = value as Record<string, unknown>;
  return {
    approval: normalizeApprovalMode(record.approval) || fallback.approval,
    sandbox: normalizeSandboxMode(record.sandbox) || fallback.sandbox,
  };
}

export function isFullAccessPermission(profile: Pick<LynnPermissionProfile, "approval" | "sandbox">): boolean {
  return profile.approval === "yolo" || profile.sandbox === "danger-full-access";
}
