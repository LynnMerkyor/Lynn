import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  prepareDryRunWorkspace,
  runDryRunValidation,
} from "../core/session-dry-run.js";

describe("session dry-run helpers", () => {
  const dirs = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-session-dry-run-"));
    dirs.push(dir);
    return dir;
  }

  it("copies a shadow workspace while skipping heavy generated directories", async () => {
    const source = tempDir();
    fs.writeFileSync(path.join(source, "keep.txt"), "ok");
    fs.mkdirSync(path.join(source, "node_modules"));
    fs.writeFileSync(path.join(source, "node_modules", "skip.txt"), "nope");
    fs.mkdirSync(path.join(source, ".git"));
    fs.writeFileSync(path.join(source, ".git", "config"), "nope");

    const shadow = await prepareDryRunWorkspace(source);
    dirs.push(shadow);

    expect(shadow).not.toBe(source);
    expect(fs.readFileSync(path.join(shadow, "keep.txt"), "utf-8")).toBe("ok");
    expect(fs.existsSync(path.join(shadow, "node_modules"))).toBe(false);
    expect(fs.existsSync(path.join(shadow, ".git"))).toBe(false);
  });

  it("runs validation commands and trims captured output", () => {
    const cwd = tempDir();
    const result = runDryRunValidation(cwd, [
      process.execPath,
      "-e",
      "console.log('valid'); console.error('warn')",
    ]);

    expect(result).toMatchObject({
      command: process.execPath,
      args: ["-e", "console.log('valid'); console.error('warn')"],
      exitCode: 0,
      signal: null,
      stdout: "valid",
      stderr: "warn",
    });
  });

  it("ignores missing validation commands", () => {
    expect(runDryRunValidation(tempDir(), undefined)).toBe(null);
    expect(runDryRunValidation(tempDir(), [])).toBe(null);
  });
});
