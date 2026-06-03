import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  isPidAlive,
  pollServerInfo,
  isReusableServerHealth,
  resolveAecNativeDir,
  injectWindowsGitPath,
  resolveBundledServerLaunch,
} = require("../server-process.cjs");

function tmpFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-sp-"));
  return path.join(dir, name);
}

describe("isPidAlive", () => {
  it("reports the current process alive and a dead pid not alive", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    // injected fake proc whose kill throws (ESRCH) → not alive
    const fakeProc = { kill: () => { throw new Error("ESRCH"); } };
    expect(isPidAlive(999999, fakeProc as unknown as NodeJS.Process)).toBe(false);
  });
});

describe("pollServerInfo", () => {
  it("resolves with the parsed info once the file exists and the PID is alive", async () => {
    const p = tmpFile("server-info.json");
    fs.writeFileSync(p, JSON.stringify({ pid: process.pid, port: 4321, token: "tok" }));
    const info = await pollServerInfo(p, { interval: 5 });
    expect(info).toEqual({ pid: process.pid, port: 4321, token: "tok" });
  });

  it("rejects with the localized timeout message when the file never appears", async () => {
    const p = tmpFile("never.json");
    const mt = (key: string, _vars: unknown, fallback: string) => `MT:${key}:${fallback ?? ""}`;
    await expect(pollServerInfo(p, { timeout: 40, interval: 5, mt })).rejects.toThrow(
      "MT:dialog.serverStartTimeout",
    );
  });

  it("rejects fast (via injected mt) when the child process exits", async () => {
    const p = tmpFile("exit.json");
    const proc = new EventEmitter();
    const mt = (key: string) => `MT:${key}`;
    const pending = pollServerInfo(p, { timeout: 5000, interval: 5, process: proc, mt });
    proc.emit("exit", 1, null);
    await expect(pending).rejects.toThrow("MT:dialog.serverExitedWithCode");
  });
});

describe("isReusableServerHealth", () => {
  const okFeatures = { translateRoute: true, toolsRoute: true };

  it("accepts a healthy server with the required feature routes", () => {
    expect(isReusableServerHealth({ status: "ok", features: okFeatures })).toBe(true);
  });

  it("rejects non-ok / missing health", () => {
    expect(isReusableServerHealth(null)).toBe(false);
    expect(isReusableServerHealth({ status: "degraded", features: okFeatures })).toBe(false);
  });

  it("rejects when a required feature route is missing (stale server)", () => {
    expect(isReusableServerHealth({ status: "ok", features: { translateRoute: true } })).toBe(false);
    expect(isReusableServerHealth({ status: "ok", features: {} })).toBe(false);
  });

  it("rejects on version mismatch when expectedVersion is provided", () => {
    const health = { status: "ok", version: "0.80.5", features: okFeatures };
    expect(isReusableServerHealth(health, "0.80.6")).toBe(false);
    expect(isReusableServerHealth(health, "0.80.5")).toBe(true);
    expect(isReusableServerHealth(health)).toBe(true); // version not enforced without expectedVersion
  });
});

describe("resolveAecNativeDir", () => {
  it("returns the dev dir when it exists (non-asar)", () => {
    const dirname = path.join(path.sep, "app");
    const dev = path.join(dirname, "native-modules", "aec");
    const existsSync = (p: string) => p === dev;
    expect(resolveAecNativeDir({ dirname, existsSync })).toBe(dev);
  });

  it("returns null when no aec dir exists", () => {
    const dirname = path.join(path.sep, "app");
    expect(resolveAecNativeDir({ dirname, existsSync: () => false })).toBeNull();
  });

  it("prefers the app.asar.unpacked dir in a packaged build", () => {
    const dirname = path.join(path.sep, "x", "app.asar", "desktop");
    const unpacked = path.join(
      dirname.replace("app.asar", "app.asar.unpacked"),
      "native-modules",
      "aec",
    );
    const existsSync = (p: string) => p === unpacked;
    expect(resolveAecNativeDir({ dirname, existsSync })).toBe(unpacked);
  });
});

describe("injectWindowsGitPath", () => {
  it("is a no-op on non-win32", () => {
    const env: Record<string, string> = { PATH: "/usr/bin" };
    const out = injectWindowsGitPath(env, { platform: "darwin", resourcesPath: "/r", existsSync: () => true });
    expect(out.PATH).toBe("/usr/bin");
  });

  it("prepends MinGit paths and collapses a 'Path' casing duplicate on win32", () => {
    const gitRoot = path.join("C:\\res", "git");
    const mingw = path.join(gitRoot, "mingw64", "bin");
    const cmd = path.join(gitRoot, "cmd");
    const env: Record<string, string> = { Path: "C:\\system32" }; // title-case key
    const out = injectWindowsGitPath(env, {
      platform: "win32",
      resourcesPath: "C:\\res",
      existsSync: (p: string) => p === mingw || p === cmd,
    });
    expect(out.Path).toBeUndefined(); // duplicate casing key removed
    expect(out.PATH).toBe(`${mingw};${cmd};C:\\system32`);
  });

  it("leaves env unchanged on win32 when no git paths exist", () => {
    const env: Record<string, string> = { PATH: "C:\\system32" };
    const out = injectWindowsGitPath(env, { platform: "win32", resourcesPath: "C:\\res", existsSync: () => false });
    expect(out.PATH).toBe("C:\\system32");
  });
});

describe("resolveBundledServerLaunch", () => {
  const base = { resourcesPath: path.join(path.sep, "res"), dirname: path.join(path.sep, "app", "desktop"), execPath: "/usr/bin/electron" };
  const serverDir = path.join(base.resourcesPath, "server");

  it("uses the dev source entry + ELECTRON_RUN_AS_NODE when nothing is bundled", () => {
    const out = resolveBundledServerLaunch({ ...base, platform: "darwin", existsSync: () => false });
    expect(out.mode).toBe("dev");
    expect(out.serverBin).toBe(base.execPath);
    expect(out.serverArgs).toEqual([path.join(base.dirname, "..", "server", "index.js")]);
    expect(out.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
  });

  it("uses the node runtime + bundle entry when the bundled node runtime is present", () => {
    const node = path.join(serverDir, "node");
    const entry = path.join(serverDir, "bundle", "index.js");
    const out = resolveBundledServerLaunch({
      ...base,
      platform: "linux",
      existsSync: (p: string) => p === node || p === entry,
    });
    expect(out.mode).toBe("bundled");
    expect(out.serverBin).toBe(node);
    expect(out.serverArgs).toEqual([entry]);
    expect(out.env).toEqual({ HANA_ROOT: serverDir });
  });

  it("uses lynn-server.exe + bundle entry on win32", () => {
    const exe = path.join(serverDir, "lynn-server.exe");
    const entry = path.join(serverDir, "bundle", "index.js");
    const out = resolveBundledServerLaunch({
      ...base,
      platform: "win32",
      existsSync: (p: string) => p === exe || p === entry,
    });
    expect(out.mode).toBe("bundled");
    expect(out.serverBin).toBe(exe);
    expect(out.serverArgs).toEqual([entry]);
  });

  it("falls back to the shell wrapper (no args) when only the wrapper exists", () => {
    const wrapper = path.join(serverDir, "lynn-server");
    const out = resolveBundledServerLaunch({
      ...base,
      platform: "darwin",
      existsSync: (p: string) => p === wrapper,
    });
    expect(out.mode).toBe("bundled");
    expect(out.serverBin).toBe(wrapper);
    expect(out.serverArgs).toEqual([]);
  });
});
