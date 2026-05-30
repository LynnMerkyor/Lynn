import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { completeMentionInput, listMentionCandidates } from "../src/mentions.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-mentions-"));
fs.mkdirSync(path.join(root, "src"));
fs.mkdirSync(path.join(root, "node_modules"));
fs.writeFileSync(path.join(root, "src", "code.ts"), "");
fs.writeFileSync(path.join(root, "src", "completion.ts"), "");
fs.writeFileSync(path.join(root, "README.md"), "");
fs.writeFileSync(path.join(root, ".env"), "");

describe("listMentionCandidates", () => {
  it("lists top-level entries, directories first, skipping ignored + hidden", () => {
    const out = listMentionCandidates(root, "");
    expect(out).toContain("src/");
    expect(out).toContain("README.md");
    expect(out).not.toContain("node_modules/"); // ignored
    expect(out).not.toContain(".env"); // hidden, token doesn't start with '.'
    expect(out.indexOf("src/")).toBeLessThan(out.indexOf("README.md")); // dirs first
  });

  it("descends into a directory token and filters by name part", () => {
    const out = listMentionCandidates(root, "src/co");
    expect(out).toEqual(["src/code.ts", "src/completion.ts"]);
  });

  it("shows hidden files only when the token starts with a dot", () => {
    expect(listMentionCandidates(root, ".")).toContain(".env");
  });

  it("never escapes the workspace root", () => {
    expect(listMentionCandidates(root, "../")).toEqual([]);
    expect(listMentionCandidates(root, "../../etc/pas")).toEqual([]);
  });

  it("completes @-mentions from the supplied cwd instead of the shell cwd", () => {
    const shellCwd = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-mention-shell-"));
    const targetCwd = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-mention-target-"));
    try {
      fs.writeFileSync(path.join(shellCwd, "wrong.ts"), "");
      fs.writeFileSync(path.join(targetCwd, "right.ts"), "");

      expect(completeMentionInput("read @r", targetCwd)).toEqual({
        completed: "read @right.ts ",
        matches: ["right.ts"],
      });
      expect(listMentionCandidates(shellCwd, "r")).toEqual([]);
    } finally {
      fs.rmSync(shellCwd, { recursive: true, force: true });
      fs.rmSync(targetCwd, { recursive: true, force: true });
    }
  });
});
