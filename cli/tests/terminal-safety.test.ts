import { describe, expect, it } from "vitest";
import { isAppleTerminal, shouldUseInkTui, terminalTuiProfile } from "../src/terminal-safety.js";
import { shouldUseNativeLineInput } from "../src/interactive-line.js";
import type { ParsedArgs } from "../src/args.js";

const args: ParsedArgs = { command: "chat", positionals: [], flags: {} };

describe("terminal safety", () => {
  it("defaults Apple Terminal to the stable non-Ink renderer", () => {
    const env = { TERM_PROGRAM: "Apple_Terminal" };
    expect(isAppleTerminal(env)).toBe(true);
    expect(shouldUseInkTui(args, env)).toBe(false);
    expect(shouldUseNativeLineInput(env)).toBe(true);
    expect(terminalTuiProfile(env)).toEqual({
      appleTerminal: true,
      animation: false,
      // 等待期流光(stderr,用户不打字)与输入法闪退无关 → Apple Terminal 也保持开。
      waitAnimation: true,
      inlineImages: false,
      dynamicPlaceholders: false,
    });
  });

  it("allows explicit opt-in for full Apple Terminal Ink", () => {
    expect(shouldUseInkTui(args, { TERM_PROGRAM: "Apple_Terminal", LYNN_CLI_APPLE_TERMINAL_FULL_TUI: "1" })).toBe(true);
    expect(terminalTuiProfile({ TERM_PROGRAM: "Apple_Terminal", LYNN_CLI_APPLE_TERMINAL_FULL_TUI: "1" })).toMatchObject({
      appleTerminal: true,
      animation: true,
      inlineImages: true,
      dynamicPlaceholders: true,
    });
  });

  it("keeps the full profile for other terminals unless disabled", () => {
    expect(terminalTuiProfile({ TERM_PROGRAM: "iTerm.app" })).toMatchObject({
      appleTerminal: false,
      animation: true,
      inlineImages: true,
      dynamicPlaceholders: true,
    });
    expect(shouldUseInkTui(args, { TERM_PROGRAM: "iTerm.app", LYNN_CLI_LEGACY_TUI: "1" })).toBe(false);
    expect(shouldUseInkTui({ ...args, flags: { "no-ink": true } }, { TERM_PROGRAM: "iTerm.app" })).toBe(false);
  });

  it("honors global animation and image disables", () => {
    expect(terminalTuiProfile({ TERM_PROGRAM: "iTerm.app", LYNN_CLI_NO_TUI_ANIMATION: "1", LYNN_CLI_NO_INLINE_IMAGES: "1" })).toMatchObject({
      animation: false,
      waitAnimation: false, // 显式总开关也关掉等待期流光
      inlineImages: false,
      dynamicPlaceholders: true,
    });
  });
});
