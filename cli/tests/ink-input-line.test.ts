import { describe, expect, it } from "vitest";
import { slashHint } from "../src/ink-input-line.js";

describe("Ink input slash hints", () => {
  it("shows command candidates when the user starts slash input", () => {
    expect(slashHint("/", ["/help", "/model", "/providers"], 80)).toContain("/model");
  });

  it("shows the remaining suffix for a unique command prefix", () => {
    expect(slashHint("/mod", ["/help", "/model", "/providers"], 80)).toContain("el");
  });

  it("truncates long candidate lists to fit the input line", () => {
    const hint = slashHint("/", ["/help", "/model", "/providers", "/providers set", "/providers unset"], 18);
    expect(hint.length).toBeLessThanOrEqual(18);
    expect(hint).toContain("...");
  });

  it("does nothing for normal user text", () => {
    expect(slashHint("hello", ["/help"], 80)).toBe("");
  });
});
