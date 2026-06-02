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

function runCli(args, inputText = null) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliBin, ...args], {
      cwd: root,
      env: {
        ...process.env,
        LYNN_CLI_UPDATE_CHECK: "0",
        LYNN_LANG: "zh",
      },
      stdio: ["pipe", "pipe", "pipe"],
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
    child.stdin.end(inputText ?? "");
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
  const headless = await runCli([
    "-p",
    "回复 OK",
    "--brain-url",
    brainUrl,
    "--reasoning",
    "off",
  ]);
  const headlessCombined = `${headless.stdout}\n${headless.stderr}`;
  if (headless.code !== 0) {
    throw new Error(`Lynn -p exited ${headless.code}\n${headlessCombined}`);
  }
  assertIncludes("headless cache usage smoke", headlessCombined, "OK");
  assertIncludes("headless cache usage smoke", headlessCombined, "route: StepFun 3.7 Flash");
  assertIncludes("headless cache usage smoke", headlessCombined, "prefix-cache 800 hit");
  assertIncludes("headless cache usage smoke", headlessCombined, "miss 200");
  assertIncludes("headless cache usage smoke", headlessCombined, "(80%)");

  const chat = await runCli([
    "--brain-url",
    brainUrl,
    "--reasoning",
    "off",
  ], "缓存显示测试\n/exit\n");
  const chatCombined = `${chat.stdout}\n${chat.stderr}`;
  if (chat.code !== 0) {
    throw new Error(`Lynn chat exited ${chat.code}\n${chatCombined}`);
  }
  assertIncludes("interactive cache usage smoke", chatCombined, "OK");
  assertIncludes("interactive cache usage smoke", chatCombined, "prefix-cache 800 hit");
  assertIncludes("interactive cache usage smoke", chatCombined, "miss 200");
  assertIncludes("interactive cache usage smoke", chatCombined, "(80%)");

  if (chatRequests() !== 2) throw new Error(`expected 2 chat requests, saw ${chatRequests()}`);
  process.stdout.write("[cli-cache-usage-smoke] prefix-cache usage displayed in -p and chat\n");
} finally {
  await new Promise((resolve) => server.close(resolve));
}
