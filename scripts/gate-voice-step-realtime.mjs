#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createBrainRealtimeTtsProvider } from "../server/clients/brain-realtime-voice.ts";
import { makeFrame, normalizeTtsAudioToPcm16Mono16k, parseFrame, PCM_TTS_CHUNK_BYTES } from "../server/chat/voice-audio-codec.ts";
import { VoiceSession } from "../server/chat/voice-session.ts";
import { FRAME, STATE } from "../server/chat/voice-ws-types.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const phrase = process.env.LYNN_VOICE_GATE_TEXT || "门禁测试完成";
const phraseTerms = (process.env.LYNN_VOICE_GATE_TERMS || "门禁,测试,完成")
  .split(",")
  .map((term) => term.trim())
  .filter(Boolean);
const reply = "语音回合通过";
const timeoutMs = Number(process.env.LYNN_VOICE_GATE_TIMEOUT_MS || 90_000);

class MockWs {
  readyState = 1;
  sent = [];
  send(buf) {
    this.sent.push(Buffer.from(buf));
  }
}

if (process.env.LYNN_SKIP_REAL_VOICE_GATE === "1") {
  console.log("SKIP real StepFun Realtime voice gate (LYNN_SKIP_REAL_VOICE_GATE=1)");
  process.exit(0);
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-step-voice-gate-"));

try {
  await withTimeout(runCliRoundTrip(), timeoutMs, "CLI StepFun Realtime voice round-trip");
  await withTimeout(runVoiceSessionRoundTrip(), timeoutMs, "GUI VoiceSession StepFun Realtime round-trip");
  console.log("PASS StepFun Realtime voice gate");
  process.exit(0);
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}

async function runCliRoundTrip() {
  const wav = path.join(tmp, "cli-step-tts.wav");
  const tts = await runCli(["voice", "--speak", phrase, "--out", wav, "--json"]);
  assertIncludes(tts.stdout, "voice.tts", "CLI TTS event missing");
  const stat = await fs.stat(wav);
  if (stat.size < 1000) throw new Error(`CLI TTS wrote a tiny/empty file: ${stat.size} bytes`);

  const asr = await runCli(["voice", "--file", wav, "--json"]);
  assertIncludes(asr.stdout, "voice.transcript", "CLI ASR event missing");
  assertSemantic(asr.stdout, phraseTerms, `CLI ASR did not recognize the gate phrase:\n${asr.stdout}`);
}

async function runVoiceSessionRoundTrip() {
  const ttsProvider = createBrainRealtimeTtsProvider();
  const asrProvider = createCliBrainAsrProvider();
  const spoken = await ttsProvider.synthesize(phrase);
  const pcm = normalizeTtsAudioToPcm16Mono16k(spoken.audio);
  if (pcm.length < PCM_TTS_CHUNK_BYTES) throw new Error(`Brain StepFun TTS returned too little PCM: ${pcm.length} bytes`);

  const ws = new MockWs();
  const session = new VoiceSession(ws, {
    engine: { config: { voice: { asr: {}, tts: {} }, providers: {} } },
    hub: {},
    healthOnOpen: false,
    asrProvider,
    serProvider: {
      health: async () => true,
      warmup: async () => true,
      classify: async () => null,
    },
    ttsProvider,
    brainRunner: async () => reply,
    aec: { createProcessor: () => null, processRender: () => {}, processCapture: (_handle, mic) => mic },
  });

  session.onOpen();
  let seq = 0;
  for (let offset = 0; offset < pcm.length; offset += PCM_TTS_CHUNK_BYTES) {
    const chunk = pcm.subarray(offset, Math.min(offset + PCM_TTS_CHUNK_BYTES, pcm.length));
    if (chunk.length === 0) continue;
    await session.onAudio(parseFrame(makeFrame(FRAME.PCM_AUDIO, 0, seq++, chunk)));
  }
  await session.endOfTurn();

  const transcript = decodeLast(ws.sent, FRAME.TRANSCRIPT_FINAL);
  assertSemantic(transcript, phraseTerms, `GUI VoiceSession ASR did not recognize the gate phrase: ${transcript}`);
  const assistant = decodeLast(ws.sent, FRAME.ASSISTANT_REPLY);
  assertIncludes(assistant, reply, `GUI VoiceSession did not emit assistant reply: ${assistant}`);
  const states = ws.sent.filter((buf) => buf[0] === FRAME.STATE_CHANGE).map((buf) => buf.subarray(4).toString("utf8"));
  if (!states.includes(STATE.THINKING) || !states.includes(STATE.SPEAKING) || states.at(-1) !== STATE.IDLE) {
    throw new Error(`GUI VoiceSession state flow invalid: ${states.join(" -> ")}`);
  }
  if (!ws.sent.some((buf) => buf[0] === FRAME.PCM_TTS)) {
    throw new Error("GUI VoiceSession did not stream TTS PCM back to the client");
  }
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "cli/bin/lynn.mjs"), ...args], {
      cwd: root,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Lynn ${args.join(" ")} exited ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
  });
}

function createCliBrainAsrProvider() {
  return {
    name: "cli-brain-realtime-asr",
    label: "Lynn CLI Brain StepFun Realtime ASR",
    async health() {
      return { ok: true, fallbackOk: false, degraded: false, provider: "stepfun-realtime" };
    },
    async transcribe(audioBuffer) {
      const wav = path.join(tmp, `voice-session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
      await fs.writeFile(wav, Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer || []));
      const result = await runCli(["voice", "--file", wav, "--json"]);
      const event = parseJsonLine(result.stdout, "voice.transcript");
      const text = String(event?.text || "").trim();
      if (!text) throw new Error(`VoiceSession ASR returned no transcript:\n${result.stdout}`);
      return { text, provider: String(event?.provider || "stepfun-realtime") };
    },
  };
}

function parseJsonLine(stdout, type) {
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (!type || parsed?.type === type) return parsed;
    } catch {
      // ignore non-json lines
    }
  }
  return null;
}

function decodeLast(frames, type) {
  const frame = frames.filter((buf) => buf[0] === type).at(-1);
  return frame ? frame.subarray(4).toString("utf8") : "";
}

function assertIncludes(value, needle, message) {
  if (!String(value || "").includes(needle)) throw new Error(message);
}

function assertSemantic(value, terms, message) {
  const text = String(value || "");
  if (!terms.every((term) => text.includes(term))) throw new Error(message);
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}
