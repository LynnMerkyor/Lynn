#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
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
const byokDataDir = path.join(os.tmpdir(), "lynn-cli-smoke-byok");
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
await fs.promises.rm(byokDataDir, { recursive: true, force: true });
await fs.promises.mkdir(byokDataDir, { recursive: true });
const smokePng = path.join(visionDataDir, "smoke.png");
await fs.promises.writeFile(smokePng, Buffer.from("89504e470d0a1a0a", "hex"));

const checks = [];

checks.push(run("version", ["version"]).then((r) => {
  assertIncludes(r.name, r.stdout, "@lynn/cli");
}));

checks.push(run("startup banner", []).then((r) => {
  assertIncludes(r.name, r.stdout, "Lynn CLI");
  assertIncludes(r.name, r.stdout, "MiMo via");
  assertIncludes(r.name, r.stdout, "ask / workspace-write");
  assertIncludes(r.name, r.stdout, "Shift+Tab");
  assertIncludes(r.name, r.stdout, "offline");
  assertIncludes(r.name, r.stdout, "Lynn providers");
}));

checks.push(run("providers", ["providers", "--data-dir", missingDataDir]).then((r) => {
  assertIncludes(r.name, r.stdout, "Lynn Providers / BYOK");
  assertIncludes(r.name, r.stdout, "Provider key");
  assertNotIncludes(r.name, r.stdout, "sk-");
  assertNotIncludes(r.name, r.stdout.toLowerCase(), "api_key");
}));

checks.push(run("provider presets", ["providers", "presets"]).then((r) => {
  assertIncludes(r.name, r.stdout, "mimo");
  assertIncludes(r.name, r.stdout, "mimo-v2.5-pro");
  assertIncludes(r.name, r.stdout, "stepfun");
  assertIncludes(r.name, r.stdout, "step-3.7-flash");
  assertIncludes(r.name, r.stdout, "Lynn providers set --preset mimo --api-key <api-key>");
  assertIncludes(r.name, r.stdout, "Lynn providers set --preset stepfun --api-key <api-key>");
  assertNotIncludes(r.name, r.stdout, "sk-");
}));

checks.push(run("permissions", ["permissions", "--data-dir", missingDataDir]).then((r) => {
  assertIncludes(r.name, r.stdout, "Lynn CLI Permissions");
  assertIncludes(r.name, r.stdout, "approval: ask");
  assertIncludes(r.name, r.stdout, "sandbox:  workspace-write");
  assertIncludes(r.name, r.stdout, "GUI profile");
}));

checks.push(run("doctor offline guidance", ["doctor", "--offline", "--data-dir", missingDataDir]).then((r) => {
  assertIncludes(r.name, r.stdout, "cli-byok");
  assertIncludes(r.name, r.stdout, "Lynn providers set --preset mimo --api-key <api-key>");
  assertIncludes(r.name, r.stdout, "mimo:mimo-v2.5-pro");
  assertIncludes(r.name, r.stdout, "stepfun:step-3.7-flash");
  assertNotIncludes(r.name, r.stdout, "sk-");
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
  assertIncludes(r.name, r.stdout, "你好");
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
  assertIncludes(r.name, r.stdout, "review the current diff");
  assertIncludes(r.name, r.stdout, "mock Brain");
}));

checks.push(run("vision see mock", ["see", smokePng, "describe this UI", "--mock-brain"]).then((r) => {
  assertIncludes(r.name, r.stdout, "see:");
  assertIncludes(r.name, r.stdout, "describe this UI");
}));

checks.push(run("vision ground mock json", ["ground", smokePng, "Submit button", "--mock-brain", "--json"]).then((r) => {
  assertIncludes(r.name, r.stdout, '"type":"vision.started"');
  assertIncludes(r.name, r.stdout, '"command":"ground"');
  assertIncludes(r.name, r.stdout, '"type":"vision.finished"');
}));

checks.push(run("mock chat", ["chat", "--mock-brain"], { stdinLines: ["/mode yolo", "hi", "/exit"] }).then((r) => {
  assertIncludes(r.name, r.stdout, "YOLO");
  assertIncludes(r.name, r.stdout, "hi");
}));

checks.push(run("implicit chat with global flags", ["--mock-brain"], { stdinLines: ["hi", "/exit"] }).then((r) => {
  assertIncludes(r.name, r.stdout, "模拟回复:hi");
}));

checks.push(runBareTtyStartupSmoke());

checks.push(run("chat brain offline recovery", ["chat", "--brain-url", "http://127.0.0.1:1"], { stdinLines: ["hi", "/exit"] }).then((r) => {
  assertIncludes(r.name, r.stdout, "Brain 离线");
  assertIncludes(r.name, r.stdout, "Lynn");
}));

checks.push(run("mock worker", ["worker", "run", "--brief", briefPath, "--worktree", root, "--mock", "--jsonl"]).then((r) => {
  assertIncludes(r.name, r.stdout, '"type":"worker.started"');
  assertIncludes(r.name, r.stdout, '"type":"worker.finished"');
}));

checks.push(run("stepfun worker mock", ["worker", "run", "--brief", briefPath, "--worktree", root, "--agent", "stepfun-flash", "--mock", "--jsonl"]).then((r) => {
  assertIncludes(r.name, r.stdout, '"agent":"stepfun-flash"');
  assertIncludes(r.name, r.stdout, '"type":"worker.finished"');
}));

checks.push(run("brain unreachable recovery", ["-p", "你好", "--brain-url", "http://127.0.0.1:1"], { expectFailure: true }).then((r) => {
  assertIncludes(r.name, r.stderr, "无法连接 Lynn Brain");
  assertIncludes(r.name, r.stderr, "Lynn 客户端");
  assertIncludes(r.name, r.stderr, "--mock-brain");
}));

for (const check of checks) {
  await check;
}

await runStepFunByokFallbackSmoke();

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

await runCodeResumeSmoke();
await runCodeImageByokSmoke();
await runVisionByokSmoke();
await runStepFunWorkerByokSmoke();

console.log("[cli-smoke] all checks passed");

async function runCodeResumeSmoke() {
  const codeSession = await run("code session save", [
    "code",
    "remember this code task",
    "--mock-brain",
    "--save-session",
    "--data-dir",
    sessionDataDir,
    "--json",
  ]);
  assertIncludes(codeSession.name, codeSession.stdout, '"type":"session.saved"');
  const codeSavedLine = codeSession.stdout.split(/\r?\n/).find((line) => line.includes('"type":"session.saved"'));
  const codeSavedPath = codeSavedLine ? JSON.parse(codeSavedLine).path : "";
  if (!codeSavedPath) throw new Error(`code session save did not return a path\n${codeSession.stdout}`);
  const resumed = await run("code session resume", [
    "code",
    "--resume",
    codeSavedPath,
    "continue that code task",
    "--mock-brain",
    "--data-dir",
    sessionDataDir,
    "--json",
  ]);
  assertIncludes(resumed.name, resumed.stdout, '"type":"session.resumed"');
  assertIncludes(resumed.name, resumed.stdout, '"type":"session.saved"');
}

async function runStepFunByokFallbackSmoke() {
  let seen = null;
  const server = http.createServer((request, response) => {
    if (request.url !== "/v1/chat/completions" || request.method !== "POST") {
      response.writeHead(404);
      response.end();
      return;
    }
    let body = "";
    request.on("data", (chunk) => { body += String(chunk); });
    request.on("end", () => {
      seen = { auth: request.headers.authorization, body: JSON.parse(body) };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end([
        "data: {\"choices\":[{\"delta\":{\"content\":\"ok from stepfun\"}}]}",
        "",
        "data: [DONE]",
        "",
      ].join("\n"));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("StepFun BYOK smoke server failed to listen");
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    await run("stepfun preset save", [
      "providers",
      "set",
      "--data-dir",
      byokDataDir,
      "--preset",
      "stepfun",
      "--api-key",
      "step-smoke-key",
      "--json",
    ]);
    const tested = await run("stepfun provider test", [
      "providers",
      "test",
      "--data-dir",
      byokDataDir,
      "--preset",
      "stepfun",
      "--base-url",
      baseUrl,
      "--api-key",
      "step-smoke-key",
      "--json",
    ]);
    assertIncludes(tested.name, tested.stdout, '"type":"providers.test"');
    assertIncludes(tested.name, tested.stdout, '"ok":true');
    assertIncludes(tested.name, tested.stdout, '"model":"step-3.7-flash"');
    assertNotIncludes(tested.name, tested.stdout, "step-smoke-key");
    const result = await run("stepfun byok fallback", [
      "-p",
      "say ok",
      "--data-dir",
      byokDataDir,
      "--preset",
      "stepfun",
      "--base-url",
      baseUrl,
      "--api-key",
      "step-smoke-key",
      "--brain-url",
      "http://127.0.0.1:1",
      "--json",
    ], { env: { LYNN_CLI_BRAIN_TIMEOUT_MS: "50" } });
    assertIncludes(result.name, result.stdout, '"text":"ok from stepfun"');
    if (!seen) throw new Error("StepFun BYOK smoke did not call the provider");
    if (seen.auth !== "Bearer step-smoke-key") throw new Error(`StepFun BYOK smoke used wrong auth: ${seen.auth}`);
    if (seen.body.model !== "step-3.7-flash") throw new Error(`StepFun BYOK smoke used wrong model: ${seen.body.model}`);
    const chat = await run("stepfun chat byok fallback", [
      "chat",
      "--data-dir",
      byokDataDir,
      "--preset",
      "stepfun",
      "--base-url",
      baseUrl,
      "--api-key",
      "step-smoke-key",
      "--brain-url",
      "http://127.0.0.1:1",
    ], { stdinLines: ["hello from chat", "/exit"], env: { LYNN_CLI_BRAIN_TIMEOUT_MS: "50" } });
    assertIncludes(chat.name, chat.stdout, "ok from stepfun");
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

async function runCodeImageByokSmoke() {
  let seen = null;
  const server = http.createServer((request, response) => {
    if (request.url !== "/v1/chat/completions" || request.method !== "POST") {
      response.writeHead(404);
      response.end();
      return;
    }
    let body = "";
    request.on("data", (chunk) => { body += String(chunk); });
    request.on("end", () => {
      seen = { auth: request.headers.authorization, body: JSON.parse(body) };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end([
        "data: {\"choices\":[{\"delta\":{\"content\":\"image ok\"}}]}",
        "",
        "data: [DONE]",
        "",
      ].join("\n"));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("image BYOK smoke server failed to listen");
    const result = await run("code image byok", [
      "code",
      "review attached UI",
      "--image",
      smokePng,
      "--base-url",
      `http://127.0.0.1:${address.port}/v1`,
      "--api-key",
      "image-smoke-key",
      "--model",
      "vision-test-model",
      "--brain-url",
      "http://127.0.0.1:1",
      "--json",
      "--max-steps",
      "1",
    ], { env: { LYNN_CLI_BRAIN_TIMEOUT_MS: "50" } });
    assertIncludes(result.name, result.stdout, '"text":"image ok"');
    if (!seen) throw new Error("code image BYOK smoke did not call the provider");
    if (seen.auth !== "Bearer image-smoke-key") throw new Error(`code image BYOK smoke used wrong auth: ${seen.auth}`);
    if (seen.body.model !== "vision-test-model") throw new Error(`code image BYOK smoke used wrong model: ${seen.body.model}`);
    const messageText = JSON.stringify(seen.body.messages || []);
    if (!messageText.includes("data:image/png;base64")) throw new Error("code image BYOK smoke did not send image content");
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

async function runVisionByokSmoke() {
  let seen = null;
  const server = http.createServer((request, response) => {
    if (request.url !== "/v1/chat/completions" || request.method !== "POST") {
      response.writeHead(404);
      response.end();
      return;
    }
    let body = "";
    request.on("data", (chunk) => { body += String(chunk); });
    request.on("end", () => {
      seen = { auth: request.headers.authorization, body: JSON.parse(body) };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end([
        "data: {\"choices\":[{\"delta\":{\"content\":\"vision byok ok\"}}]}",
        "",
        "data: [DONE]",
        "",
      ].join("\n"));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("vision BYOK smoke server failed to listen");
    const result = await run("vision see byok", [
      "see",
      smokePng,
      "describe this UI",
      "--base-url",
      `http://127.0.0.1:${address.port}/v1`,
      "--api-key",
      "vision-smoke-key",
      "--model",
      "vision-test-model",
      "--brain-url",
      "http://127.0.0.1:1",
    ], { env: { LYNN_CLI_BRAIN_TIMEOUT_MS: "50" } });
    assertIncludes(result.name, result.stdout, "vision byok ok");
    if (!seen) throw new Error("vision BYOK smoke did not call the provider");
    if (seen.auth !== "Bearer vision-smoke-key") throw new Error(`vision BYOK smoke used wrong auth: ${seen.auth}`);
    if (seen.body.model !== "vision-test-model") throw new Error(`vision BYOK smoke used wrong model: ${seen.body.model}`);
    const messageText = JSON.stringify(seen.body.messages || []);
    if (!messageText.includes("data:image/png;base64")) throw new Error("vision BYOK smoke did not send image content");
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

async function runBareTtyStartupSmoke() {
  if (!(await hasExpect())) {
    process.stderr.write("[cli-smoke] skipping bare TTY startup smoke: expect not found\n");
    return;
  }
  const markerPath = path.join(os.tmpdir(), `lynn-cli-tty-smoke-${process.pid}.txt`);
  await fs.promises.rm(markerPath, { force: true });
  const script = [
    "set timeout 5",
    "spawn $env(NODE_BIN) $env(CLI_BIN)",
    "expect \"Lynn CLI\"",
    "expect \"› \"",
    "send \"/exit\\r\"",
    "expect eof",
    "set marker [open $env(MARKER_PATH) w]",
    "puts $marker \"LYNN_TTY_SMOKE_OK\"",
    "close $marker",
  ].join("\n");
  await runProcess("bare TTY startup", "expect", ["-c", script], {
    env: { NODE_BIN: nodeBin, CLI_BIN: cliBin, MARKER_PATH: markerPath, LYNN_CLI_BRAIN_TIMEOUT_MS: "50" },
  });
  const marker = fs.existsSync(markerPath) ? fs.readFileSync(markerPath, "utf8") : "";
  await fs.promises.rm(markerPath, { force: true });
  assertIncludes("bare TTY startup", marker, "LYNN_TTY_SMOKE_OK");
}

function hasExpect() {
  return new Promise((resolve) => {
    const child = spawn("expect", ["-v"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

function runProcess(name, command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, ...(options.env || {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => {
      const result = { name, code, stdout, stderr };
      if (code === 0) resolve(result);
      else reject(new Error(`${name} failed with exit ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
  });
}

async function runStepFunWorkerByokSmoke() {
  let seen = null;
  const server = http.createServer((request, response) => {
    if (request.url !== "/v1/chat/completions" || request.method !== "POST") {
      response.writeHead(404);
      response.end();
      return;
    }
    let body = "";
    request.on("data", (chunk) => { body += String(chunk); });
    request.on("end", () => {
      seen = { auth: request.headers.authorization, body: JSON.parse(body) };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end([
        "data: {\"choices\":[{\"delta\":{\"content\":\"stepfun worker ok\"}}]}",
        "",
        "data: [DONE]",
        "",
      ].join("\n"));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("StepFun worker smoke server failed to listen");
    const result = await run("stepfun worker byok", [
      "worker",
      "run",
      "--brief",
      briefPath,
      "--worktree",
      root,
      "--agent",
      "stepfun-flash",
      "--preset",
      "stepfun",
      "--base-url",
      `http://127.0.0.1:${address.port}/v1`,
      "--api-key",
      "step-worker-key",
      "--brain-url",
      "http://127.0.0.1:1",
      "--max-steps",
      "1",
      "--jsonl",
    ], { env: { LYNN_CLI_BRAIN_TIMEOUT_MS: "50" } });
    assertIncludes(result.name, result.stdout, '"agent":"stepfun-flash"');
    assertIncludes(result.name, result.stdout, '"type":"worker.finished"');
    assertIncludes(result.name, result.stdout, '"summary":"lynn-cli worker completed"');
    if (!seen) throw new Error("StepFun worker smoke did not call the provider");
    if (seen.auth !== "Bearer step-worker-key") throw new Error(`StepFun worker smoke used wrong auth: ${seen.auth}`);
    if (seen.body.model !== "step-3.7-flash") throw new Error(`StepFun worker smoke used wrong model: ${seen.body.model}`);
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
}
