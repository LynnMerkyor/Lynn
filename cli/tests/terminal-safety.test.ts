import { describe, expect, it } from "vitest";
import { isAppleTerminal, shouldUseInkTui } from "../src/terminal-safety.js";
import type { ParsedArgs } from "../src/args.js";

const args: ParsedArgs = { command: "chat", positionals: [], flags: {} };

describe("terminal safety", () => {
  it("disables Ink by default in Apple Terminal", () => {
    expect(isAppleTerminal({ TERM_PROGRAM: "Apple_Terminal" })).toBe(true);
    expect(shouldUseInkTui(args, { TERM_PROGRAM: "Apple_Terminal" })).toBe(false);
  });

  it("allows explicit opt-in for Apple Terminal Ink", () => {
    expect(shouldUseInkTui(args, { TERM_PROGRAM: "Apple_Terminal", LYNN_CLI_APPLE_TERMINAL_INK: "1" })).toBe(true);
    expect(shouldUseInkTui(args, { TERM_PROGRAM: "Apple_Terminal", LYNN_CLI_FORCE_INK: "1" })).toBe(true);
  });

  it("keeps Ink enabled for other terminals unless disabled", () => {
    expect(shouldUseInkTui(args, { TERM_PROGRAM: "iTerm.app" })).toBe(true);
    expect(shouldUseInkTui(args, { TERM_PROGRAM: "iTerm.app", LYNN_CLI_LEGACY_TUI: "1" })).toBe(false);
    expect(shouldUseInkTui({ ...args, flags: { "no-ink": true } }, { TERM_PROGRAM: "iTerm.app" })).toBe(false);
  });
});
