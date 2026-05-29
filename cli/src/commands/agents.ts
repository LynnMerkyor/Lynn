import type { ParsedArgs } from "../args.js";
import { detectCliAgents } from "../agent-registry.js";
import { nowIso, writeJsonLine } from "../jsonl.js";
import { presetNameForProviderProfile } from "../provider-presets.js";
import { resolveCliProviderProfile } from "../provider-profile.js";

export async function runAgents(args: ParsedArgs, json: boolean): Promise<number> {
  const profile = await resolveCliProviderProfile(args);
  const configuredPreset = presetNameForProviderProfile(profile?.profile);
  const agents = detectCliAgents({ configuredPreset });
  if (json) {
    writeJsonLine({ type: "agents", ts: nowIso(), agents });
    return 0;
  }

  const lines = ["Lynn worker agents", ""];
  for (const agent of agents) {
    const status = agent.available ? "OK" : "--";
    const kind = agent.kind === "built-in" ? "profile" : "external";
    lines.push(`${status} ${agent.id.padEnd(16)} ${kind.padEnd(8)} ${agent.label.padEnd(30)} ${agent.availability}`);
  }
  lines.push("", "Tip: built-in profiles run through Lynn worker run; external agents must be installed on PATH.");
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}
