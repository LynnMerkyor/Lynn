import { getStringFlag, type ParsedArgs } from "./args.js";

export type ReasoningEffort = "auto" | "off" | "low" | "medium" | "high" | "xhigh";
export type ReasoningDisplay = "auto" | "always" | "never";

const EFFORTS: ReadonlySet<string> = new Set(["auto", "off", "low", "medium", "high", "xhigh"]);
const DISPLAYS: ReadonlySet<string> = new Set(["auto", "always", "never"]);

export interface ReasoningOptions {
  effort: ReasoningEffort;
  display: ReasoningDisplay;
}

function oneOf<T extends string>(value: string | null, allowed: ReadonlySet<string>, fallback: T): T {
  return value && allowed.has(value) ? value as T : fallback;
}

export function parseReasoningOptions(args: ParsedArgs): ReasoningOptions {
  return {
    effort: oneOf(getStringFlag(args.flags, "reasoning"), EFFORTS, "high"),
    display: oneOf(getStringFlag(args.flags, "show-reasoning"), DISPLAYS, "auto"),
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
    return body;
  }
  if (options.effort !== "auto") {
    body.reasoning_effort = options.effort;
    body.extra_body = { ...(body.extra_body as Record<string, unknown> | undefined), reasoning_effort: options.effort };
  }
  return body;
}
