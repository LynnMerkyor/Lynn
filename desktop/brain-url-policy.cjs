"use strict";

// Brain API/provider URL canonicalization + deprecation checks (pure).
// Extracted from main.cjs.

const CANONICAL_BRAIN_API_ROOT = "https://api.merkyorlynn.com/api/v2";
const CANONICAL_BRAIN_PROVIDER_BASE_URL = `${CANONICAL_BRAIN_API_ROOT}/v1`;
const DEPRECATED_BRAIN_API_ROOTS = new Set([
  "https://api.merkyorlynn.com/api",
  "http://82.156.182.240/api",
]);
const DEPRECATED_BRAIN_PROVIDER_BASE_URLS = new Set([
  "https://api.merkyorlynn.com/api/v1",
  "http://82.156.182.240/api/v1",
]);

function normalizeBrainUrl(value) {
  const text = String(value || "").trim();
  return text ? text.replace(/\/+$/, "") : "";
}

function isDeprecatedBrainApiRoot(value) {
  const normalized = normalizeBrainUrl(value);
  return normalized ? DEPRECATED_BRAIN_API_ROOTS.has(normalized) : false;
}

function isDeprecatedBrainProviderBaseUrl(value) {
  const normalized = normalizeBrainUrl(value);
  return normalized ? DEPRECATED_BRAIN_PROVIDER_BASE_URLS.has(normalized) : false;
}

function isAllowedBrainApiRoot(value) {
  const normalized = normalizeBrainUrl(value);
  if (!normalized) return false;
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "https:") return false;
    return parsed.hostname === "api.merkyorlynn.com";
  } catch {
    return false;
  }
}

function canonicalizeBrainApiRoot(value) {
  return isAllowedBrainApiRoot(value) ? normalizeBrainUrl(value) : CANONICAL_BRAIN_API_ROOT;
}

function canonicalizeBrainProviderBaseUrl(value) {
  const normalized = normalizeBrainUrl(value);
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol === "https:" && parsed.hostname === "api.merkyorlynn.com") {
      return normalized;
    }
  } catch {}
  return CANONICAL_BRAIN_PROVIDER_BASE_URL;
}

module.exports = {
  CANONICAL_BRAIN_API_ROOT,
  CANONICAL_BRAIN_PROVIDER_BASE_URL,
  DEPRECATED_BRAIN_API_ROOTS,
  DEPRECATED_BRAIN_PROVIDER_BASE_URLS,
  normalizeBrainUrl,
  isDeprecatedBrainApiRoot,
  isDeprecatedBrainProviderBaseUrl,
  isAllowedBrainApiRoot,
  canonicalizeBrainApiRoot,
  canonicalizeBrainProviderBaseUrl,
};
