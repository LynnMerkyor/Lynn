/**
 * permissions.ts - read-only view of the CLI permission profile for the GUI (B2).
 * The CLI writes ~/.lynn/permissions/cli.json ({ approval, sandbox }) via
 * `lynn permissions set`. The GUI only READS it; it never mutates the profile or
 * the user's shell config. Defaults to "guarded mode" when no profile exists.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_PERMISSION_PROFILE,
  normalizePermissionProfile,
  type LynnApprovalMode,
  type LynnSandboxMode,
} from "../../shared/permission-profile.js";
import { resolveFleetDataDir } from "./data-dir.js";

export interface PermissionStatus {
  exists: boolean;
  path: string;
  approval: LynnApprovalMode;
  sandbox: LynnSandboxMode;
}

export function permissionProfilePath(home?: string): string {
  return path.join(resolveFleetDataDir(home), "permissions", "cli.json");
}

export async function readPermissionStatus(
  opts: { profilePath?: string; readFile?: (p: string) => Promise<string> } = {},
): Promise<PermissionStatus> {
  const p = opts.profilePath ?? permissionProfilePath();
  const read = opts.readFile ?? ((f: string) => fs.readFile(f, "utf8"));
  try {
    const parsed = normalizePermissionProfile(JSON.parse(await read(p)));
    return {
      exists: true,
      path: p,
      approval: parsed.approval,
      sandbox: parsed.sandbox,
    };
  } catch {
    return { exists: false, path: p, ...DEFAULT_PERMISSION_PROFILE };
  }
}
