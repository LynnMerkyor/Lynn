const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

export type MemoryOutcome = "helpful" | "harmful";

export function isMemoryOutcomeFeedbackEnabled(): boolean {
  return TRUE_VALUES.has(String(process.env.LYNN_MEMORY_OUTCOME_FEEDBACK || "").trim().toLowerCase());
}

export function normalizeMemoryOutcome(value: unknown): MemoryOutcome | null {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "helpful" || normalized === "harmful") return normalized;
  return null;
}
