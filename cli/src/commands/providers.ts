import { type ParsedArgs, hasFlag } from "../args.js";
import { nowIso, writeJsonLine } from "../jsonl.js";

export interface ProvidersInfo {
  defaultRoute: string;
  byokEntry: string;
  keyPolicy: string;
  brainUrl: string;
}

export function providersInfo(): ProvidersInfo {
  return {
    defaultRoute: "MiMo via local Brain router (auto)",
    byokEntry: "Open Lynn GUI > Settings > Providers",
    keyPolicy: "Provider keys stay in Lynn settings/server storage; the CLI does not print or store them.",
    brainUrl: process.env.LYNN_BRAIN_URL || "http://127.0.0.1:8790",
  };
}

export function renderProvidersInfo(info: ProvidersInfo): string {
  return [
    "Lynn Providers / BYOK",
    "",
    `Default route: ${info.defaultRoute}`,
    `Brain URL:      ${info.brainUrl}`,
    `BYOK entry:     ${info.byokEntry}`,
    "",
    info.keyPolicy,
    "",
    "After you add a provider in the GUI, Lynn CLI will use it through the same local Brain/router path.",
    "Use Lynn model or /model in chat to review this route. Use --brain-url to point at another local endpoint.",
  ].join("\n");
}

export function runProviders(args: ParsedArgs, json = hasFlag(args.flags, "json", "jsonl")): number {
  const info = providersInfo();
  if (json) {
    writeJsonLine({ type: "providers.info", ts: nowIso(), ...info });
  } else {
    process.stdout.write(`${renderProvidersInfo(info)}\n`);
  }
  return 0;
}
