import { DEFAULT_MODEL_CALL_TIMEOUTS, type ModelCallTimeouts } from "./model-call-timeouts.js";

export class ModelCallTimeoutError extends Error {
  constructor(readonly timeoutMs: number, readonly kind: "firstChunk" | "idle" | "total" = "total") {
    const label = { firstChunk: "首段等待超时 (first chunk)", idle: "流式空闲超时 (idle)", total: "总时限超时 (total)" }[kind];
    const env = { firstChunk: "LYNN_MODEL_FIRST_CHUNK_TIMEOUT_MS", idle: "LYNN_MODEL_IDLE_TIMEOUT_MS", total: "LYNN_MODEL_TOTAL_TIMEOUT_MS / LYNN_MODEL_CALL_TIMEOUT_MS（Brain 还需检查 LYNN_BRAIN_MODEL_CALL_TIMEOUT_MS）" }[kind];
    super(`LLM ${label}: timed out after ${timeoutMs}ms。请在设置 → 模型服务 → 模型请求超时中调大对应值，或调整环境变量 ${env}；总时限设为 0 表示不限制。`);
    this.name = "ModelCallTimeoutError";
  }
}

export function createTimedSignal(parent: AbortSignal | undefined, timeouts: ModelCallTimeouts | number): {
  signal: AbortSignal;
  didTimeout: () => boolean;
  timeoutError: () => ModelCallTimeoutError | undefined;
  activity: () => void;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const policy = typeof timeouts === "number" ? { ...DEFAULT_MODEL_CALL_TIMEOUTS, totalMs: timeouts } : timeouts;
  let failure: ModelCallTimeoutError | undefined;
  let phaseTimer: ReturnType<typeof setTimeout> | undefined;
  let totalTimer: ReturnType<typeof setTimeout> | undefined;
  let cleaned = false;
  const clearTimers = () => {
    clearTimeout(phaseTimer);
    clearTimeout(totalTimer);
  };
  const expire = (kind: "firstChunk" | "idle" | "total", duration: number) => {
    if (controller.signal.aborted || cleaned) return;
    failure = new ModelCallTimeoutError(duration, kind);
    clearTimers();
    parent?.removeEventListener("abort", abortFromParent);
    controller.abort(failure);
  };

  const abortFromParent = () => {
    clearTimers();
    const reason = (parent as AbortSignal & { reason?: unknown } | undefined)?.reason;
    try {
      controller.abort(reason);
    } catch {
      controller.abort();
    }
  };

  if (parent?.aborted) {
    abortFromParent();
  } else {
    parent?.addEventListener("abort", abortFromParent, { once: true });
  }

  if (!controller.signal.aborted) {
    phaseTimer = setTimeout(() => expire("firstChunk", policy.firstChunkMs), policy.firstChunkMs);
    if (policy.totalMs > 0) totalTimer = setTimeout(() => expire("total", policy.totalMs), policy.totalMs);
  }

  return {
    signal: controller.signal,
    didTimeout: () => !!failure,
    timeoutError: () => failure,
    activity: () => {
      if (cleaned || controller.signal.aborted) return;
      clearTimeout(phaseTimer);
      phaseTimer = setTimeout(() => expire("idle", policy.idleMs), policy.idleMs);
    },
    cleanup: () => {
      cleaned = true;
      clearTimers();
      parent?.removeEventListener("abort", abortFromParent);
    },
  };
}
