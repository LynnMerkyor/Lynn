// Brain v2 verifier middleware is intentionally inert.
//
// BYOK-equality policy: Brain must not ask a second model to grade tool
// results or decide whether the primary model's answer is good enough.
// Keep this compatibility export for scripts/tests that still import it.

export async function verifyToolResult() {
  return {
    skipped: true,
    pass: true,
    reason: 'disabled_by_byok_equality',
  };
}

export const _internals = {
  disabled: true,
};
