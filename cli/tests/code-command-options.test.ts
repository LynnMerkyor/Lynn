import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";
import { codeHarness, maxSteps } from "../src/code-command-options.js";

describe("code command options", () => {
  it("uses the auto harness by default and validates explicit selection", () => {
    expect(codeHarness(parseArgs(["code", "task"]))).toBe("auto");
    expect(codeHarness(parseArgs(["code", "task", "--harness", "legacy"]))).toBe("legacy");
    expect(codeHarness(parseArgs(["code", "task", "--harness", "codex"]))).toBe("codex");
    expect(() => codeHarness(parseArgs(["code", "task", "--harness", "unknown"]))).toThrow(/auto, legacy, or codex/);
  });

  it("uses a 100 step default and allows explicit budgets up to 300", () => {
    expect(maxSteps(parseArgs(["code", "task"]))).toBe(100);
    expect(maxSteps(parseArgs(["code", "task", "--max-steps", "20"]))).toBe(20);
    expect(maxSteps(parseArgs(["code", "task", "--max-steps", "300"]))).toBe(300);
    expect(maxSteps(parseArgs(["code", "task", "--long", "--max-steps", "300"]))).toBe(300);
    expect(maxSteps(parseArgs(["code", "task", "--endurance", "--steps", "250"]))).toBe(250);
    expect(() => maxSteps(parseArgs(["code", "task", "--max-steps", "301"]))).toThrow(/1 to 300/);
  });
});
