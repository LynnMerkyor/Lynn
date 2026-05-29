import fs from "node:fs";
import path from "node:path";

export interface CliAgentEntry {
  id: string;
  label: string;
  bin: string;
  enabled: boolean;
  available: boolean;
  availability: string;
}

const AGENTS: Array<Omit<CliAgentEntry, "available" | "availability">> = [
  { id: "lynn-cli", label: "Lynn CLI", bin: "Lynn", enabled: true },
  { id: "codex-cli", label: "Codex", bin: "codex", enabled: true },
  { id: "claude-code", label: "Claude Code", bin: "claude", enabled: true },
  { id: "claude-internal", label: "Claude (internal)", bin: "claude-internal", enabled: true },
  { id: "qwen-cli", label: "Qwen", bin: "qwen", enabled: true },
  { id: "kimi-cli", label: "Kimi", bin: "kimi", enabled: true },
  { id: "opencode", label: "OpenCode", bin: "opencode", enabled: true },
  { id: "codebuddy", label: "CodeBuddy", bin: "codebuddy", enabled: true },
];

export interface DetectCliAgentsOptions {
  pathEnv?: string;
  platform?: NodeJS.Platform;
  fileExists?: (file: string) => boolean;
}

export function detectCliAgents(opts: DetectCliAgentsOptions = {}): CliAgentEntry[] {
  const platform = opts.platform || process.platform;
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? "";
  const fileExists = opts.fileExists ?? defaultFileExists;
  return AGENTS.map((agent) => {
    if (agent.id === "lynn-cli") {
      return { ...agent, available: true, availability: "current binary" };
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
  const candidates = path.isAbsolute(bin) || bin.includes(path.sep) ? [bin] : opts.pathEnv.split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, bin));
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
