import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { pollServerInfo, isReusableServerHealth } = require("../server-process.cjs");

function tmpFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-sp-"));
  return path.join(dir, name);
}

describe("pollServerInfo", () => {
  it("resolves with the parsed info once the file exists and the PID is alive", async () => {
    const p = tmpFile("server-info.json");
    // process.pid is guaranteed alive (it's us) so the kill(pid,0) liveness check passes
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
    proc.emit("exit", 1, null); // exit with code 1, no signal
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
    // no expectedVersion → version is not enforced
    expect(isReusableServerHealth(health)).toBe(true);
  });
});
