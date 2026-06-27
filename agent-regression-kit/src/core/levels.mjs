export const LEVEL_RANK = Object.freeze({
  smoke: 0,
  release: 1,
  nightly: 2,
});

export function normalizeLevel(level) {
  const normalized = String(level || "release").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(LEVEL_RANK, normalized) ? normalized : "release";
}

export function levelRank(level) {
  return LEVEL_RANK[normalizeLevel(level)];
}

export function arrayFrom(value) {
  if (!value) return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}
