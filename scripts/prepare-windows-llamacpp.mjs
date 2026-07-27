#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SPEC_PATH = path.join(ROOT, "build", "windows-llamacpp-runtime.json");
const TARGET_DIR = path.join(ROOT, "vendor", "llama.cpp", "win-x64");
const RUNTIME_MANIFEST = "runtime-manifest.json";
const verifyOnly = process.argv.includes("--verify-only");

async function sha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function verifyFile(filePath, expected, label) {
  const stat = await fs.stat(filePath);
  if (stat.size !== expected.size) {
    throw new Error(`${label} size mismatch: expected ${expected.size}, got ${stat.size}`);
  }
  const digest = await sha256(filePath);
  if (digest !== expected.sha256) {
    throw new Error(`${label} SHA-256 mismatch: expected ${expected.sha256}, got ${digest}`);
  }
}

async function download(url, outputPath) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`download failed (${response.status}) for ${url}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(outputPath, { flags: "wx" }));
}

async function extractZip(zipPath, outputDir) {
  if (process.platform === "win32") {
    const escapedZip = zipPath.replaceAll("'", "''");
    const escapedOutput = outputDir.replaceAll("'", "''");
    await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Expand-Archive -LiteralPath '${escapedZip}' -DestinationPath '${escapedOutput}' -Force`,
    ], { windowsHide: true });
    return;
  }
  await execFileAsync("unzip", ["-q", zipPath, "-d", outputDir]);
}

async function verifyPortableExecutable(filePath) {
  const handle = await fs.open(filePath, "r");
  try {
    const magic = Buffer.alloc(2);
    await handle.read(magic, 0, magic.length, 0);
    if (magic.toString("ascii") !== "MZ") {
      throw new Error(`${path.basename(filePath)} is not a Windows PE file`);
    }
  } finally {
    await handle.close();
  }
}

async function buildRuntimeManifest(spec, runtimeDir) {
  const files = {};
  for (const name of [...spec.files, spec.license.name]) {
    const filePath = path.join(runtimeDir, name);
    const stat = await fs.stat(filePath);
    files[name] = { size: stat.size, sha256: await sha256(filePath) };
  }
  return {
    schemaVersion: 1,
    sourceTag: spec.tag,
    sourceArchive: spec.archive.name,
    sourceArchiveSize: spec.archive.size,
    sourceArchiveSha256: spec.archive.sha256,
    files,
  };
}

async function verifyRuntime(spec, runtimeDir) {
  const manifestPath = path.join(runtimeDir, RUNTIME_MANIFEST);
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (
    manifest.schemaVersion !== 1
    || manifest.sourceTag !== spec.tag
    || manifest.sourceArchive !== spec.archive.name
    || manifest.sourceArchiveSize !== spec.archive.size
    || manifest.sourceArchiveSha256 !== spec.archive.sha256
  ) {
    throw new Error("runtime manifest does not match the pinned llama.cpp source");
  }

  const expectedNames = [...spec.files, spec.license.name].sort();
  const manifestNames = Object.keys(manifest.files || {}).sort();
  if (JSON.stringify(manifestNames) !== JSON.stringify(expectedNames)) {
    throw new Error("runtime manifest file list does not match the allowlist");
  }

  const directoryNames = (await fs.readdir(runtimeDir))
    .filter((name) => name !== RUNTIME_MANIFEST)
    .sort();
  if (JSON.stringify(directoryNames) !== JSON.stringify(expectedNames)) {
    throw new Error("runtime directory contains missing or unexpected files");
  }

  for (const name of expectedNames) {
    await verifyFile(path.join(runtimeDir, name), manifest.files[name], name);
    if (name.endsWith(".exe") || name.endsWith(".dll")) {
      await verifyPortableExecutable(path.join(runtimeDir, name));
    }
  }
  await verifyFile(path.join(runtimeDir, spec.license.name), spec.license, spec.license.name);
  return manifest;
}

async function main() {
  const spec = JSON.parse(await fs.readFile(SPEC_PATH, "utf8"));
  if (verifyOnly) {
    await verifyRuntime(spec, TARGET_DIR);
    console.log(`[llama.cpp] verified ${spec.tag} Windows x64 runtime at ${TARGET_DIR}`);
    return;
  }

  try {
    await verifyRuntime(spec, TARGET_DIR);
    console.log(`[llama.cpp] verified existing ${spec.tag} Windows x64 runtime; download skipped`);
    return;
  } catch {
    // Missing or stale runtime: rebuild it atomically from the pinned source.
  }

  await fs.mkdir(path.dirname(TARGET_DIR), { recursive: true });
  const workDir = await fs.mkdtemp(path.join(path.dirname(TARGET_DIR), ".prepare-"));
  const archivePath = path.join(workDir, spec.archive.name);
  const extractedDir = path.join(workDir, "extracted");
  const stagingDir = path.join(workDir, "runtime");
  const licensePath = path.join(stagingDir, spec.license.name);
  try {
    await fs.mkdir(extractedDir, { recursive: true });
    await fs.mkdir(stagingDir, { recursive: true });

    console.log(`[llama.cpp] downloading pinned ${spec.tag} Windows x64 runtime`);
    await download(spec.archive.url, archivePath);
    await verifyFile(archivePath, spec.archive, spec.archive.name);
    await extractZip(archivePath, extractedDir);

    for (const name of spec.files) {
      await fs.copyFile(path.join(extractedDir, name), path.join(stagingDir, name));
      await verifyPortableExecutable(path.join(stagingDir, name));
    }

    await download(spec.license.url, licensePath);
    await verifyFile(licensePath, spec.license, spec.license.name);

    const runtimeManifest = await buildRuntimeManifest(spec, stagingDir);
    await fs.writeFile(
      path.join(stagingDir, RUNTIME_MANIFEST),
      `${JSON.stringify(runtimeManifest, null, 2)}\n`,
      "utf8",
    );
    await verifyRuntime(spec, stagingDir);

    await fs.mkdir(path.dirname(TARGET_DIR), { recursive: true });
    await fs.rm(TARGET_DIR, { recursive: true, force: true });
    await fs.rename(stagingDir, TARGET_DIR);
    await verifyRuntime(spec, TARGET_DIR);
    console.log(`[llama.cpp] ready: ${spec.files.length} binaries plus MIT license`);
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[llama.cpp] prepare failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
