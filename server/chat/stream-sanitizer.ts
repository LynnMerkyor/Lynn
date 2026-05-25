/**
 * Legacy stream sanitizer compatibility shim.
 *
 * Brain/default output is no longer filtered for pseudo-tool-looking text.
 * Streaming chunks are passed through verbatim; real tool events remain handled
 * by the structured event pipeline.
 */

export interface StreamSanitizerResult {
  text: string;
  suppressed: false;
}

export function stripStreamingPseudoToolBlocks(
  _ss: unknown,
  chunk: unknown,
): StreamSanitizerResult {
  return { text: String(chunk || ""), suppressed: false };
}

export function containsNonProgressPseudoToolSimulation(): false {
  return false;
}
