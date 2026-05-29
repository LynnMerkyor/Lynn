#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const nodeBin = process.execPath;
const cliBin = path.join(root, "cli", "bin", "lynn.mjs");
const missingDataDir = path.join(os.tmpdir(), "lynn-cli-smoke-missing");
const permissionSetDataDir = path.join(os.tmpdir(), "lynn-cli-smoke-permissions-set");
const sessionDataDir = path.join(os.tmpdir(), "lynn-cli-smoke-sessions");
const toolDataDir = path.join(os.tmpdir(), "lynn-cli-smoke-tools");
const visionDataDir = path.join(os.tmpdir(), "lynn-cli-smoke-vision");
const briefPath = path.join(root, "cli", "fixtures", "worker-brief.md");

function run(name, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(nodeBin, [cliBin, ...args], {
      cwd: root,
      env: { ...process.env, ...(options.env || {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => {
      const result = { name, code, stdout, stderr };
      if (options.expectFailure ? code !== 0 : code === 0) {
        resolve(result);
      } else {
        reject(new Error(`${name} failed with exit ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      }
    });
    if (Array.isArray(options.stdinLines)) {
      let index = 0;
      const writeNext = () => {
        if (index >= options.stdinLines.length) {
          child.stdin.end();
          return;
        }
        child.stdin.write(`${options.stdinLines[index]}\n`);
        index += 1;
        setTimeout(writeNext, 25);
      };
      setTimeout(writeNext, 25);
    } else if (typeof options.stdin === "string") child.stdin.end(options.stdin);
    else child.stdin.end();
  });
}

function assertIncludes(name, text, needle) {
  if (!text.includes(needle)) {
    throw new Error(`${name} output did not include ${JSON.stringify(needle)}\n${text}`);
  }
}

function assertNotIncludes(name, text, needle) {
  if (text.includes(needle)) {
    throw new Error(`${name} output unexpectedly included ${JSON.stringify(needle)}\n${text}`);
  }
}

if (!fs.existsSync(cliBin)) {
  throw new Error(`CLI bundle missing: ${cliBin}. Run npm run build:cli first.`);
}

await fs.promises.rm(missingDataDir, { recursive: true, force: true });
await fs.promises.mkdir(missingDataDir, { recursive: true });
await fs.promises.rm(permissionSetDataDir, { recursive: true, force: true });
await fs.promises.mkdir(permissionSetDataDir, { recursive: true });
await fs.promises.rm(sessionDataDir, { recursive: true, force: true });
await fs.promises.mkdir(sessionDataDir, { recursive: true });
await fs.promises.rm(toolDataDir, { recursive: true, force: true });
await fs.promises.mkdir(toolDataDir, { recursive: true });
await fs.promises.writeFile(path.join(toolDataDir, "hello.txt"), "hello\n", "utf8");
await fs.promises.rm(visionDataDir, { recursive: true, force: true });
await fs.promises.mkdir(visionDataDir, { recursive: true });
const smokePng = path.join(visionDataDir, "smoke.png");
await fs.promises.writeFile(smokePng, Buffer.from("89504e470d0a1a0a", "hex"));

const checks = [];

checks.push(run("version", ["version"]).then((r) => {
  assertIncludes(r.name, r.stdout, "@lynn/cli");
}));

checks.push(run("startup banner", []).then((r) => {
  assertIncludes(r.name, r.stdout, ">_ Lynn CLI");
  assertIncludes(r.name, r.stdout, "MiMo via");
  assertIncludes(r.name, r.stdout, "mode:");
  assertIncludes(r.name, r.stdout, "Shift+Tab");
  assertIncludes(r.name, r.stdout, "offline");
  assertIncludes(r.name, r.stdout, "Lynn providers");
}));

checks.push(run("providers", ["providers", "--data-dir", missingDataDir]).then((r) => {
  assertIncludes(r.name, r.stdout, "Lynn Providers / BYOK");
  assertIncludes(r.name, r.stdout, "Provider keys stay");
  assertNotIncludes(r.name, r.stdout, "sk-");
  assertNotIncludes(r.name, r.stdout.toLowerCase(), "api_key");
}));

checks.push(run("permissions", ["permissions", "--data-dir", missingDataDir]).then((r) => {
  assertIncludes(r.name, r.stdout, "Lynn CLI Permissions");
  assertIncludes(r.name, r.stdout, "approval: ask");
  assertIncludes(r.name, r.stdout, "sandbox:  workspace-write");
  assertIncludes(r.name, r.stdout, "GUI profile");
}));

checks.push(run("permissions set shared profile", [
  "permissions",
  "set",
  "--data-dir",
  permissionSetDataDir,
  "--approval",
  "yolo",
  "--sandbox",
  "danger-full-access",
]).then(async (r) => {
  assertIncludes(r.name, r.stdout, "Saved CLI permission profile");
  const profile = await fs.promises.readFile(path.join(permissionSetDataDir, "permissions", "cli.json"), "utf8");
  assertIncludes(r.name, profile, '"approval": "yolo"');
  assertIncludes(r.name, profile, '"sandbox": "danger-full-access"');
}));

checks.push(run("mock prompt", ["-p", "你好", "--mock-brain"]).then((r) => {
  assertIncludes(r.name, r.stdout, "Mock Lynn response: 你好");
}));

checks.push(run("code list tools", ["code", "--list-tools"]).then((r) => {
  assertIncludes(r.name, r.stdout, "read_file");
  assertIncludes(r.name, r.stdout, "apply_patch");
  assertIncludes(r.name, r.stdout, "grep");
}));

checks.push(run("code read file", ["code", "--tool", "read_file", "--path", "README.md", "--json"]).then((r) => {
  assertIncludes(r.name, r.stdout, '"type":"code.tool.result"');
  assertIncludes(r.name, r.stdout, '"ok":true');
}));

checks.push(run("code apply patch", [
  "code",
  "--cwd",
  toolDataDir,
  "--tool",
  "apply_patch",
  "--approval",
  "yolo",
  "--text",
  [
    "diff --git a/hello.txt b/hello.txt",
    "--- a/hello.txt",
    "+++ b/hello.txt",
    "@@ -1 +1 @@",
    "-hello",
    "+lynn",
    "",
  ].join("\n"),
  "--json",
]).then(async (r) => {
  assertIncludes(r.name, r.stdout, '"tool":"apply_patch"');
  assertIncludes(r.name, r.stdout, '"ok":true');
  const text = await fs.promises.readFile(path.join(toolDataDir, "hello.txt"), "utf8");
  assertIncludes(r.name, text, "lynn");
}));

checks.push(run("code read-only blocks writes", [
  "code",
  "--cwd",
  toolDataDir,
  "--tool",
  "write_file",
  "--path",
  "blocked.txt",
  "--text",
  "nope",
  "--approval",
  "yolo",
  "--sandbox",
  "read-only",
  "--json",
], { expectFailure: true }).then((r) => {
  assertIncludes(r.name, r.stderr, "read-only sandbox");
}));

checks.push(run("code task mock", ["code", "review the current diff", "--mock-brain"]).then((r) => {
  assertIncludes(r.name, r.stdout, "Mock Lynn code task");
}));

checks.push(run("vision see mock", ["see", smokePng, "describe this UI", "--mock-brain"]).then((r) => {
  assertIncludes(r.name, r.stdout, "Mock Lynn see");
  assertIncludes(r.name, r.stdout, "describe this UI");
}));

checks.push(run("vision ground mock json", ["ground", smokePng, "Submit button", "--mock-brain", "--json"]).then((r) => {
  assertIncludes(r.name, r.stdout, '"type":"vision.started"');
  assertIncludes(r.name, r.stdout, '"command":"ground"');
  assertIncludes(r.name, r.stdout, '"type":"vision.finished"');
}));

checks.push(run("mock chat", ["chat", "--mock-brain"], { stdinLines: ["/mode yolo", "hi", "/exit"] }).then((r) => {
  assertIncludes(r.name, r.stdout, "YOLO mode enabled");
  assertIncludes(r.name, r.stdout, "Mock Lynn response: hi");
}));

checks.push(run("chat brain offline recovery", ["chat", "--brain-url", "http://127.0.0.1:1"], { stdinLines: ["hi", "/exit"] }).then((r) => {
  assertIncludes(r.name, r.stdout, "Brain offline");
  assertIncludes(r.name, r.stdout, "start the Lynn GUI");
}));

checks.push(run("mock worker", ["worker", "run", "--brief", briefPath, "--worktree", root, "--mock", "--jsonl"]).then((r) => {
  assertIncludes(r.name, r.stdout, '"type":"worker.started"');
  assertIncludes(r.name, r.stdout, '"type":"worker.finished"');
}));

checks.push(run("brain unreachable recovery", ["-p", "你好", "--brain-url", "http://127.0.0.1:1"], { expectFailure: true }).then((r) => {
  assertIncludes(r.name, r.stderr, "Could not reach Lynn Brain");
  assertIncludes(r.name, r.stderr, "Start the Lynn GUI");
  assertIncludes(r.name, r.stderr, "--mock-brain");
}));

for (const check of checks) {
  await check;
}

const saved = await run("session save", ["-p", "remember this", "--mock-brain", "--save-session", "--data-dir", sessionDataDir, "--json"]);
assertIncludes(saved.name, saved.stdout, '"type":"session.saved"');
const savedLine = saved.stdout.split(/\r?\n/).find((line) => line.includes('"type":"session.saved"'));
const savedPath = savedLine ? JSON.parse(savedLine).path : "";
if (!savedPath) throw new Error(`session save did not return a path\n${saved.stdout}`);

const listed = await run("sessions list", ["sessions", "list", "--data-dir", sessionDataDir, "--json"]);
assertIncludes(listed.name, listed.stdout, '"type":"sessions.list"');
assertIncludes(listed.name, listed.stdout, savedPath);

const shown = await run("sessions show", ["sessions", "show", savedPath, "--json"]);
assertIncludes(shown.name, shown.stdout, '"type":"sessions.show"');
assertIncludes(shown.name, shown.stdout, "remember this");

console.log("[cli-smoke] all checks passed");
