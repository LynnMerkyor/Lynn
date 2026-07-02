#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const nodeBin = process.execPath;

function stringArg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

function run(name, command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || root,
      env: { ...process.env, ...(options.env || {}) },
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => {
      const result = { name, code, stdout, stderr };
      if (code === 0 || options.allowFailure) resolve(result);
      else reject(new Error(`[cli-brain-registration-gate] ${name} failed with exit ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
  });
}

async function existingFile(filePath, label) {
  try {
    await fs.access(filePath);
  } catch {
    throw new Error(`[cli-brain-registration-gate] missing ${label}: ${filePath}`);
  }
}

async function resolveTarball(tmp) {
  const external = stringArg("--tarball-url") || process.env.LYNN_CLI_TARBALL_URL || "";
  if (external) return external;

  const outDir = path.join(tmp, "pack");
  await fs.mkdir(outDir, { recursive: true });
  await run("pack CLI", "npm", ["run", "pack:cli", "--", "--out", outDir]);
  const manifestPath = path.join(outDir, "lynn-cli-package.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const tarball = String(manifest.path || path.join(outDir, manifest.file || ""));
  await existingFile(tarball, "packed CLI tarball");
  return tarball;
}

function parseDoctorJson(result) {
  const raw = result.stdout.trim().split(/\r?\n/).filter(Boolean).pop() || "";
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`[cli-brain-registration-gate] doctor did not return JSON\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
}

async function main() {
  const brainUrl = stringArg("--brain-url") || process.env.LYNN_CLI_BRAIN_GATE_URL || "https://api.merkyorlynn.com/api/v2";
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-cli-brain-registration-"));
  const globalDir = path.join(tmp, "global");
  const cacheDir = path.join(tmp, "npm-cache");
  const lynnHome = path.join(tmp, "home");
  const dataDir = path.join(tmp, "data");
  const installDir = path.join(tmp, "consumer");
  await fs.mkdir(path.join(globalDir, "bin"), { recursive: true });
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(installDir, { recursive: true });

  try {
    const tarball = await resolveTarball(tmp);
    const npmInstallFlags = ["install", "--global", "--prefix", globalDir, "--force", "--silent", "--omit=dev", "--cache", cacheDir, "--prefer-online", tarball];
    await run("install CLI tarball", "npm", npmInstallFlags, { cwd: installDir });

    const lynnBin = process.platform === "win32"
      ? path.join(globalDir, "Lynn.cmd")
      : path.join(globalDir, "bin", "Lynn");
    await existingFile(lynnBin, "installed Lynn bin");

    const version = await run("Lynn version", lynnBin, ["version"], { cwd: installDir });
    if (!version.stdout.includes("@lynn/cli")) {
      throw new Error(`[cli-brain-registration-gate] version output did not prove CLI install\n${version.stdout}`);
    }

    const doctor = await run("fresh-home hosted Brain doctor", lynnBin, ["doctor", "--brain-url", brainUrl, "--json"], {
      cwd: installDir,
      allowFailure: true,
      env: {
        LYNN_HOME: lynnHome,
        LYNN_DATA_DIR: dataDir,
        LYNN_CLI_BRAIN_RETRY_ATTEMPTS: "1",
      },
    });
    const combined = `${doctor.stdout}\n${doctor.stderr}`;
    if (/registration token required|missing device signature headers|401 Unauthorized|403 Forbidden/i.test(combined)) {
      throw new Error(`[cli-brain-registration-gate] fresh CLI registration/auth failed\n${combined}`);
    }

    const parsed = parseDoctorJson(doctor);
    if (doctor.code !== 0 || parsed?.ok !== true || parsed?.brain !== "ok" || parsed?.brainSmoke?.ok !== true) {
      throw new Error(`[cli-brain-registration-gate] hosted Brain smoke failed\nexit=${doctor.code}\n${JSON.stringify(parsed, null, 2)}\nstderr:\n${doctor.stderr}`);
    }

    const prefsPath = path.join(lynnHome, "user", "preferences.json");
    await existingFile(prefsPath, "fresh CLI identity preferences");
    const prefs = JSON.parse(await fs.readFile(prefsPath, "utf8"));
    const key = String(prefs.client_agent_key || "");
    if (!/^ak_[a-f0-9]{24,80}$/i.test(key)) {
      throw new Error("[cli-brain-registration-gate] fresh CLI did not create a valid client_agent_key");
    }
    await existingFile(path.join(lynnHome, "brain-devices", `${key}.json`), "fresh CLI device file");

    const provider = parsed.brainSmoke.provider ? ` via ${parsed.brainSmoke.provider}` : "";
    console.log(`[cli-brain-registration-gate] passed ${parsed.version || ""}${provider}`);
  } finally {
    if (process.env.KEEP_LYNN_CLI_BRAIN_GATE !== "1") {
      await fs.rm(tmp, { recursive: true, force: true });
    } else {
      console.log(`[cli-brain-registration-gate] kept temp dir: ${tmp}`);
    }
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
