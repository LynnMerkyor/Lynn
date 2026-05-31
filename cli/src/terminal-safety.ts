import { hasFlag, type ParsedArgs } from "./args.js";

export interface TerminalTuiProfile {
  appleTerminal: boolean;
  /** 输入区/重绘类动画(raw-mode 重画)。Apple Terminal 关 → 防中文输入法闪退。 */
  animation: boolean;
  /**
   * 模型等待期的单行 \r 流光(stderr,用户此刻不打字 → 不碰 stdin/raw mode)。
   * 这条路径与输入法闪退无关,所以 Apple Terminal 也照常跑,只有显式
   * LYNN_CLI_NO_TUI_ANIMATION=1 才关闭。
   */
  waitAnimation: boolean;
  inlineImages: boolean;
  dynamicPlaceholders: boolean;
}

/**
 * Apple Terminal on recent macOS builds can crash inside Terminal.app/AppKit
 * while Ink redraws during Chinese IME composition. That crash happens in the
 * terminal process, so Lynn cannot catch or log it. Default Apple Terminal to
 * the stable line renderer; iTerm2, kitty, VS Code and other terminals keep the
 * full Ink experience. Advanced users can opt back in with
 * LYNN_CLI_APPLE_TERMINAL_FULL_TUI=1.
 */
export function shouldUseInkTui(args: ParsedArgs, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.LYNN_CLI_LEGACY_TUI === "1") return false;
  if (hasFlag(args.flags, "no-ink", "legacy-tui")) return false;
  if (isAppleTerminal(env) && env.LYNN_CLI_APPLE_TERMINAL_FULL_TUI !== "1") return false;
  return true;
}

export function terminalTuiProfile(env: NodeJS.ProcessEnv = process.env): TerminalTuiProfile {
  const appleTerminal = isAppleTerminal(env);
  const safe = appleTerminal && env.LYNN_CLI_APPLE_TERMINAL_FULL_TUI !== "1";
  return {
    appleTerminal,
    animation: env.LYNN_CLI_NO_TUI_ANIMATION === "1" ? false : !safe,
    waitAnimation: env.LYNN_CLI_NO_TUI_ANIMATION !== "1",
    inlineImages: env.LYNN_CLI_NO_INLINE_IMAGES === "1" ? false : !safe,
    dynamicPlaceholders: !safe,
  };
}

export function isAppleTerminal(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TERM_PROGRAM === "Apple_Terminal" || env.TERM_PROGRAM === "Apple Terminal";
}
