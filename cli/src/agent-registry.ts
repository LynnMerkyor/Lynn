import fs from "node:fs";
import path from "node:path";
import { cliVisibleAgents } from "../../shared/fleet-agents.js";

export interface CliAgentEntry {
  id: string;
  label: string;
  bin: string;
  enabled: boolean;
  available: boolean;
  availability: string;
  kind: "built-in" | "external";
  requiresPreset?: string;
}

// Agent 名单的唯一事实源在 shared/fleet-agents.ts(server/GUI 同源);这里只做 CLI 视角投影
//(bin 用 cliBin:CLI 自身二进制是大写 Lynn)。
const AGENTS: Array<Omit<CliAgentEntry, "available" | "availability"> & { profileHint?: string }> = cliVisibleAgents().map((agent) => ({
  id: agent.id,
  label: agent.label,
  bin: agent.cliBin,
  enabled: agent.enabled,
  kind: agent.kind,
  ...(agent.profileHint ? { profileHint: agent.profileHint } : {}),
  ...(agent.requiresPreset ? { requiresPreset: agent.requiresPreset } : {}),
}));

export interface DetectCliAgentsOptions {
  pathEnv?: string;
  platform?: NodeJS.Platform;
  fileExists?: (file: string) => boolean;
  configuredPreset?: string | null;
}

export function detectCliAgents(opts: DetectCliAgentsOptions = {}): CliAgentEntry[] {
  const platform = opts.platform || process.platform;
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? "";
  const fileExists = opts.fileExists ?? defaultFileExists;
  return AGENTS.map((agent) => {
    if (agent.kind === "built-in") {
      const { profileHint: _profileHint, ...entry } = agent;
      if (agent.requiresPreset && agent.requiresPreset !== opts.configuredPreset) {
        return {
          ...entry,
          available: false,
          availability: `requires: Lynn providers set --preset ${agent.requiresPreset} --api-key <api-key>`,
        };
      }
      return { ...entry, available: true, availability: agent.profileHint || "current binary" };
    }
    const found = findCommand(agent.bin, { pathEnv, platform, fileExists });
    return {
      ...agent,
      available: !!found,
      availability: found || "not found on PATH",
    };
  });
}

function findCommand(
  bin: string,
  opts: Required<Pick<DetectCliAgentsOptions, "pathEnv" | "platform" | "fileExists">>,
): string | null {
  const pathApi = opts.platform === "win32" ? path.win32 : path.posix;
  const delimiter = opts.platform === "win32" ? ";" : ":";
  const candidates = pathApi.isAbsolute(bin) || bin.includes(pathApi.sep)
    ? [bin]
    : opts.pathEnv.split(delimiter).filter(Boolean).map((dir) => pathApi.join(dir, bin));
  const suffixes = opts.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const candidate of candidates) {
    for (const suffix of suffixes) {
      const file = candidate.endsWith(suffix) ? candidate : `${candidate}${suffix}`;
      if (opts.fileExists(file)) return file;
    }
  }
  return null;
}

function defaultFileExists(file: string): boolean {
  try {
    return !!file && fs.existsSync(file);
  } catch {
    return false;
  }
}
