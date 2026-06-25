import { createRequire } from "node:module";

const requireFromHere = createRequire(import.meta.url);

function packageVersion(): string {
  try {
    const pkg = requireFromHere("../../package.json") as { version?: unknown };
    return String(pkg?.version || "").trim();
  } catch {
    return "";
  }
}

export function currentLynnVersion(): string {
  const value = String(process.env.LYNN_APP_VERSION || process.env.npm_package_version || packageVersion() || "0.0.0").trim();
  return value.replace(/^v/i, "") || "0.85.2";
}

export function currentLynnVersionTag(): string {
  return `v${currentLynnVersion()}`;
}

export function currentLynnCliTarballName(): string {
  return `lynn-cli-${currentLynnVersion()}.tgz`;
}
