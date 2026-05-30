import { describe, expect, it } from "vitest";
import { renderStatusBar } from "../src/status-bar.js";

describe("status bar", () => {
  it("renders model, cwd, mode, reasoning, and usage", () => {
    const rendered = renderStatusBar({
      model: "MiMo",
      cwd: process.cwd(),
      mode: "ask / workspace-write",
      reasoning: "auto",
      usage: "12 tokens",
      color: false,
    });

    expect(rendered).toContain("MiMo");
    expect(rendered).toContain("ask / workspace-write");
    expect(rendered).toContain("think auto");
    expect(rendered).toContain("12 tokens");
  });
});
