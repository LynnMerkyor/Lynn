import fs from "node:fs/promises";
import path from "node:path";
import { getStringFlag, type ParsedArgs } from "./args.js";
import { resolveDataDir } from "./session/store.js";
import type { ToolRunContext } from "./tools/types.js";

export type ApprovalMode = ToolRunContext["approval"];
export type SandboxMode = NonNullable<ToolRunContext["sandbox"]>;

export interface PermissionProfile {
  approval: ApprovalMode;
  sandbox: SandboxMode;
}

export interface EffectivePermissions extends PermissionProfile {
  source: "flags" | "env" | "gui-profile" | "default";
  dataDir: string;
  profilePath: string;
  guiProfileFound: boolean;
}

export async function resolveEffectivePermissions(args: ParsedArgs): Promise<EffectivePermissions> {
  const dataDir = resolveDataDir(getStringFlag(args.flags, "data-dir"));
  const profilePath = path.join(dataDir, "permissions", "cli.json");
  const guiProfile = await readPermissionProfile(profilePath);
  const envProfile = readEnvProfile();
  const flagApproval = normalizeApproval(getStringFlag(args.flags, "approval"));
  const flagSandbox = normalizeSandbox(getStringFlag(args.flags, "sandbox"));

  const approval = flagApproval || envProfile.approval || guiProfile?.approval || "ask";
  const sandbox = flagSandbox || envProfile.sandbox || guiProfile?.sandbox || "workspace-write";
  const source = flagApproval || flagSandbox
    ? "flags"
    : envProfile.approval || envProfile.sandbox
      ? "env"
      : guiProfile
        ? "gui-profile"
        : "default";

  return {
    approval,
    sandbox,
    source,
    dataDir,
    profilePath,
    guiProfileFound: !!guiProfile,
  };
}

export function renderPermissions(perms: EffectivePermissions): string {
  const warning = perms.approval === "yolo" || perms.sandbox === "danger-full-access"
    ? "\nWARNING: YOLO/full-access mode can edit files and run shell commands without another prompt."
    : "";
  return [
    "Lynn CLI Permissions",
    "",
    `approval: ${perms.approval}`,
    `sandbox:  ${perms.sandbox}`,
    `source:   ${perms.source}`,
    `data dir: ${perms.dataDir}`,
    `profile:  ${perms.guiProfileFound ? perms.profilePath : `${perms.profilePath} (not found)`}`,
    "",
    "Precedence: CLI flags > env > GUI profile > default.",
    "GUI interop: future GUI Settings > Permissions will write this profile file.",
    warning,
  ].filter(Boolean).join("\n");
}

async function readPermissionProfile(profilePath: string): Promise<PermissionProfile | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(profilePath, "utf8")) as Partial<PermissionProfile>;
    const approval = normalizeApproval(parsed.approval);
    const sandbox = normalizeSandbox(parsed.sandbox);
    return {
      approval: approval || "ask",
      sandbox: sandbox || "workspace-write",
    };
  } catch {
    return null;
  }
}

function readEnvProfile(): Partial<PermissionProfile> {
  const approval = normalizeApproval(process.env.LYNN_CLI_APPROVAL || process.env.LYNN_APPROVAL);
  const sandbox = normalizeSandbox(process.env.LYNN_CLI_SANDBOX || process.env.LYNN_SANDBOX);
  return {
    ...(approval ? { approval } : {}),
    ...(sandbox ? { sandbox } : {}),
  };
}

function normalizeApproval(value: unknown): ApprovalMode | null {
  if (value === "ask" || value === "on-failure" || value === "never" || value === "yolo") return value;
  return null;
}

function normalizeSandbox(value: unknown): SandboxMode | null {
  if (value === "read-only" || value === "workspace-write" || value === "danger-full-access") return value;
  return null;
}
