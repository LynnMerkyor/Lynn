import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

  return { name: "@lynn/cli", version: "0.0.0-dev" };
}
