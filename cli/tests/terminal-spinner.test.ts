import { describe, expect, it } from "vitest";
import { renderSweepFrame } from "../src/terminal-spinner.js";

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("terminal spinner sweep", () => {
  it("renders a fixed-width left-to-right sweep frame", () => {
    const first = stripAnsi(renderSweepFrame(12, 0, false));
    const later = stripAnsi(renderSweepFrame(12, 6, false));
    expect(first).toHaveLength(12);
    expect(later).toHaveLength(12);
    expect(first).not.toBe(later);
    expect(later).toContain("━");
  });

  it("can render colored bright head/trail for TTY output", () => {
    const frame = renderSweepFrame(12, 6, true);
    expect(frame).toContain("\x1b[1;36m━\x1b[0m");
    expect(frame).toContain("\x1b[36m━\x1b[0m");
    expect(frame).toContain("\x1b[2m─\x1b[0m");
  });
});
