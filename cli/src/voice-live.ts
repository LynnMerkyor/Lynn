import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getStringFlag, hasFlag, type ParsedArgs } from "./args.js";
import { nowIso, writeJsonLine } from "./jsonl.js";
import { runPrompt } from "./commands/prompt.js";
import { pcm16ToWav } from "./voice-audio.js";
import { stripVoiceFlags, synthesizeVoiceOutput, transcribeVoiceAudio } from "./voice-client.js";

const SAMPLE_RATE = 24_000;
const FRAME_MS = 100;
const FRAME_BYTES = SAMPLE_RATE * 2 * FRAME_MS / 1000;

export async function runLiveVoiceLoop(args: ParsedArgs, options: { json?: boolean } = {}): Promise<number> {
  const once = hasFlag(args.flags, "once");
  const speakReplies = !hasFlag(args.flags, "no-speak", "text-only");
  if (!options.json) {
    process.stdout.write("Lynn voice 已进入实时语音模式。安静环境直接说话,停顿后自动发送并语音回答; 嘈杂环境可加 --once 单轮使用; Ctrl+C 退出。\n");
  } else {
    writeJsonLine({ type: "voice.live.start", ts: nowIso(), speakReplies });
  }
  do {
    const audio = await captureOneUtterance(args);
    if (!audio) {
      if (options.json) writeJsonLine({ type: "voice.live.idle", ts: nowIso() });
      else process.stdout.write("未检测到有效语音。\n");
      return 0;
    }
    const transcript = await transcribeVoiceAudio(args, pcm16ToWav(audio));
    if (options.json) {
      writeJsonLine({ type: "voice.transcript", ts: nowIso(), text: transcript.text, provider: transcript.provider });
    } else {
      process.stdout.write(`你:${transcript.text}\n`);
    }
    if (hasFlag(args.flags, "transcribe-only", "no-send")) {
      if (once) return 0;
      continue;
    }
    const next = stripVoiceFlags(args);
    await runPrompt({
      ...next,
      command: "prompt",
      positionals: [transcript.text],
      flags: { ...next.flags, p: transcript.text },
    }, {
      ...options,
      onAssistantComplete: speakReplies
        ? (answer) => speakAssistantReplySafely(args, answer, options)
        : undefined,
    });
    if (once) return 0;
    if (!options.json) process.stdout.write("\n继续说话,或 Ctrl+C 退出。\n");
  } while (true);
}

export async function speakAssistantReplySafely(args: ParsedArgs, answer: string, options: { json?: boolean }): Promise<void> {
  try {
    await speakAssistantReply(args, answer, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.json) {
      writeJsonLine({ type: "voice.reply_audio.error", ts: nowIso(), error: message });
    } else {
      process.stderr.write(`语音回答失败,已保留文字回答:${message}\n`);
    }
  }
}

async function speakAssistantReply(args: ParsedArgs, answer: string, options: { json?: boolean }): Promise<void> {
  const text = String(answer || "").trim();
  if (!text) return;
  const out = path.join(os.tmpdir(), `lynn-voice-reply-${Date.now()}-${Math.random().toString(16).slice(2)}.wav`);
  const next = stripVoiceFlags(args);
  const result = await synthesizeVoiceOutput({
    ...next,
    flags: {
      ...next.flags,
      speak: text,
      out,
    },
  });
  if (!result?.path) return;
  if (options.json) {
    writeJsonLine({ type: "voice.reply_audio", ts: nowIso(), path: result.path, provider: result.provider, mimeType: result.mimeType });
  } else {
    process.stdout.write(`语音回答:${result.provider || "stepfun-realtime"}\n`);
  }
  try {
    await playAudioFile(result.path);
  } finally {
    await fs.unlink(result.path).catch(() => undefined);
  }
}

function playAudioFile(file: string): Promise<void> {
  const command = process.platform === "darwin" ? "afplay" : "ffplay";
  const args = process.platform === "darwin"
    ? [file]
    : ["-nodisp", "-autoexit", "-loglevel", "error", file];
  return runPlaybackProcess(command, args);
}

function runPlaybackProcess(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error(`${command} is required to play voice replies; use --no-speak for text-only CLI voice.`));
      } else {
        reject(error);
      }
    });
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited ${code}${stderr.trim() ? ` · ${stderr.trim().slice(0, 240)}` : ""}`));
    });
  });
}

export async function captureOneUtterance(args: ParsedArgs): Promise<Buffer | null> {
  const speechRms = Number(getStringFlag(args.flags, "speech-rms") || 0.012);
  const silenceRms = Number(getStringFlag(args.flags, "silence-rms") || 0.006);
  const idleTimeoutMs = Math.max(3000, Number(getStringFlag(args.flags, "idle-timeout-ms", "idle-timeout") || 60000));
  const maxSeconds = Math.max(3, Math.min(120, Number(getStringFlag(args.flags, "max-seconds") || 30)));
  const endSilenceFrames = Math.max(3, Math.round(Number(getStringFlag(args.flags, "end-silence-ms") || 800) / FRAME_MS));
  return new Promise((resolve, reject) => {
    const child = spawnRecorder();
    let settled = false;
    let pending = Buffer.alloc(0);
    const preroll: Buffer[] = [];
    const frames: Buffer[] = [];
    let active = false;
    let silent = 0;
    let speechFrames = 0;
    let stderr = "";

    const idleTimer = setTimeout(() => finish(null), idleTimeoutMs);
    const maxTimer = setTimeout(() => finish(active ? Buffer.concat(frames) : null), maxSeconds * 1000);

    function finish(result: Buffer | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      clearTimeout(maxTimer);
      stopRecorder(child);
      resolve(result && result.length >= SAMPLE_RATE * 2 / 4 ? result : null);
    }

    child.stdout?.on("data", (chunk) => {
      pending = Buffer.concat([pending, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      while (pending.length >= FRAME_BYTES) {
        const frame = pending.subarray(0, FRAME_BYTES);
        pending = pending.subarray(FRAME_BYTES);
        const level = rms(frame);
        if (!active) {
          preroll.push(Buffer.from(frame));
          while (preroll.length > 3) preroll.shift();
          if (level >= speechRms) {
            active = true;
            speechFrames = 1;
            frames.push(...preroll.splice(0), Buffer.from(frame));
          }
          continue;
        }
        frames.push(Buffer.from(frame));
        if (level <= silenceRms) silent += 1;
        else {
          silent = 0;
          speechFrames += 1;
        }
        if (speechFrames >= 2 && silent >= endSilenceFrames) {
          finish(Buffer.concat(frames));
        }
      }
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      clearTimeout(maxTimer);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error("Lynn voice 需要 ffmpeg 访问麦克风;请安装 ffmpeg,或用 GUI 麦克风入口。"));
      } else {
        reject(error);
      }
    });
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      clearTimeout(maxTimer);
      reject(new Error(`麦克风录音失败${code === null ? "" : `(${code})`}${stderr.trim() ? `:${stderr.trim().slice(0, 240)}` : ""}`));
    });
  });
}

function spawnRecorder(): ChildProcess {
  const inputArgs = process.platform === "darwin"
    ? ["-f", "avfoundation", "-i", ":0"]
    : ["-f", process.platform === "win32" ? "dshow" : "pulse", "-i", "default"];
  return spawn("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    ...inputArgs,
    "-ac",
    "1",
    "-ar",
    String(SAMPLE_RATE),
    "-sample_fmt",
    "s16",
    "-f",
    "s16le",
    "pipe:1",
  ], { stdio: ["ignore", "pipe", "pipe"] });
}

function stopRecorder(child: ChildProcess): void {
  if (!child.killed) child.kill("SIGTERM");
  setTimeout(() => {
    if (!child.killed) child.kill("SIGKILL");
  }, 500).unref();
}

function rms(frame: Buffer): number {
  let sum = 0;
  const samples = Math.floor(frame.length / 2);
  for (let i = 0; i < samples; i += 1) {
    const sample = frame.readInt16LE(i * 2) / 32768;
    sum += sample * sample;
  }
  return Math.sqrt(sum / Math.max(1, samples));
}
