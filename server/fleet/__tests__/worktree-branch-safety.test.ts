import { describe, expect, it } from "vitest";
import { isSafeBranchName } from "../worktree-manager.js";

describe("isSafeBranchName (fleet worktree git-argv safety)", () => {
  it("accepts normal worker branches", () => {
    expect(isSafeBranchName("fleet/worker-12")).toBe(true);
    expect(isSafeBranchName("codex/cli-step-budget-0807")).toBe(true);
    expect(isSafeBranchName("v0.83-rc.1")).toBe(true);
  });

  it("rejects traversal, ref tricks and lock suffixes", () => {
    expect(isSafeBranchName("../../evil")).toBe(false);
    expect(isSafeBranchName("a..b")).toBe(false);
    expect(isSafeBranchName("/abs")).toBe(false);
    expect(isSafeBranchName("trail/")).toBe(false);
    expect(isSafeBranchName("a@{1}")).toBe(false);
    expect(isSafeBranchName("x.lock")).toBe(false);
  });

  it("rejects git-flag lookalikes and oversized names (argv injection guard)", () => {
    expect(isSafeBranchName("-d")).toBe(false);
    expect(isSafeBranchName("--force")).toBe(false);
    expect(isSafeBranchName("-b")).toBe(false);
    expect(isSafeBranchName("a".repeat(257))).toBe(false);
    expect(isSafeBranchName("a".repeat(256))).toBe(true);
  });

  it("rejects shell metacharacters via the charset allowlist", () => {
    expect(isSafeBranchName("a;rm -rf")).toBe(false);
    expect(isSafeBranchName("a b")).toBe(false);
    expect(isSafeBranchName("a$(x)")).toBe(false);
  });
});
