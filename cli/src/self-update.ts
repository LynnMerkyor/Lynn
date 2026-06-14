import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { getStringFlag, hasFlag, type ParsedArgs } from "./args.js";
import { t } from "./i18n.js";
import type { VersionInfo } from "./version.js";

export interface CliUpdateManifest {
  version: string;
  build?: string;
  tarballUrl: string;
  sha256?: string;
  notesUrl?: string;
}

export interface CliUpdateCheck {
  available: boolean;
  manifest?: CliUpdateManifest;
  reason?: string;
}

const DEFAULT_MANIFEST_URL = "https://download.merkyorlynn.com/downloads/cli/lynn-cli-latest.json";
const DEFAULT_TARBALL_URL = "https://download.merkyorlynn.com/downloads/cli/lynn-cli-latest.tgz";
const SHA256_RE = /^[a-f0-9]{64}$/i;

export function isInteractiveUpdateCommand(args: ParsedArgs): boolean {
  if (hasFlag(args.flags, "json", "jsonl", "help", "h")) return false;
  if (args.command === "chat") return true;
  if (args.command !== "code") return false;
  if (hasFlag(args.flags, "p", "print", "prompt", "tool", "list-tools")) return false;
  if (getStringFlag(args.flags, "resume")) return false;
  return args.positionals.length === 0;
}

export function isUpdateNewer(current: VersionInfo, manifest: CliUpdateManifest): boolean {
  const versionDelta = compareVersions(manifest.version, current.version);
  if (versionDelta > 0) return true;
  if (versionDelta < 0) return false;
  if (!manifest.build) return false;
  return manifest.build !== current.build;
}

export async function checkCliUpdate(
  current: VersionInfo,
  opts: {
    manifestUrl?: string;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<CliUpdateCheck> {
  const env = opts.env || process.env;
  if (isUpdateCheckSuppressed(env)) {
    return { available: false, reason: "disabled" };
  }
  const fetchImpl = opts.fetchImpl || fetch;
  const manifestUrl = env.LYNN_CLI_UPDATE_MANIFEST_URL || opts.manifestUrl || DEFAULT_MANIFEST_URL;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 700);
  try {
    const response = await fetchImpl(manifestUrl, { signal: controller.signal });
    if (!response.ok) return { available: false, reason: `http ${response.status}` };
    const manifest = normalizeManifest(await response.json() as Partial<CliUpdateManifest>);
    if (!manifest) return { available: false, reason: "invalid manifest" };
    return isUpdateNewer(current, manifest)
      ? { available: true, manifest }
      : { available: false, manifest, reason: "current" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { available: false, reason: message || "check failed" };
  } finally {
    clearTimeout(timer);
  }
}

export async function maybePromptForCliUpdate(
  args: ParsedArgs,
  current: VersionInfo,
  opts: {
    stdin?: Readable & { isTTY?: boolean };
    stdout?: Writable & { isTTY?: boolean };
    stderr?: Writable;
    env?: NodeJS.ProcessEnv;
    check?: (current: VersionInfo) => Promise<CliUpdateCheck>;
    install?: (manifest: CliUpdateManifest) => Promise<number>;
  } = {},
): Promise<void> {
  const stdin = opts.stdin || process.stdin;
  const stdout = opts.stdout || process.stdout;
  const stderr = opts.stderr || process.stderr;
  const env = opts.env || process.env;
  if (!stdin.isTTY || !stdout.isTTY || !isInteractiveUpdateCommand(args)) return;
  if (isUpdateCheckSuppressed(env)) return;
  const result = await (opts.check || ((info) => checkCliUpdate(info, { env: opts.env })))(current);
  if (!result.available || !result.manifest) return;
  if (isSameVersionBuildUpdate(current, result.manifest) && env.LYNN_CLI_PROMPT_BUILD_UPDATES !== "1") return;

  const suffix = result.manifest.build ? ` (${result.manifest.build})` : "";
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(`${t("update.available", { version: result.manifest.version, build: suffix })} `);
    if (!/^(?:y(?:es)?|是|好|更新)$/i.test(answer.trim())) {
      stdout.write(`${t("update.skipped")}\n`);
      return;
    }
  } finally {
    rl.close();
  }

  stdout.write(`${t("update.installing")}\n`);
  try {
    const code = await (opts.install || installCliUpdate)(result.manifest);
    if (code === 0) stdout.write(`${t("update.installed")}\n`);
    else stderr.write(`${t("update.failed", { message: `npm exited ${code}` })}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`${t("update.failed", { message })}\n`);
  }
}

function isSameVersionBuildUpdate(current: VersionInfo, manifest: CliUpdateManifest): boolean {
  return compareVersions(manifest.version, current.version) === 0
    && !!manifest.build
    && !!current.build
    && manifest.build !== current.build;
}

function isUpdateCheckSuppressed(env: NodeJS.ProcessEnv): boolean {
  return env.LYNN_CLI_UPDATE_CHECK === "0"
    || env.LYNN_CLI_NO_UPDATE_CHECK === "1"
    || env.CI === "1"
    || env.VITEST === "true"
    || env.NODE_ENV === "test";
}

export async function installCliUpdate(manifest: CliUpdateManifest): Promise<number> {
  const verified = await downloadVerifiedCliUpdateTarball(manifest);
  try {
    return await runNpmGlobalInstall(verified.tarballPath);
  } finally {
    verified.cleanup();
  }
}

export function verifyCliUpdateTarballBytes(bytes: Uint8Array, expectedSha256: string): string {
  const expected = normalizeSha256(expectedSha256);
  if (!expected) {
    throw new Error("CLI update manifest has invalid sha256");
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    throw new Error(`CLI update sha256 mismatch: expected ${expected}, got ${actual}`);
  }
  return actual;
}

async function downloadVerifiedCliUpdateTarball(
  manifest: CliUpdateManifest,
  fetchImpl: typeof fetch = fetch,
): Promise<{ tarballPath: string; cleanup: () => void }> {
  const expected = normalizeSha256(manifest.sha256);
  if (!expected) {
    throw new Error("CLI update manifest is missing a valid sha256");
  }
  const response = await fetchImpl(manifest.tarballUrl || DEFAULT_TARBALL_URL);
  if (!response.ok) {
    throw new Error(`CLI update download failed: HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  verifyCliUpdateTarballBytes(bytes, expected);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-cli-update-"));
  const tarballPath = path.join(dir, "lynn-cli-update.tgz");
  fs.writeFileSync(tarballPath, bytes);
  return {
    tarballPath,
    cleanup: () => {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function runNpmGlobalInstall(target: string): Promise<number> {
  const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
  return new Promise((resolve, reject) => {
    const child = spawn(npmBin, ["install", "-g", "--force", target], {
      stdio: "inherit",
      env: process.env,
    });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

function normalizeManifest(raw: Partial<CliUpdateManifest>): CliUpdateManifest | null {
  if (!raw || typeof raw.version !== "string" || !raw.version.trim()) return null;
  const rawWithUrl = raw as Partial<CliUpdateManifest> & { url?: unknown };
  const tarballUrl = typeof raw.tarballUrl === "string" && raw.tarballUrl.trim()
    ? raw.tarballUrl.trim()
    : typeof rawWithUrl.url === "string" && rawWithUrl.url.trim()
      ? rawWithUrl.url.trim()
    : DEFAULT_TARBALL_URL;
  return {
    version: raw.version.trim(),
    build: typeof raw.build === "string" && raw.build.trim() ? raw.build.trim() : undefined,
    tarballUrl,
    sha256: normalizeSha256(raw.sha256) || undefined,
    notesUrl: typeof raw.notesUrl === "string" ? raw.notesUrl : undefined,
  };
}

function normalizeSha256(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return SHA256_RE.test(normalized) ? normalized : null;
}

function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    const delta = (a.core[index] || 0) - (b.core[index] || 0);
    if (delta !== 0) return delta > 0 ? 1 : -1;
  }
  if (a.pre === b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  return a.pre > b.pre ? 1 : -1;
}

function parseVersion(value: string): { core: number[]; pre: string } {
  const [coreText = "", pre = ""] = value.replace(/^v/i, "").trim().split("-", 2);
  return {
    core: coreText.split(".").map((part) => Number.parseInt(part, 10) || 0).slice(0, 3),
    pre,
  };
}
