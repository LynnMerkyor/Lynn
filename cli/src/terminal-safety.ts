import { hasFlag, type ParsedArgs } from "./args.js";

export interface TerminalTuiProfile {
  appleTerminal: boolean;
  animation: boolean;
  waitAnimation: boolean;
  inlineImages: boolean;
  dynamicPlaceholders: boolean;
}

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
