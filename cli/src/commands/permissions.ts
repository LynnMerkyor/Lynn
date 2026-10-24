import { getStringFlag, hasFlag, type ParsedArgs } from "../args.js";
import { nowIso, writeJsonLine } from "../jsonl.js";
import { renderPermissions, resolveEffectivePermissions, savePermissionProfile } from "../permissions.js";
import { trustProject } from "../permission-rules.js";
import { t } from "../i18n.js";

export async function runPermissions(args: ParsedArgs, json = hasFlag(args.flags, "json", "jsonl")): Promise<number> {
  if (args.positionals[0] === "trust") {
    const cwd = getStringFlag(args.flags, "cwd") || process.cwd();
    const permissions = await resolveEffectivePermissions(args);
    const file = await trustProject(cwd, permissions.dataDir);
    if (json) {
      writeJsonLine({ type: "permissions.trusted", ts: nowIso(), cwd, registry: file });
    } else {
      process.stdout.write(`${t("permissions.trust.done", { cwd })}\n${t("permissions.trust.registry", { file })}\n`);
      process.stdout.write(`${t("permissions.trust.warning")}\n`);
    }
    return 0;
  }
  const save = args.positionals[0] === "set" || args.positionals[0] === "write";
  const permissions = save ? await savePermissionProfile(args) : await resolveEffectivePermissions(args);
  if (json) writeJsonLine({ type: save ? "permissions.saved" : "permissions.info", ts: nowIso(), ...permissions });
  else process.stdout.write(`${save ? `${t("permissions.saved")}\n\n` : ""}${renderPermissions(permissions)}\n`);
  return 0;
}
