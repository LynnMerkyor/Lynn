#!/usr/bin/env node

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(root, "cli", "bin", "lynn.mjs");
const turns = Number.parseInt(process.env.LYNN_CLI_TERMINAL_IME_TURNS || "6", 10);
const requireImeSmoke = process.argv.includes("--require") || process.env.LYNN_CLI_TERMINAL_IME_REQUIRE === "1";

if (process.platform !== "darwin") {
  skip("Terminal.app IME smoke is macOS-only");
}
if (!Number.isFinite(turns) || turns < 1) {
  throw new Error("LYNN_CLI_TERMINAL_IME_TURNS must be a positive number");
}
await fs.access(cliEntry);

const selectedInputSource = await readSelectedInputSource();
if (!selectedInputSource.includes("com.apple.inputmethod.SCIM")) {
  skip("selected input source is not Apple SCIM/Pinyin");
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-terminal-ime-smoke-"));
const statusPath = path.join(tmp, "status.txt");
const transcriptPath = path.join(tmp, "transcript.txt");
const appleScriptPath = path.join(tmp, "run.applescript");
const pinyinInputs = [
  "nihaolynn",
  "xianzaibanbenhao",
  "qingjieshaoyixiapmoshi",
  "yolomoshiweixianma",
  "changrenwuxupao ceshi",
  "rust typescript he cli fleet",
  "qingyongyijuhuahuida",
  "zhongwenshurubunengshantui",
];
const imeInputs = Array.from({ length: turns }, (_, index) => pinyinInputs[index % pinyinInputs.length]);

const appleScript = `
on run argv
  set repoDir to item 1 of argv
  set statusPath to item 2 of argv
  set transcriptPath to item 3 of argv
  set runCommand to "cd " & quoted form of repoDir & " && printf 'terminal-ime-smoke-start\\\\n' > " & quoted form of transcriptPath & " && LYNN_CLI_UPDATE_CHECK=0 LYNN_LANG=zh node cli/bin/lynn.mjs --mock-brain; echo $? > " & quoted form of statusPath
  tell application "Terminal"
    activate
    set smokeTab to do script runCommand
    set smokeWindow to front window
    set selected of smokeTab to true
    set index of smokeWindow to 1
  end tell
  delay 3
  tell application "System Events"
    tell process "Terminal" to set frontmost to true
${imeInputs.map((value, index) => `    tell application "Terminal"
      activate
      set selected of smokeTab to true
      set index of smokeWindow to 1
    end tell
    keystroke ${quoteApple(value)}
    delay 0.25
    key code 49
    delay 0.25
    key code 36
    delay ${index < imeInputs.length - 1 ? "0.6" : "0.8"}`).join("\n")}
  end tell
  tell application "Terminal"
    set selected of smokeTab to true
    set index of smokeWindow to 1
    do script "/version" in smokeTab
    delay 0.5
    do script "/yolo" in smokeTab
    delay 0.5
    do script "/exit" in smokeTab
    delay 1.5
    close smokeWindow saving no
  end tell
end run
`;

await fs.writeFile(appleScriptPath, appleScript, "utf8");
const appleScriptTimeoutMs = Math.max(45_000, turns * 2_000 + 20_000);
try {
  await execFileAsync("osascript", [appleScriptPath, root, statusPath, transcriptPath], { timeout: appleScriptTimeoutMs });
} catch (error) {
  if (String(error?.message || error).includes("not allowed assistive access")) {
    skip("osascript/System Events needs Accessibility permission");
  }
  throw error;
}

const deadline = Date.now() + Math.max(45_000, turns * 4_000 + 20_000);
while (Date.now() < deadline) {
  if (await exists(statusPath)) break;
  await sleep(500);
}
if (!(await exists(statusPath))) {
  throw new Error(`[cli-terminal-ime-smoke] timed out waiting for Terminal.app status; temp=${tmp}`);
}

const status = (await fs.readFile(statusPath, "utf8")).trim();
if (status !== "0") {
  throw new Error(`[cli-terminal-ime-smoke] Lynn exited ${status}; temp=${tmp}`);
}

console.log(`[cli-terminal-ime-smoke] passed Terminal.app IME smoke (${imeInputs.length} varied pinyin turns); temp=${tmp}`);

async function readSelectedInputSource() {
  try {
    const result = await execFileAsync("defaults", ["read", "com.apple.HIToolbox", "AppleSelectedInputSources"], { timeout: 5_000 });
    return result.stdout;
  } catch {
    return "";
  }
}

function execFileAsync(command, args, options) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.message += `\nstdout:\n${stdout}\nstderr:\n${stderr}`;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function skip(reason) {
  const message = `[cli-terminal-ime-smoke] ⚠ IME path not verified: ${reason}`;
  if (requireImeSmoke) {
    console.error(`${message}; --require is set`);
    process.exit(1);
  }
  console.error(message);
  process.exit(0);
}
