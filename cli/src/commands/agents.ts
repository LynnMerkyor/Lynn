import type { ParsedArgs } from "../args.js";
import { detectCliAgents } from "../agent-registry.js";
import { nowIso, writeJsonLine } from "../jsonl.js";

export function runAgents(_args: ParsedArgs, json: boolean): number {
  const agents = detectCliAgents();
  if (json) {
    writeJsonLine({ type: "agents", ts: nowIso(), agents });
    return 0;
  }

  const lines = ["Lynn worker agents", ""];
  for (const agent of agents) {
    const status = agent.available ? "OK" : "--";
    lines.push(`${status} ${agent.id.padEnd(16)} ${agent.label.padEnd(18)} ${agent.availability}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}
