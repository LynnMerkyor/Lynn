import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";
import { runPrompt } from "../src/commands/prompt.js";
import { runVoice } from "../src/commands/voice.js";
import { parseInkVoiceLaunchCommand } from "../src/ink-chat.js";
import { pcm16ToWav } from "../src/voice-audio.js";

const previousLynnHome = process.env.LYNN_HOME;

afterEach(() => {
  if (previousLynnHome === undefined) delete process.env.LYNN_HOME;
  else process.env.LYNN_HOME = previousLynnHome;
});

describe("StepFun Realtime voice CLI gate", () => {
  it("shows discoverable StepFun Realtime voice help", async () => {
    const output = await captureStdout(async () => {
      await expect(runVoice(parseArgs(["voice", "--help"]))).resolves.toBe(0);
    });

    expect(output).toContain("StepFun Realtime");
    expect(output).toContain("Lynn voice");
    expect(output).toContain("Lynn voice --file speech.wav");
    expect(output).toContain("Lynn voice --record 5");
    expect(output).toContain("Lynn voice --speak");
    expect(output).toContain("无需在本地填写 StepFun Key");
  });

  it("starts live microphone voice mode when no file or fixed record flag is provided", async () => {
    let called = false;
    const output = await captureStdout(async () => {
      await expect(runVoice(parseArgs(["voice", "--json"]), {
        json: true,
        liveRunner: async () => {
          called = true;
          return 0;
        },
      })).resolves.toBe(0);
    });
    expect(called).toBe(true);
    expect(output).toBe("");
  });

  it("starts realtime voice with waveform by default for shell `lynn voice`", async () => {
    let realtimeCalled = false;
    let liveCalled = false;

    await expect(runVoice(parseArgs(["voice"]), {
      realtimeRunner: async () => {
        realtimeCalled = true;
        return 0;
      },
      liveRunner: async () => {
        liveCalled = true;
        return 0;
      },
    })).resolves.toBe(0);

    expect(realtimeCalled).toBe(true);
    expect(liveCalled).toBe(false);
  });

  it("keeps classic/json voice on the old record-transcribe loop", async () => {
    let realtimeCalled = false;
    let liveCalled = false;

    await expect(runVoice(parseArgs(["voice", "--classic"]), {
      realtimeRunner: async () => {
        realtimeCalled = true;
        return 0;
      },
      liveRunner: async () => {
        liveCalled = true;
        return 0;
      },
    })).resolves.toBe(0);

    expect(realtimeCalled).toBe(false);
    expect(liveCalled).toBe(true);
  });

  it("intercepts REPL `/voice` and `lynn voice` before they reach the chat model", () => {
    expect(parseInkVoiceLaunchCommand("/voice")).toEqual({ ptt: false });
    expect(parseInkVoiceLaunchCommand("/voice --ptt")).toEqual({ ptt: true });
    expect(parseInkVoiceLaunchCommand("/voice --classic")).toEqual({ ptt: false });
    expect(parseInkVoiceLaunchCommand("/ptt")).toEqual({ ptt: true });
    expect(parseInkVoiceLaunchCommand("lynn voice")).toEqual({ ptt: false });
    expect(parseInkVoiceLaunchCommand("Lynn   voice   --ptt")).toEqual({ ptt: true });
    expect(parseInkVoiceLaunchCommand("lynn voice --classic")).toEqual({ ptt: false });
    expect(parseInkVoiceLaunchCommand("lynn voice --file speech.wav")).toEqual({ ptt: false });
    expect(parseInkVoiceLaunchCommand("给我讲讲 lynn voice 怎么用")).toBeNull();
  });

  it("transcribes a wav file through the signed Brain voice endpoint", async () => {
    const wav = await createSpeechFixture();
    const seen: { path?: string; body?: any; agentKey?: string } = {};
    const server = http.createServer((request, response) => {
      seen.path = request.url;
      seen.agentKey = String(request.headers["x-agent-key"] || "");
      let body = "";
      request.on("data", (chunk) => {
        body += String(chunk);
      });
      request.on("end", () => {
        seen.body = JSON.parse(body);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, text: "深圳今天下雨吗", provider: "stepfun-realtime" }));
      });
    });
    const base = await listen(server);
    const output = await captureStdout(async () => {
      await expect(runVoice(parseArgs([
        "voice",
        "--file",
        wav,
        "--json",
        "--brain-url",
        base,
      ]), { json: true })).resolves.toBe(0);
    });
    await close(server);

    expect(seen.path).toBe("/v1/voice/asr");
    expect(seen.agentKey).toMatch(/^ak_/);
    expect(seen.body).toMatchObject({ sample_rate: 24000, language: "auto" });
    expect(typeof seen.body.audio_pcm_base64).toBe("string");
    expect(Buffer.from(seen.body.audio_pcm_base64, "base64").length).toBeGreaterThan(1000);
    expect(output).toContain("\"type\":\"voice.transcript\"");
    expect(output).toContain("深圳今天下雨吗");
    await fs.rm(path.dirname(wav), { recursive: true, force: true });
  });

  it("merges voice transcript into a real prompt request", async () => {
    const wav = await createSpeechFixture();
    const chatBodies: any[] = [];
    const server = http.createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += String(chunk);
      });
      request.on("end", () => {
        if (request.url === "/v1/voice/asr") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: true, text: "帮我总结今天的天气", provider: "stepfun-realtime" }));
          return;
        }
        if (request.url === "/v1/chat/completions") {
          const parsed = JSON.parse(body);
          chatBodies.push(parsed);
          const last = parsed.messages?.at(-1)?.content;
          expect(String(last)).toContain("请按语音内容回答");
          expect(String(last)).toContain("--- voice transcript ---");
          expect(String(last)).toContain("帮我总结今天的天气");
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
    const base = await listen(server);
    const output = await captureStdout(async () => {
      await expect(runPrompt(parseArgs([
        "-p",
        "请按语音内容回答",
        "--voice-file",
        wav,
        "--json",
        "--brain-url",
        base,
      ]), { json: true })).resolves.toBe(0);
    });
    await close(server);

    expect(chatBodies).toHaveLength(1);
    expect(output).toContain("\"type\":\"voice.transcript\"");
    expect(output).toContain("\"type\":\"run.finished\"");
    expect(output).toContain("语音任务完成");
    await fs.rm(path.dirname(wav), { recursive: true, force: true });
  });

  it("synthesizes text through Brain StepFun Realtime TTS", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-cli-voice-tts-"));
    process.env.LYNN_HOME = path.join(dir, "home");
    const out = path.join(dir, "reply.wav");
    const seen: { path?: string; body?: any; agentKey?: string } = {};
    const server = http.createServer((request, response) => {
      seen.path = request.url;
      seen.agentKey = String(request.headers["x-agent-key"] || "");
      let body = "";
      request.on("data", (chunk) => {
        body += String(chunk);
      });
      request.on("end", () => {
        seen.body = JSON.parse(body);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          ok: true,
          provider: "brain-stepfun-realtime",
          mime_type: "audio/wav",
          audio_base64: pcm16ToWav(Buffer.alloc(24000 * 2)).toString("base64"),
        }));
      });
    });
    const base = await listen(server);
    const output = await captureStdout(async () => {
      await expect(runVoice(parseArgs([
        "voice",
        "--speak",
        "你好 Lynn",
        "--out",
        out,
        "--json",
        "--brain-url",
        base,
      ]), { json: true })).resolves.toBe(0);
    });
    await close(server);

    expect(seen.path).toBe("/v1/voice/tts");
    expect(seen.agentKey).toMatch(/^ak_/);
    expect(seen.body).toMatchObject({ text: "你好 Lynn", voice: "jingdiannvsheng", speed: 1 });
    expect(output).toContain("\"type\":\"voice.tts\"");
    expect(output).toContain("brain-stepfun-realtime");
    expect((await fs.stat(out)).size).toBeGreaterThan(44);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

async function createSpeechFixture(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-cli-voice-"));
  process.env.LYNN_HOME = path.join(dir, "home");
  const pcm = Buffer.alloc(24000 * 2);
  for (let i = 0; i < 24000; i += 1) {
    const sample = Math.round(Math.sin((i / 24000) * Math.PI * 2 * 440) * 12000);
    pcm.writeInt16LE(sample, i * 2);
  }
  const wav = path.join(dir, "speech.wav");
  await fs.writeFile(wav, pcm16ToWav(pcm));
  return wav;
}

function listen(server: http.Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("server failed to listen");
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function captureStdout(run: () => Promise<void>): Promise<string> {
  const original = process.stdout.write;
  let output = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    await run();
    return output;
  } finally {
    process.stdout.write = original;
  }
}
