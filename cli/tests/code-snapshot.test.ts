import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceSnapshot, restoreWorkspaceSnapshot, autoRollbackEnabled } from "../src/code-snapshot.js";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-snap-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@t.t"]);
  git(dir, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(dir, "a.ts"), "original\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe("createWorkspaceSnapshot", () => {
  it("returns unavailable outside a git repo", () => {
    const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-nogit-"));
    try { expect(createWorkspaceSnapshot(nonGit).available).toBe(false); }
    finally { fs.rmSync(nonGit, { recursive: true, force: true }); }
  });

  it("captures a snapshot ref + restore command in a git repo", () => {
    const snap = createWorkspaceSnapshot(dir);
    expect(snap.available).toBe(true);
    expect(snap.ref).toBeTruthy();
    expect(snap.restoreCommand).toContain("git checkout");
  });
});

describe("restoreWorkspaceSnapshot", () => {
  it("reverts a tracked file the model broke, WITHOUT deleting untracked files", () => {
    const snap = createWorkspaceSnapshot(dir);
    fs.writeFileSync(path.join(dir, "a.ts"), "BROKEN\n");
    fs.writeFileSync(path.join(dir, "new.ts"), "keep me\n"); // model-created, untracked
    const result = restoreWorkspaceSnapshot(dir, snap);
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(path.join(dir, "a.ts"), "utf8")).toBe("original\n"); // tracked file reverted
    expect(fs.existsSync(path.join(dir, "new.ts"))).toBe(true); // untracked NOT nuked
  });

  it("captures dirty pre-task state and restores to it (not HEAD)", () => {
    fs.writeFileSync(path.join(dir, "a.ts"), "dirty before task\n"); // uncommitted at snapshot time
    const snap = createWorkspaceSnapshot(dir);
    fs.writeFileSync(path.join(dir, "a.ts"), "model broke it\n");
    restoreWorkspaceSnapshot(dir, snap);
    expect(fs.readFileSync(path.join(dir, "a.ts"), "utf8")).toBe("dirty before task\n");
  });

  it("no-ops on an unavailable snapshot", () => {
    expect(restoreWorkspaceSnapshot(dir, { available: false, ref: null, restoreCommand: null }).ok).toBe(false);
  });
});

describe("autoRollbackEnabled", () => {
  it("is opt-in via LYNN_CLI_AUTO_ROLLBACK=1", () => {
    expect(autoRollbackEnabled({})).toBe(false);
    expect(autoRollbackEnabled({ LYNN_CLI_AUTO_ROLLBACK: "1" })).toBe(true);
  });
});
