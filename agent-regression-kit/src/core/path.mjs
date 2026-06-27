export function getPath(value, pathKey) {
  if (!pathKey || pathKey === "$" || pathKey === ".") return value;
  const parts = String(pathKey)
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);
  let current = value;
  for (const part of parts) {
    if (current == null) return undefined;
    current = current[part];
  }
  return current;
}

export function interpolateDeep(value, vars) {
  if (typeof value === "string") return interpolateString(value, vars);
  if (Array.isArray(value)) return value.map((item) => interpolateDeep(item, vars));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolateDeep(item, vars)]));
  }
  return value;
}

export function interpolateString(value, vars) {
  return value.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (match, key) => {
    const replacement = getPath(vars, key);
    return replacement == null ? match : String(replacement);
  });
}

export function safeSlug(value) {
  return String(value || "case").replace(/[^a-z0-9._-]+/gi, "-").slice(0, 80) || "case";
}

export function stableStringify(value) {
  return JSON.stringify(stableNormalize(value));
}

function stableNormalize(value) {
  if (Array.isArray(value)) return value.map(stableNormalize);
  if (value && typeof value === "object") {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = stableNormalize(value[key]);
      return acc;
    }, {});
  }
  return value;
}
