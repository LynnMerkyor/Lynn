#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const cliRoot = path.join(root, "cli");
const nodeBin = process.execPath;

function run(name, command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || root,
      env: { ...process.env, ...(options.env || {}) },
      shell: process.platform === "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => {
      const result = { name, code, stdout, stderr };
      if (code === 0) {
        resolve(result);
      } else {
        reject(new Error(`[cli-install-smoke] ${name} failed with exit ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      }
    });
    if (typeof options.stdin === "string") child.stdin.end(options.stdin);
    else child.stdin.end();
  });
}

function assertIncludes(name, text, needle) {
  if (!text.includes(needle)) {
    throw new Error(`[cli-install-smoke] ${name} output did not include ${JSON.stringify(needle)}\n${text}`);
  }
}

function assertNotIncludes(name, text, needle) {
  if (text.includes(needle)) {
    throw new Error(`[cli-install-smoke] ${name} output unexpectedly included ${JSON.stringify(needle)}\n${text}`);
  }
}

function binPath(installDir, name) {
  return process.platform === "win32"
    ? path.join(installDir, "node_modules", ".bin", `${name}.cmd`)
    : path.join(installDir, "node_modules", ".bin", name);
}

async function existingBin(installDir, names) {
  for (const name of names) {
    const candidate = binPath(installDir, name);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next spelling. npm on case-insensitive filesystems may only
      // materialize one of Lynn/lynn even when both are declared.
    }
  }
  throw new Error(`[cli-install-smoke] none of these CLI bins exist: ${names.join(", ")}`);
}

await fs.access(path.join(cliRoot, "package.json")).catch(() => {
  throw new Error("[cli-install-smoke] missing cli/package.json; run from repo root");
});

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-cli-install-smoke-"));
const packDir = path.join(tmp, "pack");
const installDir = path.join(tmp, "consumer");
const globalDir = path.join(tmp, "global");
const dataDir = path.join(tmp, "data");
await fs.mkdir(packDir, { recursive: true });
await fs.mkdir(installDir, { recursive: true });
await fs.mkdir(path.join(globalDir, "bin"), { recursive: true });
await fs.mkdir(dataDir, { recursive: true });

try {
  const packed = await run("npm pack", "npm", ["pack", "--pack-destination", packDir, "--silent"], { cwd: cliRoot });
  const tarballName = packed.stdout.trim().split(/\r?\n/).filter(Boolean).pop();
  if (!tarballName) throw new Error("[cli-install-smoke] npm pack did not report a tarball");
  const tarball = path.join(packDir, tarballName);
  await fs.access(tarball);

  await fs.writeFile(path.join(installDir, "package.json"), JSON.stringify({ private: true, type: "module" }, null, 2), "utf8");
  await run("npm install packed CLI", "npm", ["install", "--silent", "--omit=dev", tarball], { cwd: installDir });

  // Global testers often already have an older lynn shim in PATH. The public
  // install command intentionally uses --force so npm replaces that shim
  // instead of failing with EEXIST.
  await fs.writeFile(path.join(globalDir, "bin", "lynn"), "#!/bin/sh\necho stale\n", { mode: 0o755 });
  await run("npm global install packed CLI", "npm", ["install", "--global", "--force", "--silent", "--omit=dev", "--prefix", globalDir, tarball], { cwd: installDir });
  const globalLynn = process.platform === "win32"
    ? path.join(globalDir, "lynn.cmd")
    : path.join(globalDir, "bin", "lynn");
  const globalVersion = await run("global lynn version", globalLynn, ["version"], { cwd: installDir });
  assertIncludes(globalVersion.name, globalVersion.stdout, "@lynn/cli");

  const lowerBin = await existingBin(installDir, ["lynn"]);
  const lynnBin = await existingBin(installDir, ["Lynn", "lynn"]);

  const version = await run("Lynn version", lynnBin, ["version"], { cwd: installDir });
  assertIncludes(version.name, version.stdout, "@lynn/cli");

  const doctor = await run("lynn doctor offline", lowerBin, ["doctor", "--offline"], { cwd: installDir, env: { LYNN_DATA_DIR: dataDir } });
  assertIncludes(doctor.name, doctor.stdout, "OK node");
  assertIncludes(doctor.name, doctor.stdout, "brain: skipped");

  const mock = await run("Lynn mock prompt", lynnBin, ["-p", "你好", "--mock-brain"], { cwd: installDir, env: { LYNN_DATA_DIR: dataDir } });
  assertIncludes(mock.name, mock.stdout, "你好");
  assertNotIncludes(mock.name, mock.stdout, "Cannot find module");

  const tools = await run("Lynn code list tools", lynnBin, ["code", "--list-tools"], { cwd: installDir, env: { LYNN_DATA_DIR: dataDir } });
  assertIncludes(tools.name, tools.stdout, "read_file");
  assertIncludes(tools.name, tools.stdout, "apply_patch");

  await run("direct node entry", nodeBin, [path.join(installDir, "node_modules", "@lynn", "cli", "bin", "lynn.mjs"), "version"], { cwd: installDir });

  console.log(`[cli-install-smoke] packed install passed: ${tarballName}`);
} finally {
  if (process.env.KEEP_LYNN_CLI_INSTALL_SMOKE !== "1") {
    await fs.rm(tmp, { recursive: true, force: true });
  } else {
    console.log(`[cli-install-smoke] kept temp dir: ${tmp}`);
  }
}
