#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const args = {
    branch: "main",
    remotes: (process.env.LYNN_RELEASE_REMOTES || "github-lynnmerkyor,origin,gitee")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    tag: "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--branch") args.branch = next();
    else if (arg.startsWith("--branch=")) args.branch = arg.slice("--branch=".length);
    else if (arg === "--tag") args.tag = next();
    else if (arg.startsWith("--tag=")) args.tag = arg.slice("--tag=".length);
    else if (arg === "--remotes") {
      args.remotes = next().split(",").map((item) => item.trim()).filter(Boolean);
    } else if (arg.startsWith("--remotes=")) {
      args.remotes = arg.slice("--remotes=".length).split(",").map((item) => item.trim()).filter(Boolean);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  npm run release:verify-remotes
  node scripts/verify-release-remotes.mjs --tag v0.85.7 --remotes github-lynnmerkyor,origin,gitee

Checks that release remotes expose the current branch head and release tag.

Options:
  --branch NAME       branch to check, default: main
  --tag TAG           tag to check, default: v<package.json version>
  --remotes A,B       remotes to check, default: github-lynnmerkyor,origin,gitee

Environment:
  LYNN_RELEASE_REMOTES=github-lynnmerkyor,origin,gitee`);
}

function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: options.stdio || ["ignore", "pipe", "pipe"],
  }).trim();
}

function lsRemote(remote, refs) {
  try {
    const output = git(["ls-remote", remote, ...refs]);
    const map = new Map();
    for (const line of output.split(/\r?\n/).filter(Boolean)) {
      const [sha, ref] = line.split(/\s+/);
      if (sha && ref) map.set(ref, sha);
    }
    return { ok: true, map, error: "" };
  } catch (error) {
    return {
      ok: false,
      map: new Map(),
      error: String(error?.stderr || error?.message || error),
    };
  }
}

const args = parseArgs(process.argv.slice(2));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const tag = args.tag || `v${pkg.version}`;
const localHead = git(["rev-parse", args.branch]);
const localTagCommit = git(["rev-list", "-n", "1", tag]);
const failures = [];

console.log(`[release-remotes] branch=${args.branch} head=${localHead.slice(0, 12)} tag=${tag} commit=${localTagCommit.slice(0, 12)}`);

for (const remote of args.remotes) {
  const branchRef = `refs/heads/${args.branch}`;
  const tagRef = `refs/tags/${tag}`;
  const peeledTagRef = `${tagRef}^{}`;
  const result = lsRemote(remote, [branchRef, tagRef, peeledTagRef]);
  if (!result.ok) {
    failures.push(`${remote}: cannot read remote refs\n${result.error}`);
    continue;
  }

  const remoteHead = result.map.get(branchRef) || "";
  const remoteTag = result.map.get(peeledTagRef) || result.map.get(tagRef) || "";
  const branchOk = remoteHead === localHead;
  const tagOk = remoteTag === localTagCommit;

  console.log(`[release-remotes] ${remote} ${branchRef} ${remoteHead ? remoteHead.slice(0, 12) : "missing"} ${branchOk ? "OK" : "FAIL"}`);
  console.log(`[release-remotes] ${remote} ${tagRef} ${remoteTag ? remoteTag.slice(0, 12) : "missing"} ${tagOk ? "OK" : "FAIL"}`);

  if (!branchOk) {
    failures.push(`${remote}: ${branchRef} is ${remoteHead || "missing"}, expected ${localHead}`);
  }
  if (!tagOk) {
    failures.push(`${remote}: ${tagRef} is ${remoteTag || "missing"}, expected ${localTagCommit}`);
  }
}

if (failures.length > 0) {
  console.error("\n[release-remotes] remote release sync failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  console.error("\nFix with the release SOP push commands, then rerun this check.");
  process.exit(1);
}

console.log(`\n[release-remotes] release refs are in sync: ${args.remotes.join(", ")}`);
