#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const cliBin = path.join(root, "cli", "bin", "lynn.mjs");
const nodeBin = process.execPath;
const toolTurns = 21;

function fail(message, detail = "") {
  throw new Error(`[cli-longrun-smoke] ${message}${detail ? `\n${detail}` : ""}`);
}

function ssePayloads(payloads) {
  return [
    ...payloads.map((payload) => `data: ${JSON.stringify(payload)}\n`),
    "data: [DONE]\n",
    "",
  ].join("\n");
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(nodeBin, [cliBin, ...args], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, LYNN_LANG: "en" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function parseJsonLines(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        fail("CLI emitted a non-JSON line in --json mode", line);
      }
    });
}

async function main() {
  await fs.access(cliBin).catch(() => fail(`CLI bundle missing at ${cliBin}; run npm run build:cli first.`));
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-cli-longrun-"));
  const dataDir = path.join(tmp, "data");
  for (let i = 1; i <= toolTurns; i += 1) {
    const payload = [
      `long-run smoke file ${i}`,
      "This deliberately large payload forces runtime compaction during the agent loop.",
      "x".repeat(35_000),
      "",
    ].join("\n");
    await fs.writeFile(path.join(tmp, `file-${i}.txt`), payload, "utf8");
  }

  let requestCount = 0;
  const requestBodies = [];
  const server = http.createServer((req, res) => {
    if (req.url !== "/v1/chat/completions" || req.method !== "POST") {
      res.writeHead(404);
      res.end();
      return;
    }
    let raw = "";
    req.on("data", (chunk) => { raw += String(chunk); });
    req.on("end", () => {
      requestCount += 1;
      const parsed = JSON.parse(raw);
      requestBodies.push(parsed);
      const content = requestCount <= toolTurns
        ? JSON.stringify({ tool: "read_file", args: { path: `file-${requestCount}.txt` } })
        : `Long-run smoke completed after ${toolTurns} tool turns.`;
      const completionTokens = requestCount <= toolTurns ? 12 : 18;
      const promptTokens = 1000 + requestCount;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(ssePayloads([
        { choices: [{ delta: { content } }] },
        {
          choices: [],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
            prompt_cache_hit_tokens: 800 + requestCount,
          },
        },
      ]));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") fail("test server did not bind");
  const brainUrl = `http://127.0.0.1:${address.port}`;

  try {
    const result = await runCli([
      "code",
      "exercise long-run checkpoints and cache-stable prefix",
      "--cwd",
      tmp,
      "--brain-url",
      brainUrl,
      "--approval",
      "yolo",
      "--long",
      "--max-steps",
      "30",
      "--save-session",
      "--data-dir",
      dataDir,
      "--json",
    ]);
    if (result.code !== 0) fail(`long-run CLI exited ${result.code}`, `${result.stdout}\n${result.stderr}`);
    const events = parseJsonLines(result.stdout);
    const toolRequests = events.filter((event) => event.type === "code.tool.requested");
    if (toolRequests.length !== toolTurns) fail(`expected ${toolTurns} tool requests, got ${toolRequests.length}`, result.stdout);
    const usageEvents = events.filter((event) => event.type === "usage");
    if (usageEvents.length < toolTurns) fail("expected usage events with cache telemetry", result.stdout);
    if (!usageEvents.some((event) => event.usage?.prompt_cache_hit_tokens > 0 && event.durationMs >= 0)) {
      fail("usage events did not preserve cache-hit tokens and duration", JSON.stringify(usageEvents.at(-1), null, 2));
    }
    const compactionEvents = events.filter((event) => event.type === "code.runtime.compacted");
    if (!compactionEvents.some((event) => event.messages > 0)) {
      fail("expected runtime compaction during the long tool loop", result.stdout);
    }
    const finished = events.find((event) => event.type === "code.task.finished");
    if (!finished?.ok) fail("long-run CLI did not finish cleanly", result.stdout);
    const saved = [...events].reverse().find((event) => event.type === "session.saved");
    if (!saved?.path) fail("long-run CLI did not save a resumable session", result.stdout);

    const sessionLines = (await fs.readFile(saved.path, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
    const metadata = sessionLines.find((line) => line.type === "metadata")?.data;
    if (metadata?.maxSteps !== 30 || metadata?.maxStepsReached !== false) {
      fail("session metadata does not record the long-run budget", JSON.stringify(metadata, null, 2));
    }
    const checkpointCount = events.filter((event) => event.type === "session.checkpoint").length;
    if (checkpointCount < toolTurns * 2) fail(`expected checkpoints for tool loop turns, got ${checkpointCount}`);

    if (requestBodies.length !== toolTurns + 1) fail(`expected ${toolTurns + 1} model requests, got ${requestBodies.length}`);
    const stablePrefix = requestBodies[0]?.messages?.[0]?.content;
    if (typeof stablePrefix !== "string" || !stablePrefix.includes("You are Lynn CLI code mode.") || !stablePrefix.includes("cacheable_context:Repository root")) {
      fail("first message is not the cache-stable runtime prefix", JSON.stringify(requestBodies[0]?.messages?.[0], null, 2));
    }
    for (const body of requestBodies) {
      if (body.messages?.[0]?.content !== stablePrefix) {
        fail("cache-stable runtime prefix drifted during the long run");
      }
    }
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
    await fs.rm(tmp, { recursive: true, force: true });
  }

  process.stdout.write("[cli-longrun-smoke] long-run checkpoint/cache smoke passed\n");
}

await main();
