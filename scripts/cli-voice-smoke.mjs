#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-cli-voice-smoke-"));
const wav = path.join(tmp, "speech.wav");
await fs.writeFile(wav, pcm16ToWav(tonePcm16()));

const seen = { asr: false, chat: false };
const server = http.createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => {
    body += String(chunk);
  });
  request.on("end", () => {
    if (request.url === "/v1/voice/asr") {
      const parsed = JSON.parse(body);
      if (!request.headers["x-agent-key"]) return fail(response, "missing signed voice header");
      if (!parsed.audio_pcm_base64 || parsed.sample_rate !== 24000) return fail(response, "invalid voice payload");
      seen.asr = true;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, text: "请总结这段语音任务", provider: "stepfun-realtime" }));
      return;
    }
    if (request.url === "/v1/chat/completions") {
      const parsed = JSON.parse(body);
      const last = String(parsed.messages?.at(-1)?.content || "");
      if (!last.includes("请总结这段语音任务")) return fail(response, "voice transcript missing from prompt");
      seen.chat = true;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end([
        "data: {\"choices\":[{\"delta\":{\"content\":\"语音任务完成\"}}]}",
        "",
        "data: [DONE]",
        "",
      ].join("\n"));
      return;
    }
    response.writeHead(404);
    response.end("not found");
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const brainUrl = `http://127.0.0.1:${address.port}`;

try {
  const result = await runCli([
    "-p",
    "按语音内容回答",
    "--voice-file",
    wav,
    "--json",
    "--brain-url",
    brainUrl,
  ], {
    LYNN_HOME: path.join(tmp, "home"),
  });
  if (result.code !== 0) throw new Error(`CLI exited ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  if (!seen.asr || !seen.chat) throw new Error(`missing requests: ${JSON.stringify(seen)}`);
  if (!result.stdout.includes("voice.transcript") || !result.stdout.includes("语音任务完成")) {
    throw new Error(`voice smoke output missing expected events:\n${result.stdout}`);
  }
  console.log("PASS cli voice smoke");
} finally {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(tmp, { recursive: true, force: true });
}

function fail(response, message) {
  response.writeHead(400, { "content-type": "application/json" });
  response.end(JSON.stringify({ ok: false, error: message }));
}

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "cli/bin/lynn.mjs"), ...args], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI voice smoke timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 20000);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function tonePcm16() {
  const pcm = Buffer.alloc(24000 * 2);
  for (let i = 0; i < 24000; i += 1) {
    const sample = Math.round(Math.sin((i / 24000) * Math.PI * 2 * 440) * 12000);
    pcm.writeInt16LE(sample, i * 2);
  }
  return pcm;
}

function pcm16ToWav(pcm) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(24000 * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
