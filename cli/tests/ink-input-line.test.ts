import { describe, expect, it } from "vitest";
import { normalizeSlashInput } from "../src/completion.js";
import { inputDisplayRows, slashHint, slashPalette } from "../src/ink-input-line.js";

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

  it("renders a command palette next to slash input", () => {
    const palette = slashPalette("/", ["/help", "/model", "/providers"]);
    expect(palette).toContain("/model");
    expect(palette).toContain("路由");
  });

  it("shows an unknown-command guard for unmatched slash input", () => {
    expect(slashPalette("/bad", ["/help", "/model"])).toContain("未知命令");
  });

  it("normalizes full-width slash from Chinese IMEs", () => {
    expect(normalizeSlashInput("／model")).toBe("/model");
  });

  it("keeps typed multi-line input inside one input frame", () => {
    const rows = inputDisplayRows("第一行\n第二行", "", 20);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ prompt: "› ", text: "第一行" });
    expect(rows[1]).toMatchObject({ prompt: "  ", text: "第二行" });
  });

  it("places slash hint on the last display row only", () => {
    const rows = inputDisplayRows("/mod\nextra", "el", 20);

    expect(rows[0].hint).toBe("");
    expect(rows[1].hint).toBe("el");
  });
});
