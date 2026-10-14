export interface ModelCallTimeouts {
  firstChunkMs: number;
  idleMs: number;
  totalMs: number;
}

export const DEFAULT_MODEL_CALL_TIMEOUTS: ModelCallTimeouts = {
  firstChunkMs: 600_000,
  idleMs: 600_000,
  totalMs: 0,
};

export const MAX_MODEL_TIMEOUT_MS = 2_147_483_647;

export function normalizeModelCallTimeouts(value: unknown): ModelCallTimeouts {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const result = { ...DEFAULT_MODEL_CALL_TIMEOUTS };
  for (const key of Object.keys(result) as Array<keyof ModelCallTimeouts>) {
    const candidate = input[key];
    if (typeof candidate === "number" && Number.isInteger(candidate)
      && candidate >= (key === "totalMs" ? 0 : 1) && candidate <= MAX_MODEL_TIMEOUT_MS) {
      result[key] = candidate;
    }
  }
  return result;
}

export function isValidModelCallTimeouts(value: unknown): value is ModelCallTimeouts {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  const normalized = normalizeModelCallTimeouts(value);
  return Object.keys(input).length === 3
    && (Object.keys(normalized) as Array<keyof ModelCallTimeouts>).every(key => input[key] === normalized[key]);
}
