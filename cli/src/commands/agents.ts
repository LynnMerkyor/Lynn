import type { ParsedArgs } from "../args.js";
import { detectCliAgents } from "../agent-registry.js";
import { nowIso, writeJsonLine } from "../jsonl.js";
import { presetNameForProviderProfile } from "../provider-presets.js";
import { resolveCliProviderProfile } from "../provider-profile.js";
import { t } from "../i18n.js";
import { readVersionInfo } from "../version.js";

function installUrl(): string {
  const build = readVersionInfo().build;
  const suffix = build ? `?build=${encodeURIComponent(build)}` : "";
  return `https://download.merkyorlynn.com/downloads/cli/lynn-cli-latest.tgz${suffix}`;
}

export async function runAgents(args: ParsedArgs, json: boolean): Promise<number> {
  const profile = await resolveCliProviderProfile(args);
  const configuredPreset = presetNameForProviderProfile(profile?.profile);
  const agents = detectCliAgents({ configuredPreset });
  if (json) {
    writeJsonLine({ type: "agents", ts: nowIso(), agents });
    return 0;
  }

  const lines = [t("agents.title"), ""];
  for (const agent of agents) {
    const status = agent.available ? "OK" : "--";
    const kind = agent.kind === "built-in" ? "profile" : "external";
    lines.push(`${status} ${agent.id.padEnd(16)} ${kind.padEnd(8)} ${agent.label.padEnd(30)} ${agent.availability}`);
  }
  lines.push("", t("agents.headless.title"));
  lines.push(`  ${t("agents.node.prereq")}`);
  lines.push(`  ${t("agents.install.title")}`);
  lines.push(`  npm install -g --force ${installUrl()}`);
  lines.push("");
  lines.push(`  ${t("agents.launch.title")}`);
  lines.push(`  Lynn`);
  lines.push(`  Lynn code`);
  lines.push(`  Lynn agents`);
  lines.push("");
  lines.push(`  ${t("agents.headless.commands")}`);
  lines.push(`  Lynn code -p "fix tests" --json --cwd /repo --approval yolo --sandbox workspace-write --save-session`);
  lines.push(`  Lynn worker run --brief task.md --worktree /repo --jsonl --approval yolo --sandbox workspace-write`);
  lines.push(`  Lynn worker run --brief task.md --worktree /repo --agent custom --agent-command "your command" --jsonl`);
  lines.push("", t("agents.tip"));
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}
