// @ts-nocheck
// Brain v2 checkpoint is intentionally inert.
//
// BYOK-equality policy: Brain must not ask a second model to judge, replan,
// abort, or rewrite an agent/model turn. Keep this module as a compatibility
// export for older callers, but never call an LLM from here.

export async function checkpointAgent() {
  return {
    ok: true,
    verdict: 'continue',
    scores: null,
    avg: null,
    reason: 'disabled_by_byok_equality',
    latencyMs: 0,
    failOpen: false,
    parseFailed: false,
  };
}

export const _internals = {
  disabled: true,
};
