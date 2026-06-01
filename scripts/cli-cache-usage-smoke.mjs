#!/usr/bin/env node

import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const cliBin = path.join(root, "cli", "bin", "lynn.mjs");

function sse(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function createBrainServer() {
  let chatRequests = 0;
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === "/v1/chat/completions" && req.method === "POST") {
      chatRequests += 1;
      req.resume();
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(sse({ object: "lynn.provider", meta: { active_provider: "step-3.7-flash" } }));
      res.write(sse({ object: "chat.completion.chunk", choices: [{ delta: { content: "OK" }, finish_reason: null }] }));
      res.write(sse({
        object: "chat.completion.chunk",
        choices: [],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 10,
          total_tokens: 1010,
          prompt_cache_hit_tokens: 800,
          prompt_cache_miss_tokens: 200,
        },
      }));
      res.write(sse({ object: "chat.completion.chunk", choices: [{ delta: {}, finish_reason: "stop" }] }));
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  return { server, chatRequests: () => chatRequests };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("Brain smoke server did not bind to TCP"));
      else resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function runCli(brainUrl) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      cliBin,
      "-p",
      "回复 OK",
      "--brain-url",
      brainUrl,
      "--reasoning",
      "off",
    ], {
      cwd: root,
      env: {
        ...process.env,
        LYNN_CLI_UPDATE_CHECK: "0",
        LYNN_LANG: "zh",
        LYNN_CLI_REMOTE_BRAIN_URL: brainUrl,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`cache usage smoke timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 10_000);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function assertIncludes(name, text, needle) {
  if (!text.includes(needle)) {
    throw new Error(`${name} did not include ${JSON.stringify(needle)}\n${text}`);
  }
}

const { server, chatRequests } = createBrainServer();
const brainUrl = await listen(server);
try {
  const result = await runCli(brainUrl);
  const combined = `${result.stdout}\n${result.stderr}`;
  if (result.code !== 0) {
    throw new Error(`Lynn exited ${result.code}\n${combined}`);
  }
  assertIncludes("cache usage smoke", combined, "OK");
  assertIncludes("cache usage smoke", combined, "route: StepFun 3.7 Flash");
  assertIncludes("cache usage smoke", combined, "prefix-cache 800 hit");
  assertIncludes("cache usage smoke", combined, "miss 200");
  assertIncludes("cache usage smoke", combined, "(80%)");
  if (chatRequests() !== 1) throw new Error(`expected 1 chat request, saw ${chatRequests()}`);
  process.stdout.write("[cli-cache-usage-smoke] prefix-cache usage displayed\n");
} finally {
  await new Promise((resolve) => server.close(resolve));
}
