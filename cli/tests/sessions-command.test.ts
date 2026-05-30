import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";
import { runSessions } from "../src/commands/sessions.js";
import { appendSessionTurn } from "../src/session/store.js";

let tmp = "";
const originalDataDir = process.env.LYNN_DATA_DIR;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-cli-sessions-command-"));
  process.env.LYNN_DATA_DIR = tmp;
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.LYNN_DATA_DIR;
  else process.env.LYNN_DATA_DIR = originalDataDir;
});

async function captureStdout(run: () => Promise<number>): Promise<string> {
  const original = process.stdout.write;
  let output = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    await run();
  } finally {
    process.stdout.write = original;
  }
  return output;
}

describe("sessions command", () => {
  it("prints a real code resume command instead of replaying the transcript", async () => {
    const sessionPath = await appendSessionTurn({
      dataDir: tmp,
      cwd: "/repo",
      title: "continue me",
      prompt: "start",
      assistant: "done",
    });

    const output = await captureStdout(() => runSessions(parseArgs(["sessions", "resume", sessionPath]), false));

    expect(output).toContain("Lynn code --resume");
    expect(output).toContain(sessionPath);
    expect(output).not.toContain("[user] start");
  });
});
