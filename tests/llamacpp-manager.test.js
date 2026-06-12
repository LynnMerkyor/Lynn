import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { LlamaCppManager, DEFAULT_CONFIG } from "../desktop/llamacpp-manager.cjs";

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
});
