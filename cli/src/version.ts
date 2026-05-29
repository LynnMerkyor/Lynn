import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

declare const __LYNN_CLI_NAME__: string | undefined;
declare const __LYNN_CLI_VERSION__: string | undefined;

export interface VersionInfo {
  name: string;
  version: string;
}

export function readVersionInfo(): VersionInfo {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "..", "package.json"),
    path.resolve(here, "..", "..", "package.json"),
    path.resolve(process.cwd(), "cli", "package.json"),
  ];

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf8")) as { name?: unknown; version?: unknown };
      if (parsed?.version) {
        return {
          name: String(parsed.name || "@lynn/cli"),
          version: String(parsed.version),
        };
      }
    } catch {
      // Try the next candidate; bundled CLI path differs from source path.
    }
  }

  if (typeof __LYNN_CLI_VERSION__ === "string" && __LYNN_CLI_VERSION__) {
    return {
      name: typeof __LYNN_CLI_NAME__ === "string" && __LYNN_CLI_NAME__ ? __LYNN_CLI_NAME__ : "@lynn/cli",
      version: __LYNN_CLI_VERSION__,
    };
  }

  return { name: "@lynn/cli", version: "0.0.0-dev" };
}
