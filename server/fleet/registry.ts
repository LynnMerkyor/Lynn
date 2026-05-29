/**
 * registry.ts — default worker-adapter registry (B-line server view).
 *
 * The GUI dispatches through one normalized entry; Lynn's adapter layer maps it to
 * the concrete CLI argv. v0.80 ships a small enabled set; others are present but
 * disabled until their JSONL/permission/cwd behaviour is verified on the machine.
 */
import type { FleetAgentKind } from "../../shared/fleet-events.js";
import fs from "node:fs";
import path from "node:path";

export interface FleetAgentEntry {
  // Keep `| string` so local custom worker ids can be registered without changing
  // the shared protocol for every experiment.
  id: FleetAgentKind | string;
  label: string;
  bin: string;
  supportsJsonl: boolean;
  enabled: boolean;
  available?: boolean;
  availability?: string;
}

export const DEFAULT_FLEET_REGISTRY: FleetAgentEntry[] = [
  { id: "lynn-cli", label: "Lynn CLI", bin: "lynn", supportsJsonl: true, enabled: true },
  // MiMo profiles of the lynn CLI: the MiMo agent/model is selected via the worker
  // brief, not a separate binary, so bin stays `lynn`.
  { id: "mimo-vl", label: "MiMo Vision (mimo-v2.5)", bin: "lynn", supportsJsonl: true, enabled: true },
  { id: "mimo-pro", label: "MiMo Pro (long-endurance)", bin: "lynn", supportsJsonl: true, enabled: true },
  { id: "mimo-fast", label: "MiMo Fast", bin: "lynn", supportsJsonl: true, enabled: true },
  { id: "stepfun-flash", label: "StepFun 3.7 Flash (fast coding)", bin: "lynn", supportsJsonl: true, enabled: true },
  { id: "codex-cli", label: "Codex", bin: "codex", supportsJsonl: true, enabled: true },
  { id: "claude-internal", label: "Claude (internal)", bin: "claude-internal", supportsJsonl: false, enabled: true },
  { id: "claude-code", label: "Claude Code", bin: "claude", supportsJsonl: true, enabled: true },
  { id: "qwen-cli", label: "Qwen", bin: "qwen", supportsJsonl: true, enabled: true },
  { id: "kimi-cli", label: "Kimi", bin: "kimi", supportsJsonl: true, enabled: true },
  { id: "codebuddy", label: "CodeBuddy", bin: "codebuddy", supportsJsonl: true, enabled: true },
  { id: "opencode", label: "OpenCode", bin: "opencode", supportsJsonl: false, enabled: false },
  { id: "custom", label: "Custom", bin: "", supportsJsonl: false, enabled: false },
];

export interface ResolveFleetRegistryOptions {
  pathEnv?: string;
  platform?: NodeJS.Platform;
  fileExists?: (file: string) => boolean;
}

export function resolveFleetRegistry(opts: ResolveFleetRegistryOptions = {}): FleetAgentEntry[] {
  const platform = opts.platform || process.platform;
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? "";
  const fileExists = opts.fileExists ?? defaultFileExists;
  return DEFAULT_FLEET_REGISTRY.map((entry) => {
    if (!entry.enabled) return { ...entry, available: false, availability: "disabled" };
    if (entry.bin === "lynn") {
      return { ...entry, available: true, availability: "bundled Lynn CLI runtime" };
    }
    if (!entry.bin) {
      return { ...entry, available: false, availability: "no command configured" };
    }
    const found = findCommand(entry.bin, { pathEnv, platform, fileExists });
    return {
      ...entry,
      enabled: !!found,
      available: !!found,
      availability: found || "not found on PATH",
    };
  });
}

function findCommand(
  bin: string,
  opts: Required<Pick<ResolveFleetRegistryOptions, "pathEnv" | "platform" | "fileExists">>,
): string | null {
  const candidates = path.isAbsolute(bin) || bin.includes(path.sep)
    ? [bin]
    : opts.pathEnv.split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, bin));
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
