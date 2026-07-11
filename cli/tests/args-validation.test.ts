import { describe, expect, it } from "vitest";
import { findUnknownLongFlags, suggestLongFlag } from "../src/args.js";
import { commandUsage } from "../src/help.js";

describe("CLI argument validation", () => {
  it("rejects unknown long flags and suggests close matches", () => {
    expect(findUnknownLongFlags(["chat", "--brain-urll", "--reasoning=high"]))
      .toEqual(["brain-urll"]);
    expect(suggestLongFlag("brain-urll")).toBe("brain-url");
  });

  it("stops flag validation after the positional separator", () => {
    expect(findUnknownLongFlags(["code", "--", "--not-a-lynn-flag"])).toEqual([]);
  });

  it("renders focused command help", () => {
    expect(commandUsage("doctor")).toContain("Lynn doctor");
    expect(commandUsage("doctor")).toContain("Lynn help");
  });
});
