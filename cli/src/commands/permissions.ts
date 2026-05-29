import { hasFlag, type ParsedArgs } from "../args.js";
import { nowIso, writeJsonLine } from "../jsonl.js";
import { renderPermissions, resolveEffectivePermissions } from "../permissions.js";

export async function runPermissions(args: ParsedArgs, json = hasFlag(args.flags, "json", "jsonl")): Promise<number> {
  const permissions = await resolveEffectivePermissions(args);
  if (json) writeJsonLine({ type: "permissions.info", ts: nowIso(), ...permissions });
  else process.stdout.write(`${renderPermissions(permissions)}\n`);
  return 0;
}

