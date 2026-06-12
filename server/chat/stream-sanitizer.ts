import {
  containsPseudoToolSimulation,
  stripPseudoToolCallMarkup,
} from "../../shared/pseudo-tool-call.js";

export interface StreamSanitizerResult {
  text: string;
  suppressed: boolean;
}

export function stripStreamingPseudoToolBlocks(
  _ss: unknown,
  chunk: unknown,
): StreamSanitizerResult {
  const text = String(chunk || "");
  if (!containsPseudoToolSimulation(text)) return { text, suppressed: false };
  return { text: stripPseudoToolCallMarkup(text), suppressed: true };
}

export function containsNonProgressPseudoToolSimulation(raw: unknown): boolean {
  return containsPseudoToolSimulation(raw);
}
