import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getStringFlag, hasFlag, type ParsedArgs } from "./args.js";
import { signedBrainHeaders } from "./brain-auth.js";
import { brainEndpointUrl, resolveDefaultBrainUrl } from "./brain-url.js";
import { prepareStepFunRealtimePcm24k } from "./voice-audio.js";

export interface VoiceTranscript {
  text: string;
  provider?: string;
}

export interface VoiceSynthesisResult {
  path: string;
  provider?: string;
  mimeType?: string;
}

export function voiceInputRequested(args: ParsedArgs): boolean {
  return !!resolveVoiceFile(args) || hasFlag(args.flags, "voice-stdin", "record");
}

export function voiceTtsRequested(args: ParsedArgs): boolean {
  return !!getStringFlag(args.flags, "speak", "tts");
}

export function mergePromptAndVoice(prompt: string, transcript: string): string {
  const cleanPrompt = prompt.trim();
  const cleanTranscript = transcript.trim();
  if (!cleanTranscript) return cleanPrompt;
  if (!cleanPrompt) return cleanTranscript;
  if (cleanPrompt === "-") return cleanPrompt;
  return `${cleanPrompt}\n\n--- voice transcript ---\n${cleanTranscript}`;
}

export async function transcribeVoiceInput(args: ParsedArgs): Promise<VoiceTranscript | null> {
  if (!voiceInputRequested(args)) return null;
  const audio = await readVoiceAudio(args);
  return transcribeVoiceAudio(args, audio);
}

export async function transcribeVoiceAudio(args: ParsedArgs, audio: Buffer): Promise<VoiceTranscript> {
  const pcm = prepareStepFunRealtimePcm24k(audio);
  const brainUrl = await resolveDefaultBrainUrl(args);
  const pathname = "/v1/voice/asr";
  const ctrl = new AbortController();
  const timeoutMs = Number(getStringFlag(args.flags, "timeout-ms", "timeout") || 45000);
  const timer = setTimeout(() => ctrl.abort(), Math.max(1000, timeoutMs));
  try {
    const res = await fetch(brainEndpointUrl(brainUrl, pathname), {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "content-type": "application/json",
        ...signedBrainHeaders({ pathname }),
      },
      body: JSON.stringify({
        audio_base64: pcm.toString("base64"),
        audio_pcm_base64: pcm.toString("base64"),
        sample_rate: 24000,
        language: getStringFlag(args.flags, "language") || "auto",
      }),
    });
    const raw = await res.text();
    const json = parseJson(raw);
    if (!res.ok || json?.ok === false) {
      const detail = typeof json?.error === "string" ? json.error : raw.slice(0, 240);
      throw new Error(`voice ASR failed: ${res.status} ${res.statusText}${detail ? ` · ${detail}` : ""}`.trim());
    }
    const text = normalizeText(json?.text ?? json?.transcript ?? json?.data?.text ?? json?.data?.transcript);
    if (!text) throw new Error("voice ASR returned empty transcript");
    const provider = normalizeText(json?.provider ?? json?.data?.provider);
    return provider ? { text, provider } : { text };
  } catch (error) {
    if ((error as Error).name === "AbortError") throw new Error(`voice ASR timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function synthesizeVoiceOutput(args: ParsedArgs): Promise<VoiceSynthesisResult | null> {
  const text = getStringFlag(args.flags, "speak", "tts");
  if (!text) return null;
  const brainUrl = await resolveDefaultBrainUrl(args);
  const pathname = "/v1/voice/tts";
  const ctrl = new AbortController();
  const timeoutMs = Number(getStringFlag(args.flags, "timeout-ms", "timeout") || 45000);
  const timer = setTimeout(() => ctrl.abort(), Math.max(1000, timeoutMs));
  try {
    const res = await fetch(brainEndpointUrl(brainUrl, pathname), {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "content-type": "application/json",
        ...signedBrainHeaders({ pathname }),
      },
      body: JSON.stringify({
        text,
        voice: getStringFlag(args.flags, "voice") || "jingdiannvsheng",
        speed: Number(getStringFlag(args.flags, "speed") || 1),
      }),
    });
    const raw = await res.text();
    const json = parseJson(raw);
    if (!res.ok || json?.ok === false) {
      const detail = typeof json?.error === "string" ? json.error : raw.slice(0, 240);
      throw new Error(`voice TTS failed: ${res.status} ${res.statusText}${detail ? ` · ${detail}` : ""}`.trim());
    }
    const audioBase64 = normalizeText(json?.audio_base64 ?? json?.audio ?? json?.data?.audio_base64 ?? json?.data?.audio);
    if (!audioBase64) throw new Error("voice TTS returned empty audio");
    const mimeType = normalizeText(json?.mime_type ?? json?.mimeType ?? json?.data?.mime_type ?? json?.data?.mimeType) || "audio/wav";
    const provider = normalizeText(json?.provider ?? json?.data?.provider);
    const audio = Buffer.from(audioBase64, "base64");
    const output = getStringFlag(args.flags, "output", "out")
      || path.join(process.cwd(), `lynn-voice-${Date.now()}.${mimeType.includes("mpeg") ? "mp3" : "wav"}`);
    const outPath = path.resolve(output.replace(/^~/, os.homedir()));
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, audio);
    return { path: outPath, provider: provider || "brain-stepfun-realtime", mimeType };
  } catch (error) {
    if ((error as Error).name === "AbortError") throw new Error(`voice TTS timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function stripVoiceFlags(args: ParsedArgs): ParsedArgs {
  const flags = { ...args.flags };
  for (const key of ["voice-file", "file", "audio", "voice-stdin", "record", "seconds", "duration", "language", "speak", "tts", "output", "out", "voice", "speed", "once", "transcribe-only", "no-send", "idle-timeout-ms", "idle-timeout", "max-seconds", "speech-rms", "silence-rms", "end-silence-ms"]) {
    delete flags[key];
  }
  return { ...args, flags };
}

async function readVoiceAudio(args: ParsedArgs): Promise<Buffer> {
  const file = resolveVoiceFile(args);
  if (file) return fs.readFile(file);
  if (hasFlag(args.flags, "voice-stdin")) return readAllStdin();
  if (hasFlag(args.flags, "record")) return recordVoice(args);
  throw new Error("voice input required: use --file <wav>, --voice-file <wav>, --voice-stdin, or --record <seconds>");
}

function resolveVoiceFile(args: ParsedArgs): string | null {
  const value = getStringFlag(args.flags, "voice-file", "file", "audio");
  return value ? path.resolve(value.replace(/^~/, os.homedir())) : null;
}

function readAllStdin(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
    process.stdin.once("end", () => resolve(Buffer.concat(chunks)));
    process.stdin.once("error", reject);
    process.stdin.resume();
  });
}

async function recordVoice(args: ParsedArgs): Promise<Buffer> {
  const secondsRaw = getStringFlag(args.flags, "record", "seconds", "duration") || "5";
  const seconds = Math.min(60, Math.max(1, Number(secondsRaw) || 5));
  const file = path.join(os.tmpdir(), `lynn-voice-${Date.now()}-${Math.random().toString(16).slice(2)}.wav`);
  const input = process.platform === "darwin" ? ":0" : "default";
  const formatArgs = process.platform === "darwin"
    ? ["-f", "avfoundation", "-i", input]
    : ["-f", process.platform === "win32" ? "dshow" : "pulse", "-i", input];
  await runProcess("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    ...formatArgs,
    "-t",
    String(seconds),
    "-ac",
    "1",
    "-ar",
    "24000",
    "-sample_fmt",
    "s16",
    "-f",
    "wav",
    file,
  ]);
  try {
    return await fs.readFile(file);
  } finally {
    await fs.unlink(file).catch(() => undefined);
  }
}

function runProcess(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error(`${command} is required for --record; install ffmpeg or use --file <wav>`));
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

function parseJson(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
