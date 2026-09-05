/** A header deadline never cancels a response body after fetch has resolved.
 * Caller cancellation remains attached for the entire response/stream lifetime. */
export function createRequestDeadline(timeoutMs: number, caller?: AbortSignal | null, reason?: Error) {
  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    if (caller?.aborted) return;
    expired = true;
    controller.abort(reason || new DOMException('Request timed out', 'TimeoutError'));
  }, timeoutMs);
  return {
    signal: caller ? AbortSignal.any([caller, controller.signal]) : controller.signal,
    get timedOut() { return expired; },
    dispose() { clearTimeout(timer); },
  };
}
