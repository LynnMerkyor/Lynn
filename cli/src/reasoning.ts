import { getStringFlag, hasFlag, type ParsedArgs } from "./args.js";

export type ReasoningEffort = "auto" | "off" | "low" | "medium" | "high" | "xhigh";
export type ReasoningDisplay = "auto" | "always" | "never";

const EFFORTS: ReadonlySet<string> = new Set(["auto", "off", "low", "medium", "high", "xhigh"]);
const DISPLAYS: ReadonlySet<string> = new Set(["auto", "always", "never"]);

/** /fast and --fast cap the output budget so short interactions stay short. */
export const FAST_MODE_MAX_TOKENS = 8_192;

export interface ReasoningOptions {
  effort: ReasoningEffort;
  display: ReasoningDisplay;
  /** Optional output budget cap (sent as extra_body.max_tokens; Brain forwards it upstream). */
  maxTokens?: number;
}

/**
 * Fast mode = the real low-latency profile on a reasoning-always head (StepFun 3.7 Flash has no
 * true "off"): pin reasoning to low AND cap the output budget at 8K. Switching to any explicit
 * effort level clears the cap.
 */
export function applyFastReasoning(current: ReasoningOptions): ReasoningOptions {
  return { ...current, effort: "low", maxTokens: FAST_MODE_MAX_TOKENS };
}

function oneOf<T extends string>(value: string | null, allowed: ReadonlySet<string>, fallback: T): T {
  return value && allowed.has(value) ? value as T : fallback;
}

export function parseReasoningOptions(args: ParsedArgs): ReasoningOptions {
  const fast = hasFlag(args.flags, "fast");
  return {
    // Default "auto" defers to the provider default (StepFun: high on the first round) while
    // letting the Brain drop tool-continuation rounds to medium. An explicit --reasoning value
    // pins every round (the Brain honors client-pinned efforts and never steps them down).
    // --fast pins low + an 8K output cap (an explicit --reasoning still wins on effort).
    effort: oneOf(getStringFlag(args.flags, "reasoning"), EFFORTS, fast ? "low" : "auto"),
    display: oneOf(getStringFlag(args.flags, "show-reasoning"), DISPLAYS, "auto"),
    ...(fast ? { maxTokens: FAST_MODE_MAX_TOKENS } : {}),
  };
}

/**
 * Step reasoning effort down one notch — used to retry a turn whose reasoning overflowed the
 * token budget (high/xhigh→medium, medium/auto→low). low/off are already minimal, returned as-is.
 */
export function lowerReasoningEffort(effort: ReasoningEffort): ReasoningEffort {
  switch (effort) {
    case "xhigh":
    case "high":
      return "medium";
    case "medium":
    case "auto":
      return "low";
    default:
      return effort;
  }
}

export function shouldRenderReasoning(display: ReasoningDisplay, json: boolean): boolean {
  if (json) return true;
  return display === "always";
}

export function applyReasoningToBody(body: Record<string, unknown>, options: ReasoningOptions): Record<string, unknown> {
  if (options.effort === "off") {
    body.reasoning_effort = "off";
    body.extra_body = { ...(body.extra_body as Record<string, unknown> | undefined), enable_thinking: false };
  } else if (options.effort !== "auto") {
    body.reasoning_effort = options.effort;
    body.extra_body = { ...(body.extra_body as Record<string, unknown> | undefined), reasoning_effort: options.effort };
  }
  if (typeof options.maxTokens === "number" && Number.isFinite(options.maxTokens) && options.maxTokens > 0) {
    // Brain forwards extra_body upstream after the provider default, so this caps max_tokens.
    body.extra_body = { ...(body.extra_body as Record<string, unknown> | undefined), max_tokens: options.maxTokens };
  }
  return body;
}
