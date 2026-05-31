import { hasFlag, type ParsedArgs } from "./args.js";

/**
 * Apple Terminal on recent macOS builds can crash while redrawing Ink layouts
 * during Chinese IME composition. Keep Ink enabled for terminals that handle
 * alternate-screen/reactive redraws well, but default Terminal.app to the
 * conservative readline renderer unless the user explicitly opts back in.
 */
export function shouldUseInkTui(args: ParsedArgs, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.LYNN_CLI_LEGACY_TUI === "1") return false;
  if (hasFlag(args.flags, "no-ink", "legacy-tui")) return false;
  if (env.LYNN_CLI_FORCE_INK === "1") return true;
  if (isAppleTerminal(env) && env.LYNN_CLI_APPLE_TERMINAL_INK !== "1") return false;
  return true;
}

export function isAppleTerminal(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TERM_PROGRAM === "Apple_Terminal" || env.TERM_PROGRAM === "Apple Terminal";
}
