import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { LlamaCppManager, DEFAULT_CONFIG, systemBinaryCandidates } from "../desktop/llamacpp-manager.cjs";

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("LlamaCppManager path and spawn safety", () => {
  it("resolves bundled llama.cpp binary and model from custom LYNN_HOME before default home", () => {
    const homeDir = makeTempDir("lynn-home-default-");
    const lynnHome = makeTempDir("lynn-home-custom-");
    const binName = process.platform === "win32" ? "llama-server.exe" : "llama-server";
    const expectedBinary = path.join(lynnHome, "llamacpp", "bin", binName);
    const expectedModel = path.join(lynnHome, "models", DEFAULT_CONFIG.modelFileName);

    fs.mkdirSync(path.dirname(expectedBinary), { recursive: true });
    fs.mkdirSync(path.dirname(expectedModel), { recursive: true });
    fs.writeFileSync(expectedBinary, "stub");
    fs.writeFileSync(expectedModel, "stub");

    const manager = new LlamaCppManager({
      homeDir,
      lynnHome,
      fsModule: fs,
    });

    expect(manager.resolveBinaryPath()).toBe(expectedBinary);
    expect(manager.resolveModelPath()).toBe(expectedModel);
  });

  it("spawns llama-server with windowsHide to avoid console flashes on Windows", async () => {
    let spawnOptions = null;
    const manager = new LlamaCppManager({
      binaryPath: "/tmp/llama-server",
      modelPath: "/tmp/model.gguf",
      fsModule: { existsSync: () => true },
      spawnFn: (_binary, _args, options) => {
        spawnOptions = options;
        throw new Error("stop before process launch");
      },
    });
    manager.findFreePort = async () => 18099;

    await manager.spawnServer();

    expect(spawnOptions).toMatchObject({ windowsHide: true });
  });

  it("discovers a Windows llama-server installed on PATH with where.exe", () => {
    const expected = "C:\\llama.cpp\\llama-server.exe";
    const spawnCalls = [];
    const spawnSyncFn = (command, args, options) => {
      spawnCalls.push({ command, args, options });
      return { stdout: `${expected}\r\n` };
    };
    const manager = new LlamaCppManager({
      platform: "win32",
      lynnHome: "C:\\Users\\test\\.lynn",
      fsModule: { existsSync: (candidate) => candidate === expected },
      spawnSyncFn,
    });

    expect(manager.resolveBinaryPath()).toBe(expected);
    expect(spawnCalls).toEqual([
      expect.objectContaining({ command: "where.exe", args: ["llama-server"] }),
    ]);
  });

  it("keeps every valid Windows PATH match so an unavailable first result can fall through", () => {
    const candidates = systemBinaryCandidates("win32", () => ({
      stdout: "C:\\old\\llama-server.exe\r\nD:\\tools\\llama-server.exe\r\n",
    }));

    expect(candidates).toEqual([
      "C:\\old\\llama-server.exe",
      "D:\\tools\\llama-server.exe",
    ]);
  });

  it("keeps MTP launch flags for the default 27B profile when the binary supports them", () => {
    const manager = new LlamaCppManager({
      binaryPath: "/tmp/llama-server",
      modelPath: "/tmp/model.gguf",
      fsModule: { existsSync: () => true },
    });
    manager.binaryPath = "/tmp/llama-server";
    manager.binarySupportsFlag = () => true;

    const args = manager.buildServerArgs();

    expect(DEFAULT_CONFIG.modelId).toBe("qwen36-27b-dsv4pro-coding-q4-mtp");
    expect(DEFAULT_CONFIG.modelFileName).toBe("Q4_LynnStyle/Q4-imatrix-MTP-00001-of-00004.gguf");
    expect(args).toEqual(expect.arrayContaining([
      "-a", "qwen36-27b-dsv4pro-coding-q4-mtp",
      "--spec-type", "draft-mtp",
      "--spec-draft-n-max", "3",
    ]));
  });

  it("drops unsupported optional llama.cpp flags before spawning older binaries", () => {
    const logs = [];
    const manager = new LlamaCppManager({
      binaryPath: "/tmp/llama-server",
      modelPath: "/tmp/model.gguf",
      fsModule: { existsSync: () => true },
      onLog: (level, message) => logs.push({ level, message }),
      serverArgs: [
        "--ctx-size", "32768",
        "--jinja",
        "--reasoning", "auto",
        "--reasoning-budget", "-1",
        "--metrics",
        "--spec-type", "draft-mtp",
        "--spec-draft-n-max", "3",
        "--cache-type-k", "q8_0",
        "--cache-type-v", "q8_0",
        "--host", "127.0.0.1",
      ],
    });
    manager.binaryPath = "/tmp/llama-server";
    manager.binarySupportsFlag = (flag) => flag === "--ctx-size" || flag === "--host";

    const args = manager.buildServerArgs();

    expect(args).toEqual([
      "--ctx-size", "32768",
      "--host", "127.0.0.1",
    ]);
    expect(args).not.toContain("auto");
    expect(args).not.toContain("draft-mtp");
    expect(args).not.toContain("q8_0");
    expect(logs.map((entry) => entry.message).join("\n")).toContain("does not support --jinja");
    expect(logs.map((entry) => entry.message).join("\n")).toContain("does not support --cache-type-v");
  });
});
