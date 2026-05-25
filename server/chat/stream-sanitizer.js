// @ts-check

/**
 * Legacy stream sanitizer compatibility shim.
 *
 * Brain/default output is no longer filtered for pseudo-tool-looking text.
 * Streaming chunks are passed through verbatim; real tool events remain handled
 * by the structured event pipeline.
 */

/**
 * @typedef {{ text: string, suppressed: false }} SanitizedStreamChunk
 */

/**
 * @param {unknown} _ss
 * @param {unknown} chunk
 * @returns {SanitizedStreamChunk}
 */
export function stripStreamingPseudoToolBlocks(_ss, chunk) {
  return { text: String(chunk || ""), suppressed: false };
}

/**
 * @returns {false}
 */
export function containsNonProgressPseudoToolSimulation() {
  return false;
}
