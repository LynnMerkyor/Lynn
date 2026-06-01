import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  patchTargetFiles,
  checkToolPostcondition,
  describeToolFailureContext,
  augmentToolResultSection,
} from "../src/code-tool-verify.js";
import type { CodeToolRequest } from "../src/code-tool-protocol.js";
import type { ClientToolResult } from "../src/tools/types.js";

let cwd: string;
beforeEach(() => { cwd = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-verify-")); });
afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

function req(tool: CodeToolRequest["tool"], args: CodeToolRequest["args"]): CodeToolRequest {
  return { tool, args };
}

describe("patchTargetFiles", () => {
  it("parses git unified diff +++ headers (and skips /dev/null)", () => {
    const patch = "--- a/src/x.ts\n+++ b/src/x.ts\n@@\n-old\n+new\n";
    expect(patchTargetFiles(patch)).toEqual(["src/x.ts"]);
    expect(patchTargetFiles("--- a/gone.ts\n+++ /dev/null\n")).toEqual([]);
  });
  it("parses codex *** File headers + Move to", () => {
    expect(patchTargetFiles("*** Begin Patch\n*** Add File: a/new.ts\n+x\n*** End Patch")).toEqual(["a/new.ts"]);
    expect(patchTargetFiles("*** Update File: m.ts\n*** Move to: n.ts\n")).toEqual(["m.ts", "n.ts"]);
  });
});

describe("#2 checkToolPostcondition", () => {
  it("passes write_file when the file is on disk and matches", () => {
    fs.writeFileSync(path.join(cwd, "a.ts"), "hello\n");
    const result: ClientToolResult = { ok: true, tool: "write_file", output: { path: "a.ts" } };
    expect(checkToolPostcondition(req("write_file", { path: "a.ts", text: "hello\n" }), result, cwd).severity).toBe("ok");
  });

  it("FAILS write_file when the tool reported success but nothing is on disk", () => {
    const result: ClientToolResult = { ok: true, tool: "write_file", output: { path: "ghost.ts" } };
    const post = checkToolPostcondition(req("write_file", { path: "ghost.ts", text: "x" }), result, cwd);
    expect(post.severity).toBe("fail");
    expect(post.note).toContain("POSTCONDITION FAILED");
  });

  it("warns write_file when disk content does not byte-match what was sent", () => {
    fs.writeFileSync(path.join(cwd, "a.ts"), "DIFFERENT");
    const result: ClientToolResult = { ok: true, tool: "write_file", output: { path: "a.ts" } };
    expect(checkToolPostcondition(req("write_file", { path: "a.ts", text: "expected" }), result, cwd).severity).toBe("warn");
  });

  it("FAILS apply_patch when a reported target file is missing", () => {
    const result: ClientToolResult = { ok: true, tool: "apply_patch", output: { format: "codex-patch", files: ["nope.ts"] } };
    const post = checkToolPostcondition(req("apply_patch", { text: "*** Update File: nope.ts\n@@\n-a\n+b\n" }), result, cwd);
    expect(post.severity).toBe("fail");
  });

  it("passes apply_patch when target exists, and ignores deletes", () => {
    fs.writeFileSync(path.join(cwd, "kept.ts"), "x");
    const ok: ClientToolResult = { ok: true, tool: "apply_patch", output: { files: ["kept.ts"] } };
    expect(checkToolPostcondition(req("apply_patch", { text: "*** Update File: kept.ts\n" }), ok, cwd).severity).toBe("ok");
    const del: ClientToolResult = { ok: true, tool: "apply_patch", output: {} };
    expect(checkToolPostcondition(req("apply_patch", { text: "*** Delete File: removed.ts\n" }), del, cwd).severity).toBe("ok");
  });

  it("warns on empty grep / glob results", () => {
    const grep: ClientToolResult = { ok: true, tool: "grep", output: { matches: [] } };
    expect(checkToolPostcondition(req("grep", { query: "zzz" }), grep, cwd).severity).toBe("warn");
    const glob: ClientToolResult = { ok: true, tool: "glob", output: { files: [] } };
    expect(checkToolPostcondition(req("glob", { pattern: "*.none" }), glob, cwd).severity).toBe("warn");
    const hit: ClientToolResult = { ok: true, tool: "grep", output: { matches: [{ path: "a", line: 1, text: "x" }] } };
    expect(checkToolPostcondition(req("grep", { query: "x" }), hit, cwd).severity).toBe("ok");
  });
});

describe("#7 describeToolFailureContext", () => {
  it("returns the current file content so the model can re-aim a failed patch", () => {
    fs.writeFileSync(path.join(cwd, "real.ts"), "line A\nline B\nline C\n");
    const result: ClientToolResult = { ok: false, tool: "apply_patch", error: "codex patch context not found in real.ts" };
    const ctx = describeToolFailureContext(req("apply_patch", { text: "*** Update File: real.ts\n@@\n-wrong\n+x\n" }), result, cwd);
    expect(ctx).toContain("Current content of real.ts");
    expect(ctx).toContain("line A");
    expect(ctx).toContain("Rebuild the patch against THIS exact text");
  });

  it("lists sibling files when a path is not found", () => {
    fs.writeFileSync(path.join(cwd, "sibling.ts"), "x");
    const result: ClientToolResult = { ok: false, tool: "read_file", error: "ENOENT: no such file or directory" };
    const ctx = describeToolFailureContext(req("read_file", { path: "missing.ts" }), result, cwd);
    expect(ctx).toContain("not found");
    expect(ctx).toContain("sibling.ts");
  });

  it("returns null for an ok result", () => {
    expect(describeToolFailureContext(req("read_file", { path: "x" }), { ok: true, tool: "read_file" }, cwd)).toBeNull();
  });
});

describe("augmentToolResultSection", () => {
  it("appends failure context for failed tools and postcondition notes for risky successes", () => {
    fs.writeFileSync(path.join(cwd, "f.ts"), "current\n");
    const fail = augmentToolResultSection(
      req("apply_patch", { text: "*** Update File: f.ts\n@@\n-no\n+y\n" }),
      { ok: false, tool: "apply_patch", error: "context not found" },
      cwd,
      "Tool result for apply_patch:\nfailed",
    );
    expect(fail).toContain("Current content of f.ts");

    const ghost = augmentToolResultSection(
      req("write_file", { path: "ghost.ts", text: "x" }),
      { ok: true, tool: "write_file", output: { path: "ghost.ts" } },
      cwd,
      "Tool result for write_file:\nok",
    );
    expect(ghost).toContain("POSTCONDITION FAILED");

    const clean = augmentToolResultSection(
      req("read_file", { path: "f.ts" }),
      { ok: true, tool: "read_file", output: { content: "current" } },
      cwd,
      "Tool result for read_file:\ncurrent",
    );
    expect(clean).toBe("Tool result for read_file:\ncurrent"); // 干净路径不加噪音
  });
});
