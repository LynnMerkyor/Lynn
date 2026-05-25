/**
 * Legacy internal retry compatibility shim.
 *
 * V0.79 intentionally removed hidden retry prompts and synthetic fallback text
 * from the Brain/default path. Keep these exports as inert compatibility
 * points for old tests/imports, but never schedule a model retry here.
 */

export function internalRetryCount(): number {
  return 0;
}

export function canScheduleInternalRetry(): boolean {
  return false;
}

export function markInternalRetry(): boolean {
  return false;
}

export function prepareInternalRetryStream(): null {
  return null;
}

export function scheduleInternalRetry(): boolean {
  return false;
}
