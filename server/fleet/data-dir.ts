import os from "node:os";
import path from "node:path";

export function resolveFleetDataDir(explicit?: string | null, env: NodeJS.ProcessEnv = process.env): string {
  const raw = explicit?.trim() || env.LYNN_DATA_DIR?.trim() || env.LYNN_HOME?.trim() || path.join(os.homedir(), ".lynn");
  const expanded = raw.startsWith("~") ? path.join(os.homedir(), raw.slice(1)) : raw;
  return path.resolve(expanded);
}
