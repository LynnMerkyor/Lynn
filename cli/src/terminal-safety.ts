import { hasFlag, type ParsedArgs } from "./args.js";

export interface TerminalTuiProfile {
  appleTerminal: boolean;
  animation: boolean;
  inlineImages: boolean;
  dynamicPlaceholders: boolean;
}

/**
 * Apple Terminal on recent macOS builds can crash while redrawing complex Ink
 * layouts during Chinese IME composition. Keep the modern Ink TUI, but use a
 * conservative rendering profile there: no inline image escape sequences, no
 * high-frequency shimmer/sweep animation, and no rotating placeholders. iTerm2,
 * kitty, VS Code and other terminals keep the full experience.
 */
export function shouldUseInkTui(args: ParsedArgs, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.LYNN_CLI_LEGACY_TUI === "1") return false;
  if (hasFlag(args.flags, "no-ink", "legacy-tui")) return false;
  return true;
}

export function terminalTuiProfile(env: NodeJS.ProcessEnv = process.env): TerminalTuiProfile {
  const appleTerminal = isAppleTerminal(env);
  const safe = appleTerminal && env.LYNN_CLI_APPLE_TERMINAL_FULL_TUI !== "1";
  return {
    appleTerminal,
    animation: env.LYNN_CLI_NO_TUI_ANIMATION === "1" ? false : !safe,
    inlineImages: env.LYNN_CLI_NO_INLINE_IMAGES === "1" ? false : !safe,
    dynamicPlaceholders: !safe,
  };
}

export function isAppleTerminal(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TERM_PROGRAM === "Apple_Terminal" || env.TERM_PROGRAM === "Apple Terminal";
}
