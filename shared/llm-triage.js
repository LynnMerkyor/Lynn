/**
 * Route triage compatibility helpers.
 *
 * BYOK-equality policy: route classification must not call another model with
 * hidden instructions before the selected model answers. The async classifier
 * therefore always returns null and callers fall back to deterministic regex.
 */

export async function classifyByLLM() {
  return null;
}

/**
 * Confidence for deterministic route-regex hits.
 */
export function scoreRegexConfidence(regexHits) {
  const hits = Object.values(regexHits || {}).filter(Boolean).length;
  if (hits === 0) return 0.50;
  if (hits === 1) return 0.92;
  if (hits === 2) return 0.55;
  return 0.40;
}

export function _resetTriageCache() {}

export function _triageCacheSize() {
  return 0;
}
