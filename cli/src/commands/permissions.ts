import { hasFlag, type ParsedArgs } from "../args.js";
import { nowIso, writeJsonLine } from "../jsonl.js";
import { renderPermissions, resolveEffectivePermissions, savePermissionProfile } from "../permissions.js";

export async function runPermissions(args: ParsedArgs, json = hasFlag(args.flags, "json", "jsonl")): Promise<number> {
  const save = args.positionals[0] === "set" || args.positionals[0] === "write";
  const permissions = save ? await savePermissionProfile(args) : await resolveEffectivePermissions(args);
  if (json) writeJsonLine({ type: save ? "permissions.saved" : "permissions.info", ts: nowIso(), ...permissions });
  else process.stdout.write(`${save ? "Saved CLI permission profile.\n\n" : ""}${renderPermissions(permissions)}\n`);
  return 0;
}
