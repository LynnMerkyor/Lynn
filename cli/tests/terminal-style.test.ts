import { describe, expect, it } from "vitest";
import { supportsColor } from "../src/terminal-style.js";

const tty = { isTTY: true };

describe("terminal color detection", () => {
  it("uses color on normal TTY terminals", () => {
    expect(supportsColor(tty, { TERM: "xterm-256color" } as NodeJS.ProcessEnv)).toBe(true);
  });

  it("honors NO_COLOR unless Lynn is explicitly forced", () => {
    expect(supportsColor(tty, { TERM: "xterm-256color", NO_COLOR: "1" } as NodeJS.ProcessEnv)).toBe(false);
    expect(supportsColor(tty, { TERM: "xterm-256color", NO_COLOR: "1", LYNN_FORCE_COLOR: "1" } as NodeJS.ProcessEnv)).toBe(true);
    expect(supportsColor(tty, { TERM: "xterm-256color", NO_COLOR: "1", FORCE_COLOR: "1" } as NodeJS.ProcessEnv)).toBe(true);
  });

  it("lets Lynn-specific no-color disable output", () => {
    expect(supportsColor(tty, { TERM: "xterm-256color", LYNN_NO_COLOR: "1" } as NodeJS.ProcessEnv)).toBe(false);
  });

  it("disables color for dumb or non-TTY streams unless forced", () => {
    expect(supportsColor(tty, { TERM: "dumb" } as NodeJS.ProcessEnv)).toBe(false);
    expect(supportsColor({ isTTY: false }, { TERM: "xterm-256color" } as NodeJS.ProcessEnv)).toBe(false);
    expect(supportsColor({ isTTY: false }, { TERM: "dumb", FORCE_COLOR: "1" } as NodeJS.ProcessEnv)).toBe(true);
  });
});
