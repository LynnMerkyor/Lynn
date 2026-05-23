/**
 * Legacy internal retry compatibility shim.
 *
 * V0.79 intentionally removed hidden retry prompts and synthetic fallback text
 * from the Brain/default path. Keep these exports as inert compatibility
 * points for old tests/imports, but never schedule a model retry here.
 */

export function internalRetryCount() {
  return 0;
}

export function canScheduleInternalRetry() {
  return false;
}

export function markInternalRetry() {
  return false;
}

export function prepareInternalRetryStream() {
  return null;
}

export function scheduleInternalRetry() {
  return false;
}
