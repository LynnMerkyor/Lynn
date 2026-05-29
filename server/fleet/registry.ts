/**
 * registry.ts — default worker-adapter registry (B-line server view).
 *
 * The GUI dispatches through one normalized entry; Lynn's adapter layer maps it to
 * the concrete CLI argv. v0.80 ships a small enabled set; others are present but
 * disabled until their JSONL/permission/cwd behaviour is verified on the machine.
 */
import fs from "node:fs";
import path from "node:path";
import type { FleetAgentKind } from "../../shared/fleet-events.js";

export interface FleetAgentEntry {
  id: FleetAgentKind;
  label: string;
  bin: string;
  supportsJsonl: boolean;
  enabled: boolean;
  available?: boolean;
  availability?: string;
}

export interface FleetRegistryAvailabilityOptions {
  pathEnv?: string;
  platform?: NodeJS.Platform;
  fileExists?: (file: string) => boolean;
  lynnCliAvailable?: boolean;
}

export const DEFAULT_FLEET_REGISTRY: FleetAgentEntry[] = [
  { id: "lynn-cli", label: "Lynn CLI", bin: "Lynn", supportsJsonl: true, enabled: true },
  { id: "codex-cli", label: "Codex", bin: "codex", supportsJsonl: true, enabled: true },
  { id: "claude-internal", label: "Claude (internal)", bin: "claude-internal", supportsJsonl: false, enabled: true },
  { id: "claude-code", label: "Claude Code", bin: "claude", supportsJsonl: true, enabled: true },
  { id: "qwen-cli", label: "Qwen", bin: "qwen", supportsJsonl: false, enabled: true },
  { id: "kimi-cli", label: "Kimi", bin: "kimi", supportsJsonl: false, enabled: false },
  { id: "codebuddy", label: "CodeBuddy", bin: "codebuddy", supportsJsonl: false, enabled: false },
  { id: "opencode", label: "OpenCode", bin: "opencode", supportsJsonl: true, enabled: false },
  { id: "custom", label: "Custom", bin: "", supportsJsonl: false, enabled: false },
];

export function withFleetRegistryAvailability(
  entries: FleetAgentEntry[] = DEFAULT_FLEET_REGISTRY,
  opts: FleetRegistryAvailabilityOptions = {},
): FleetAgentEntry[] {
  const platform = opts.platform || process.platform;
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? "";
  const fileExists = opts.fileExists ?? defaultFileExists;
  return entries.map((entry) => {
    if (!entry.enabled) return { ...entry, available: false, availability: "disabled" };
    if (entry.id === "lynn-cli") {
      const available = opts.lynnCliAvailable ?? true;
      return { ...entry, available, availability: available ? "bundled" : "cli bundle unavailable" };
    }
    if (!entry.bin) return { ...entry, available: false, availability: "no command configured" };
    const found = findCommand(entry.bin, { pathEnv, platform, fileExists });
    return {
      ...entry,
      available: !!found,
      availability: found || "not found on PATH",
    };
  });
}

function findCommand(
  bin: string,
  opts: Required<Pick<FleetRegistryAvailabilityOptions, "pathEnv" | "platform" | "fileExists">>,
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
