import { describe, expect, it } from "vitest";
import { renderInputBand } from "../src/tui-input.js";
import { visibleLength } from "../src/startup.js";

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("renderInputBand", () => {
  it("pads to a stable width for a fixed input row", () => {
    const line = stripAnsi(renderInputBand({ prompt: "› ", value: "hi", width: 20, color: false }));
    expect(line).toHaveLength(20);
    expect(line.startsWith("› hi")).toBe(true);
  });

  it("renders a colored band for TTY output", () => {
    const line = renderInputBand({ prompt: "› ", value: "", placeholder: "描述任务", width: 20, color: true });
    expect(line).toContain("\x1b[48;5;236m");
    expect(visibleLength(stripAnsi(line))).toBe(20);
  });
});
