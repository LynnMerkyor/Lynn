import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyToolResultBudget } from "../src/tool-result-budget.js";
import type { ClientToolResult } from "../src/tools/types.js";

let tmp = "";

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-spill-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("tool result budget", () => {
  it("passes small results through untouched", async () => {
    const result: ClientToolResult = { ok: true, tool: "read_file", output: { text: "hi" } };
    const outcome = await applyToolResultBudget(result, { runId: "r1", spillRoot: tmp, maxInlineChars: 1_000 });
    expect(outcome.spilledPath).toBeUndefined();
    expect(outcome.result).toBe(result);
  });

  it("spills a large result and keeps a preview plus the path", async () => {
    const big = "x".repeat(50_000);
    const result: ClientToolResult = { ok: true, tool: "bash", output: { stdout: big } };
    const outcome = await applyToolResultBudget(result, { runId: "run/42", spillRoot: tmp, maxInlineChars: 1_000, maxPreviewChars: 200 });
    expect(outcome.originalChars).toBeGreaterThan(50_000);
    expect(outcome.spilledPath).toBeTruthy();
    const text = await fs.readFile(outcome.spilledPath!, "utf8");
    expect(text).toContain(big.slice(0, 100));
    const output = outcome.result.output as { truncated: boolean; preview: string; spilledPath: string; note: string };
    expect(output.truncated).toBe(true);
    expect(output.spilledPath).toBe(outcome.spilledPath);
    expect(output.preview.length).toBe(200);
    expect(output.note).toContain("read_file");
    expect(outcome.spilledPath!.startsWith(tmp)).toBe(true);
  });

  it("still truncates when spilling fails", async () => {
    const result: ClientToolResult = { ok: true, tool: "bash", output: { stdout: "y".repeat(5_000) } };
    const outcome = await applyToolResultBudget(result, {
      runId: "r2",
      spillRoot: path.join(tmp, "missing", "\0bad"),
      maxInlineChars: 100,
    });
    expect(outcome.spilledPath).toBeUndefined();
    expect((outcome.result.output as { truncated: boolean }).truncated).toBe(true);
    expect((outcome.result.output as { note: string }).note).toContain("truncated");
  });
});
