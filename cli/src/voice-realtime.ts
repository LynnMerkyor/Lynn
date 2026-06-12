// Lynn CLI · realtime full-duplex voice (2026-06-11)
//
// A Step-Realtime-CLI-style experience: open the mic, stream PCM to the Brain-hosted StepFun
// Realtime engine over a signed WebSocket, play the assistant's audio back as it streams, and
// render a live sampled waveform under the prompt so it feels like a conversation.
//
//   ffmpeg (mic, 24kHz s16le)  ──binary PCM──▶  ws  ──▶ Brain ──▶ StepFun Realtime
//   afplay (speaker)           ◀──binary PCM──  ws  ◀── assistant audio (buffered per reply)
//
// No StepFun key locally — the Brain holds it. Ctrl+C to exit.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// ws ships no bundled types in this workspace; the API surface we use (new/on/send/close/OPEN)
// is tiny and exercised at runtime, so treat the default import as untyped.
// @ts-expect-error - no @types/ws in the CLI workspace
import WebSocket from "ws";
import { signedBrainHeaders } from "./brain-auth.js";
import { resolveDefaultBrainUrl } from "./brain-url.js";
import { hasFlag, getStringFlag, type ParsedArgs } from "./args.js";

const PATHNAME = "/v1/voice/realtime";
const SAMPLE_RATE = 24000;
const FRAME_BYTES = SAMPLE_RATE * 2 / 10; // 100ms @24kHz Int16 = 4800 bytes
const WAVE_WIDTH = 28;
const BARS = " ▁▂▃▄▅▆▇█";
const SPEECH_RMS = 0.006;
const SILENCE_RMS = 0.003;
const MIN_SPEECH_FRAMES = 2;
const END_SILENCE_FRAMES = 7;
const COMMIT_COOLDOWN_MS = 900;
const MAX_TURN_MS = 10_000;

function wsUrlFromBrain(brainUrl: string): string {
  const base = brainUrl.replace(/^https:/i, "wss:").replace(/^http:/i, "ws:").replace(/\/+$/, "");
  return `${base}${PATHNAME}`;
}

function rms(buf: Buffer): number {
  const n = Math.floor(buf.length / 2);
  if (n <= 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i += 1) { const s = buf.readInt16LE(i * 2) / 32768; sum += s * s; }
  return Math.sqrt(sum / n);
}

function micInputArgs(): string[] {
  if (process.platform === "darwin") return ["-f", "avfoundation", "-i", ":0"];
  if (process.platform === "win32") return ["-f", "dshow", "-i", "audio=default"];
  return ["-f", "pulse", "-i", "default"];
}

function micFilterArgs(): string[] {
  // Raw mic by default — verified working in a live call. dynaudnorm dynamically normalized the
  // level, which raised the silence floor so the local VAD never detected end-of-speech (UI stuck
  // at "听到了", no commit, no reply). Raw keeps the speech↔silence gap the VAD needs. The old
  // filter is opt-in via LYNN_CLI_VOICE_MIC_FILTER=1 for experimentation only.
  if (process.env.LYNN_CLI_VOICE_MIC_FILTER === "1") {
    return ["-af", "highpass=f=80,dynaudnorm=f=150:g=15:p=0.95,alimiter=limit=0.95"];
  }
  return [];
}

export async function runRealtimeVoice(args: ParsedArgs, options: { json?: boolean; embedded?: boolean } = {}): Promise<number> {
  const ptt = hasFlag(args.flags, "ptt", "push-to-talk");
  const ctrlCHint = options.embedded ? "返回聊天" : "退出";
  const voice = getStringFlag(args.flags, "voice") || "";
  const brainUrl = await resolveDefaultBrainUrl(args);
  const qs: string[] = [];
  // The CLI keeps the mic open continuously but drives turn boundaries locally.
  // Brain/StepFun therefore run with manual turn detection for both hands-free
  // and explicit PTT modes; otherwise server_vad and local VAD can fight and
  // leave the UI stuck at "在听" with no response.
  qs.push("mode=ptt");
  if (voice) qs.push(`voice=${encodeURIComponent(voice)}`);
  const url = wsUrlFromBrain(brainUrl) + (qs.length ? `?${qs.join("&")}` : "");
  let headers: Record<string, string> = {};
  try { headers = signedBrainHeaders({ method: "GET", pathname: PATHNAME }) as Record<string, string>; }
  catch (err) { process.stderr.write(`语音签名失败:${(err as Error).message}\n`); return 1; }

  // ── shared UI state ──
  type Phase = "connecting" | "listening" | "hearing" | "thinking" | "speaking" | "degraded";
  let phase: Phase = "connecting";
  let micLevel = 0;
  let spkLevel = 0;
  let assistantBuf = "";
  const history: number[] = new Array(WAVE_WIDTH).fill(0);
  const isTTY = process.stdout.isTTY;
  let speechFrames = 0;
  let silenceFrames = 0;
  let localSpeechActive = false;
  let lastCommitAt = 0;
  let localSpeechStartedAt = 0;
  let playbackActive = false;
  let suppressMicUntil = 0;

  const phaseLabel = (): string => {
    switch (phase) {
      case "listening": return "🎤 在听";
      case "hearing": return "🎤 听到了";
      case "thinking": return "💭 思考";
      case "speaking": return "🔊 回答";
      case "degraded": return "⚠️ 降级";
      default: return "⏳ 连接";
    }
  };
  const drawWave = (): string => history.map((l) => {
    const idx = Math.max(0, Math.min(BARS.length - 1, Math.round(l * 9 * (BARS.length - 1))));
    return BARS[idx];
  }).join("");

  const render = (): void => {
    if (!isTTY) return;
    const tail = assistantBuf.replace(/\s+/g, " ").trim().slice(-32).padEnd(32);
    process.stdout.write(`\x1b[2K\r${phaseLabel()}  ${drawWave()}  ${tail}`);
  };
  const printLine = (text: string): void => {
    if (isTTY) process.stdout.write(`\x1b[2K\r${text}\n`);
    else process.stdout.write(`${text}\n`);
    render();
  };

  const renderTimer = setInterval(() => {
    const level = phase === "speaking" ? spkLevel : micLevel;
    history.push(level); history.shift();
    // gentle decay so the wave keeps "breathing" between frames
    micLevel *= 0.6; spkLevel *= 0.7;
    render();
  }, 80);

  // ── child processes ──
  let mic: ChildProcess | null = null;
  let afplayProc: ChildProcess | null = null;
  let closed = false;
  let exitCode = 0;
  let resolveSession: ((code: number) => void) | null = null;

  // Assistant playback. ffplay refuses to play raw PCM on macOS here (exits in ~30ms without
  // sound — verified), and afplay has a ~0.9s per-spawn startup so segmenting is choppy (6.6s of
  // audio took 12.2s in 1.2s segments). So buffer the WHOLE reply and play it as ONE WAV via the
  // OS player (afplay on macOS) — one startup, then smooth. StepFun streams faster than realtime,
  // so the wait-for-response_done latency is the (short) generation time, not the audio length.
  let assistantPcm = Buffer.alloc(0);
  let playSeq = 0;
  const playCmd = process.platform === "darwin" ? "afplay" : "ffplay";
  const playArgs = (file: string): string[] => process.platform === "darwin"
    ? [file]
    : ["-hide_banner", "-loglevel", "quiet", "-nodisp", "-autoexit", file];
  const wavHeader = (dataLen: number): Buffer => {
    const h = Buffer.alloc(44);
    h.write("RIFF", 0); h.writeUInt32LE(36 + dataLen, 4); h.write("WAVE", 8);
    h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
    h.writeUInt32LE(SAMPLE_RATE, 24); h.writeUInt32LE(SAMPLE_RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
    h.write("data", 36); h.writeUInt32LE(dataLen, 40);
    return h;
  };
  const enqueueAudio = (pcm: Buffer): void => {
    assistantPcm = assistantPcm.length ? Buffer.concat([assistantPcm, pcm]) : Buffer.from(pcm);
  };
  const commitTurn = (reason: string): void => {
    const now = Date.now();
    if (ptt || ws.readyState !== WebSocket.OPEN || now - lastCommitAt < COMMIT_COOLDOWN_MS) return;
    lastCommitAt = now;
    suppressMicUntil = now + 600;
    try { ws.send(JSON.stringify({ type: "commit", reason })); } catch { /* best-effort */ }
  };
  const flushAudio = (): void => {
    const pcm = assistantPcm;
    assistantPcm = Buffer.alloc(0);
    if (pcm.length < SAMPLE_RATE * 0.4) return; // ignore < ~0.4s blips
    const file = path.join(os.tmpdir(), `lynn-voice-${process.pid}-${playSeq++}.wav`);
    try { fs.writeFileSync(file, Buffer.concat([wavHeader(pcm.length), pcm])); } catch { return; }
    try { afplayProc?.kill("SIGTERM"); } catch { /* noop */ }
    playbackActive = true;
    phase = "speaking";
    afplayProc = spawn(playCmd, playArgs(file), { stdio: "ignore" });
    afplayProc.once("exit", () => {
      try { fs.unlinkSync(file); } catch { /* noop */ }
      afplayProc = null;
      playbackActive = false;
      suppressMicUntil = Date.now() + 350;
      if (!closed) phase = "listening";
    });
    afplayProc.once("error", (err: Error) => {
      printLine(`播放失败:${err.message || playCmd};已保留文字回复。`);
      afplayProc = null;
      playbackActive = false;
      suppressMicUntil = Date.now() + 350;
    });
  };
  const stopPlayback = (): void => {
    assistantPcm = Buffer.alloc(0);
    try { afplayProc?.kill("SIGTERM"); } catch { /* noop */ }
    afplayProc = null;
    playbackActive = false;
  };

  const startMic = (): void => {
    mic = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin", ...micInputArgs(),
      ...micFilterArgs(),
      "-ac", "1", "-ar", String(SAMPLE_RATE), "-sample_fmt", "s16", "-f", "s16le", "pipe:1",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let pending = Buffer.alloc(0);
    mic.stdout?.on("data", (chunk: Buffer) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk);
      while (pending.length >= FRAME_BYTES) {
        const frame = pending.subarray(0, FRAME_BYTES);
        pending = pending.subarray(FRAME_BYTES);
        const level = rms(frame);
        micLevel = Math.max(micLevel, level);
        const now = Date.now();
        const canCapture = !playbackActive && phase !== "speaking" && phase !== "thinking" && now >= suppressMicUntil;
        if (!ptt) {
          if (!canCapture) {
            speechFrames = 0;
            silenceFrames = 0;
            localSpeechActive = false;
          } else if (level >= SPEECH_RMS) {
            speechFrames += 1;
            silenceFrames = 0;
            if (!localSpeechActive && speechFrames >= MIN_SPEECH_FRAMES) {
              localSpeechActive = true;
              localSpeechStartedAt = now;
              phase = "hearing";
            }
          } else if (localSpeechActive && level <= SILENCE_RMS) {
            silenceFrames += 1;
            if (silenceFrames >= END_SILENCE_FRAMES) {
              localSpeechActive = false;
              speechFrames = 0;
              silenceFrames = 0;
              phase = "thinking";
              commitTurn("local_silence");
            }
          } else if (localSpeechActive && localSpeechStartedAt && now - localSpeechStartedAt >= MAX_TURN_MS) {
            localSpeechActive = false;
            speechFrames = 0;
            silenceFrames = 0;
            phase = "thinking";
            commitTurn("local_max_turn");
          } else if (!localSpeechActive) {
            speechFrames = Math.max(0, speechFrames - 1);
          }
        }
        if (!ptt && canCapture && ws.readyState === WebSocket.OPEN) ws.send(frame, { binary: true });
        else if (ptt && pttActive && ws.readyState === WebSocket.OPEN) ws.send(frame, { binary: true });
      }
    });
    mic.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") { printLine("需要 ffmpeg 访问麦克风;请 `brew install ffmpeg` 或用 GUI 麦克风入口。"); cleanup(1); }
    });
    mic.stderr?.on("data", (d: Buffer) => { const s = String(d); if (/Input\/output error|Permission|denied|No such/i.test(s)) printLine(`麦克风错误:${s.trim().slice(0, 120)}`); });
  };

  // PTT: hold the conversation until the user presses Space/Enter to toggle a turn
  let pttActive = !ptt; // duplex → always streaming; ptt → toggled
  let stdinHandler: ((d: Buffer) => void) | null = null;
  const setupPtt = (): void => {
    if (!ptt || !process.stdin.isTTY) return;
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    stdinHandler = (d: Buffer): void => {
      if (d[0] === 3) { cleanup(0); return; } // Ctrl+C (raw mode disables auto-SIGINT)
      const k = d.toString();
      if (k === " " || k === "\r") { // space/enter toggles a turn
        if (!pttActive) { pttActive = true; phase = "listening"; printLine("(说话中… 再按空格结束本轮)"); }
        else { pttActive = false; phase = "thinking"; if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "commit" })); }
      }
    };
    process.stdin.on("data", stdinHandler);
  };

  // handleSigint is declared before cleanup so cleanup can removeListener it (mutual closure
  // resolves at call time). Cleanup RESOLVES the session promise instead of process.exit, so the
  // function returns cleanly — required when launched from inside the chat REPL (/voice).
  const handleSigint = (): void => cleanup(0);
  const cleanup = (code: number): void => {
    if (closed) return;
    closed = true;
    exitCode = code;
    clearInterval(renderTimer);
    try { mic?.kill("SIGKILL"); } catch { /* noop */ }
    stopPlayback();
    try { process.removeListener("SIGINT", handleSigint); } catch { /* noop */ }
    try { if (stdinHandler) { process.stdin.removeListener("data", stdinHandler); stdinHandler = null; } } catch { /* noop */ }
    try { if (ptt && process.stdin.isTTY) { process.stdin.setRawMode?.(false); process.stdin.pause(); } } catch { /* noop */ }
    try { ws.close(); } catch { /* noop */ }
    if (isTTY) process.stdout.write("\x1b[2K\r");
    process.stdout.write(options.embedded ? "已返回聊天。\n" : "语音对话结束。\n");
    if (!options.embedded) process.exitCode = code;
    resolveSession?.(code);
  };

  // ── connect ──
  if (options.embedded) process.stdout.write("进入实时语音对话…(Ctrl+C 返回聊天)\n");
  process.stdout.write(`Lynn 实时语音 · StepFun Realtime(Brain 托管)\n`);
  process.stdout.write(ptt ? `按 空格 开始/结束一轮,Ctrl+C ${ctrlCHint}。\n` : `直接说话,说完停顿即可;Ctrl+C ${ctrlCHint}。\n`);

  const ws = new WebSocket(url, { headers });
  ws.on("open", () => { /* wait for ready */ });
  ws.on("unexpected-response", (_req: unknown, res: { statusCode?: number }) => {
    printLine(`连接被拒(HTTP ${res?.statusCode ?? "?"});请确认已登录 Lynn。`); cleanup(1);
  });
  ws.on("message", (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      spkLevel = Math.max(spkLevel, rms(data));
      if (phase !== "speaking") phase = "speaking";
      enqueueAudio(Buffer.isBuffer(data) ? data : Buffer.from(data));
      return;
    }
    let evt: { type?: string; text?: string; done?: boolean; message?: string };
    try { evt = JSON.parse(data.toString("utf-8")); } catch { return; }
    switch (evt.type) {
      case "ready":
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "config", mode: "ptt", voice }));
        startMic(); setupPtt();
        phase = "listening";
        printLine("已连接,开始对话。");
        break;
      case "speech_started":
        stopPlayback(); phase = "listening"; assistantBuf = "";
        localSpeechActive = true; speechFrames = MIN_SPEECH_FRAMES; silenceFrames = 0;
        break; // barge-in
      case "speech_stopped":
        phase = "thinking";
        localSpeechActive = false; speechFrames = 0; silenceFrames = 0;
        break;
      case "user_transcript": if (evt.text) printLine(`你:  ${evt.text}`); break;
      case "assistant_transcript":
        phase = "speaking";
        if (evt.done) { if (evt.text) printLine(`Lynn: ${evt.text}`); assistantBuf = ""; }
        else { assistantBuf += evt.text || ""; }
        break;
      case "response_done": flushAudio(); phase = "listening"; spkLevel = 0; break;
      case "error": phase = "degraded"; printLine(`语音异常:${evt.message || "unknown"}`); break;
      default: break;
    }
  });
  ws.on("error", (err: Error) => { printLine(`语音连接失败:${err.message}`); cleanup(1); });
  ws.on("close", () => { if (!closed) { printLine("连接已关闭。"); cleanup(0); } });

  process.on("SIGINT", handleSigint);

  // resolve when cleanup runs (returns to caller — shell exits, or the REPL re-enters chat)
  const code = await new Promise<number>((resolve) => {
    resolveSession = resolve;
    if (closed) resolve(exitCode); // cleanup already ran during synchronous setup
  });
  // standalone `lynn voice` exits the process; embedded (/voice from the chat REPL) returns so
  // runInkChat can re-render the chat.
  if (!options.embedded) process.exit(code);
  return code;
}
