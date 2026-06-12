#!/usr/bin/env node

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(root, "cli", "bin", "lynn.mjs");
const timeoutMs = Number.parseInt(process.env.LYNN_CLI_VOICE_PTY_TIMEOUT_MS || "30000", 10);
const commands = ["/voice", "lynn voice"];
const fakeBin = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-cli-voice-bin-"));

if (!Number.isFinite(timeoutMs) || timeoutMs < 10_000) {
  throw new Error("LYNN_CLI_VOICE_PTY_TIMEOUT_MS must be at least 10000");
}

const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await new Promise((resolve) => wss.once("listening", resolve));
const address = wss.address();
const brainUrl = `http://127.0.0.1:${address.port}`;

let connections = 0;
const sessions = [];
wss.on("connection", (ws, request) => {
  if (request.url && !request.url.startsWith("/v1/voice/realtime")) {
    ws.close(1008, "unexpected path");
    return;
  }
  connections += 1;
  const session = { binaryBytes: 0, commits: 0, configModes: [] };
  sessions.push(session);
  ws.send(JSON.stringify({ type: "ready" }));
  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      session.binaryBytes += Buffer.byteLength(data);
      return;
    }
    let msg = {};
    try { msg = JSON.parse(Buffer.from(data).toString("utf-8")); } catch { return; }
    if (msg.type === "config") session.configModes.push(String(msg.mode || ""));
    if (msg.type === "commit") {
      session.commits += 1;
      ws.send(JSON.stringify({ type: "user_transcript", text: "哈喽哈喽在吗", final: true }));
      ws.send(JSON.stringify({ type: "assistant_transcript", text: "在的。", done: true }));
      ws.send(JSON.stringify({ type: "response_done" }));
    }
  });
});

try {
  await installFakeAudioTools(fakeBin);
  for (const command of commands) {
    await runCase(command);
  }
  if (connections < commands.length) {
    throw new Error(`expected ${commands.length} realtime connections, got ${connections}`);
  }
  sessions.forEach((session, index) => {
    if (!session.configModes.includes("ptt")) {
      throw new Error(`session ${index} did not request manual realtime turns: ${session.configModes.join(",")}`);
    }
    if (session.binaryBytes <= 0) {
      throw new Error(`session ${index} did not stream microphone audio`);
    }
    if (session.commits <= 0) {
      throw new Error(`session ${index} did not commit the local VAD turn`);
    }
  });
  console.log("PASS cli voice REPL PTY smoke");
} finally {
  await new Promise((resolve) => wss.close(resolve));
  await fs.rm(fakeBin, { recursive: true, force: true });
}

async function runCase(command) {
  const python = String.raw`
import os, pty, select, signal, sys, time, re

root, node_path, cli_entry, brain_url, command, timeout_ms, fake_bin = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5], int(sys.argv[6]), sys.argv[7]
env = os.environ.copy()
env.update({
  "TERM": "xterm-256color",
  "TERM_PROGRAM": "Apple_Terminal",
  "LYNN_CLI_UPDATE_CHECK": "0",
  "LYNN_CLI_VOICE_RAW_MIC": "1",
  "LYNN_LANG": "zh",
})
env["PATH"] = fake_bin + os.pathsep + env.get("PATH", "")

pid, fd = pty.fork()
if pid == 0:
  os.chdir(root)
  os.execve(node_path, [node_path, cli_entry, "--mock-brain", "--brain-url", brain_url], env)

output = b""
stage = 0
prompt_seen_at = None
typed_index = 0
last_typed_at = 0
deadline = time.time() + (timeout_ms / 1000.0)
exit_code = None

def plain():
  text = output.decode("utf-8", "ignore")
  text = re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]", "", text)
  text = re.sub(r"\x1b\][^\x07]*(?:\x07|\x1b\\\\)", "", text)
  return text

try:
  while time.time() < deadline:
    done, status = os.waitpid(pid, os.WNOHANG)
    if done == pid:
      if os.WIFEXITED(status):
        exit_code = os.WEXITSTATUS(status)
      elif os.WIFSIGNALED(status):
        exit_code = 128 + os.WTERMSIG(status)
      break

    readable, _, _ = select.select([fd], [], [], 0.1)
    if fd in readable:
      try:
        chunk = os.read(fd, 4096)
      except OSError:
        chunk = b""
      if chunk:
        output += chunk

    text = plain()
    if stage == 0 and "›" in text:
      if prompt_seen_at is None:
        prompt_seen_at = time.time()
      elif time.time() - prompt_seen_at > 0.6:
        stage = 1
        last_typed_at = 0
    elif stage == 1:
      now = time.time()
      if typed_index < len(command) and now - last_typed_at > 0.035:
        os.write(fd, command[typed_index].encode("utf-8"))
        typed_index += 1
        last_typed_at = now
      elif typed_index >= len(command) and now - last_typed_at > 0.15:
        os.write(fd, b"\r")
        stage = 2
    elif stage == 2 and "进入实时语音对话" in text and "Lynn 实时语音" in text:
      stage = 3
    elif stage == 3 and "Lynn: 在的。" in text:
      os.write(fd, b"\x03")
      stage = 4
    elif stage == 4 and "已返回聊天" in text:
      stage = 5
    elif stage == 5 and "›" in text:
      os.write(fd, b"\x03")
      stage = 6

  if exit_code is None:
    try:
      os.kill(pid, signal.SIGTERM)
    except OSError:
      pass
    raise RuntimeError("timed out waiting for Lynn voice REPL smoke")

  text = plain()
  if exit_code != 0:
    raise RuntimeError(f"Lynn exited {exit_code}")
  if stage < 6:
    raise RuntimeError(f"Lynn exited before completing command={command!r}, stage={stage}")
  if "模拟回复" in text:
    raise RuntimeError(f"voice command leaked to mock chat model: {command}")
  if "Cannot find module" in text or "TypeError" in text or "ReferenceError" in text:
    raise RuntimeError("detected crash-like output")
except Exception as exc:
  text = plain()
  tail = "\n".join(text.splitlines()[-100:])
  print(f"[cli-voice-repl-pty-smoke] {exc}\n--- output tail ---\n{tail}", file=sys.stderr)
  sys.exit(1)
`;

  await execFileAsync(
    process.env.PYTHON || "python3",
    ["-c", python, root, process.execPath, cliEntry, brainUrl, command, String(timeoutMs), fakeBin],
    { timeout: timeoutMs + 5_000 },
  );
}

async function installFakeAudioTools(dir) {
  const ffmpeg = path.join(dir, "ffmpeg");
  const script = `#!/usr/bin/env node
const sampleRate = 24000;
const frameSamples = sampleRate / 10;
function frame(amplitude) {
  const buf = Buffer.alloc(frameSamples * 2);
  for (let i = 0; i < frameSamples; i += 1) {
    const sample = amplitude ? Math.round(Math.sin((i / sampleRate) * Math.PI * 2 * 440) * amplitude) : 0;
    buf.writeInt16LE(sample, i * 2);
  }
  return buf;
}
const frames = [
  ...Array.from({ length: 3 }, () => frame(0)),
  ...Array.from({ length: 10 }, () => frame(14000)),
  ...Array.from({ length: 12 }, () => frame(0)),
];
let i = 0;
const timer = setInterval(() => {
  if (i >= frames.length) {
    clearInterval(timer);
    return;
  }
  process.stdout.write(frames[i]);
  i += 1;
}, 80);
`;
  await fs.writeFile(ffmpeg, script, { mode: 0o755 });
}

function execFileAsync(command, args, options) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      if (error) {
        error.message += `\nstdout:\n${stdout}\nstderr:\n${stderr}`;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}
