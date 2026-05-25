import os from "os";
import path from "path";

export type TrustedRootsPrefs = {
  setupComplete?: unknown;
  home_folder?: unknown;
  trusted_roots?: unknown;
  desk?: {
    home_folder?: unknown;
    trusted_roots?: unknown;
  } | null;
};

export type WorkspaceRootsConfig = {
  cwd_history?: unknown;
  last_cwd?: unknown;
};

function normalizeKey(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

export function getDefaultDesktopRoot(): string {
  return path.join(os.homedir(), "Desktop");
}

function isLegacyDesktopWorkspaceSeed(prefs: TrustedRootsPrefs | null | undefined = {}, configuredRoots: string[] | null = null): boolean {
  if (prefs?.setupComplete === true) return false;

  const desktopRoot = getDefaultDesktopRoot();
  const topLevelHome = normalizeTrustedRoot(prefs?.home_folder);
  const deskHome = normalizeTrustedRoot(prefs?.desk?.home_folder);
  const topLevelRoots = configuredRoots ?? uniqueTrustedRoots(
    Array.isArray(prefs?.trusted_roots) ? prefs.trusted_roots as unknown[] : []
  );
  const deskRoots = uniqueTrustedRoots(
    Array.isArray(prefs?.desk?.trusted_roots) ? prefs.desk.trusted_roots as unknown[] : []
  );

  if (deskHome || deskRoots.length > 0) return false;

  const usesDesktopHome = topLevelHome === desktopRoot;
  const usesOnlyDesktopRoots = topLevelRoots.length > 0 && topLevelRoots.every((root) => root === desktopRoot);
  const hasOnlyLegacyTopLevelRoots = topLevelRoots.length === 0 || usesOnlyDesktopRoots;

  return hasOnlyLegacyTopLevelRoots && (usesDesktopHome || usesOnlyDesktopRoots);
}

export function normalizeTrustedRoot(rawPath: unknown): string | null {
  if (typeof rawPath !== "string") return null;
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.includes("\0")) return null;
  const expanded = trimmed.replace(/^~(?=$|[\\/])/, os.homedir());
  return path.resolve(expanded);
}

export function uniqueTrustedRoots(paths?: Iterable<unknown> | null): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of paths || []) {
    const normalized = normalizeTrustedRoot(entry);
    if (!normalized) continue;
    const key = normalizeKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

export function getConfiguredTrustedRoots(prefs: TrustedRootsPrefs | null | undefined = {}): string[] {
  const configuredRoots = uniqueTrustedRoots([
    ...(Array.isArray(prefs?.trusted_roots) ? prefs.trusted_roots as unknown[] : []),
    ...(Array.isArray(prefs?.desk?.trusted_roots) ? prefs.desk.trusted_roots as unknown[] : []),
  ]);
  return isLegacyDesktopWorkspaceSeed(prefs, configuredRoots) ? [] : configuredRoots;
}

export function getPreferredHomeFolder(prefs: TrustedRootsPrefs | null | undefined = {}): string | null {
  const configured = normalizeTrustedRoot(prefs?.home_folder)
    || normalizeTrustedRoot(prefs?.desk?.home_folder);
  if (!configured) return null;
  return isLegacyDesktopWorkspaceSeed(prefs) ? null : configured;
}

export function getBaselineTrustedRoots(prefs: TrustedRootsPrefs | null | undefined = {}): string[] {
  return uniqueTrustedRoots([getPreferredHomeFolder(prefs)]);
}

export function getEffectiveTrustedRoots(prefs: TrustedRootsPrefs | null | undefined = {}): string[] {
  return uniqueTrustedRoots([
    ...getBaselineTrustedRoots(prefs),
    ...getConfiguredTrustedRoots(prefs),
  ]);
}

export function getWorkspaceRoots(config: WorkspaceRootsConfig | null | undefined = {}, prefs: TrustedRootsPrefs | null | undefined = {}): string[] {
  const history = Array.isArray(config?.cwd_history) ? config.cwd_history as unknown[] : [];
  return uniqueTrustedRoots([
    ...getEffectiveTrustedRoots(prefs),
    config?.last_cwd,
    ...history,
  ]);
}
