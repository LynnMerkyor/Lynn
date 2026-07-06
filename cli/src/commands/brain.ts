import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getStringFlag, type ParsedArgs } from "../args.js";
import { checkBrainReachable } from "../brain-client.js";
import { fetchBrainProviderStatus, summarizeBrainProviderStatus } from "../brain-status.js";
import { resolveLynnHome } from "../local-server.js";

export interface BrainDirResolution {
  dir: string | null;
  checked: string[];
}

const DEFAULT_BRAIN_URL = "http://127.0.0.1:8790";

export async function runBrain(args: ParsedArgs): Promise<number> {
  const action = (args.positionals[0] || "status").toLowerCase();
  const brainUrl = getStringFlag(args.flags, "brain-url") || process.env.LYNN_BRAIN_URL || DEFAULT_BRAIN_URL;
  if (action === "status") return renderBrainStatus(brainUrl);
  if (action === "start") return startBrain(args, brainUrl);
  if (action === "stop") return stopBrain(args);
  process.stdout.write("用法: Lynn brain status | start | stop\n");
  return 2;
}

async function renderBrainStatus(brainUrl: string): Promise<number> {
  const ok = await checkBrainReachable(brainUrl, 600);
  if (!ok) {
    process.stdout.write(`Brain offline: ${brainUrl}\n`);
    return 2;
  }
  const status = await fetchBrainProviderStatus(brainUrl, 1200);
  process.stdout.write(`Brain online: ${brainUrl}\n`);
  process.stdout.write(`Route: ${summarizeBrainProviderStatus(status)}\n`);
  return 0;
}

async function startBrain(args: ParsedArgs, brainUrl: string): Promise<number> {
  if (await checkBrainReachable(brainUrl, 500)) {
    process.stdout.write(`Brain already online: ${brainUrl}\n`);
    return 0;
  }

  const resolved = resolveBrainProjectDir(getStringFlag(args.flags, "brain-dir"));
  if (!resolved.dir) {
    process.stdout.write([
      "找不到 brain-v2-mirror 目录,无法由 CLI 启动本地 Brain。",
      "可选:",
      "  1. 打开 Lynn 客户端",
      "  2. 在仓库根目录运行: cd brain-v2-mirror && npm start",
      "  3. 或指定: Lynn brain start --brain-dir /path/to/brain-v2-mirror",
      `检查过: ${resolved.checked.join(", ")}`,
      "",
    ].join("\n"));
    return 2;
  }

  const home = resolveLynnHome(getStringFlag(args.flags, "data-dir"));
  const logDir = path.join(home, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, "brain-v2.log");
  const out = fs.openSync(logFile, "a");
  const child = spawn("npm", ["start"], {
    cwd: resolved.dir,
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env },
    windowsHide: true,
  });
  child.unref();
  fs.writeFileSync(path.join(home, "brain-v2.pid"), `${child.pid}\n`, "utf8");

  for (let i = 0; i < 25; i += 1) {
    if (await checkBrainReachable(brainUrl, 250)) {
      process.stdout.write(`Brain started: ${brainUrl}\nLog: ${logFile}\n`);
      return 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  process.stdout.write(`Brain start command issued(pid ${child.pid}),但健康检查还没 ready。\nLog: ${logFile}\n`);
  return 1;
}

async function stopBrain(args: ParsedArgs): Promise<number> {
  const home = resolveLynnHome(getStringFlag(args.flags, "data-dir"));
  const pidFile = path.join(home, "brain-v2.pid");
  let pid = 0;
  try {
    pid = Number(fs.readFileSync(pidFile, "utf8").trim());
  } catch {
    process.stdout.write("没有找到 CLI 启动的 Brain pid 文件。\n");
    return 2;
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    process.stdout.write("Brain pid 文件无效。\n");
    return 2;
  }
  try {
    process.kill(pid, "SIGINT");
    process.stdout.write(`Brain stop signal sent(pid ${pid}).\n`);
    return 0;
  } catch (error) {
    process.stdout.write(`Brain stop failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

export function resolveBrainProjectDir(explicit?: string | null): BrainDirResolution {
  const here = path.dirname(fileURLToPath(import.meta.url));
  if (explicit) {
    const dir = path.resolve(explicit.replace(/^~/, process.env.HOME || ""));
    if (fs.existsSync(path.join(dir, "package.json")) && fs.existsSync(path.join(dir, "server.ts"))) {
      return { dir, checked: [dir] };
    }
    return { dir: null, checked: [dir] };
  }
  const candidates = [
    process.env.LYNN_BRAIN_V2_DIR || "",
    path.join(process.cwd(), "brain-v2-mirror"),
    path.join(process.cwd(), "..", "brain-v2-mirror"),
    path.resolve(here, "..", "..", "brain-v2-mirror"),
    path.resolve(here, "..", "..", "..", "brain-v2-mirror"),
  ].filter(Boolean);
  const checked: string[] = [];
  for (const candidate of candidates) {
    const dir = path.resolve(candidate.replace(/^~/, process.env.HOME || ""));
    checked.push(dir);
    if (fs.existsSync(path.join(dir, "package.json")) && fs.existsSync(path.join(dir, "server.ts"))) {
      return { dir, checked };
    }
  }
  return { dir: null, checked };
}
