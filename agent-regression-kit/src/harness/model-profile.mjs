export function normalizeModelProfile(input = {}) {
  const profile = {
    provider: input.provider || "openai-compatible",
    baseUrl: input.baseUrl || "${ARK_MODEL_BASE_URL}",
    model: input.model || "${ARK_MODEL_ID}",
    apiKeyEnv: input.apiKeyEnv || "ARK_MODEL_API_KEY",
    capability: input.capability || "unknown",
    deterministic: input.deterministic === true,
  };
  return {
    ...profile,
    liveAssertions: liveAssertionPolicy(profile),
  };
}

export function liveAssertionPolicy(profile) {
  if (profile.deterministic) {
    return {
      exactTextAllowed: true,
      requireClosedTurn: true,
      requireNonEmptyVisibleAnswer: true,
      allowSemanticJudge: false,
    };
  }
  return {
    exactTextAllowed: false,
    requireClosedTurn: true,
    requireNonEmptyVisibleAnswer: true,
    allowSemanticJudge: profile.capability !== "weak",
  };
}
