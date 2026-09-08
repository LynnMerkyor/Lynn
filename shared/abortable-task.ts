/** Stop waiting immediately and consume late settlements without running a continuation. */
export function runAbortable<T>(task: () => T | PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(signal?.reason); };
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    signal?.addEventListener("abort", onAbort, { once: true });
    Promise.resolve().then(() => {
      signal?.throwIfAborted();
      return task();
    }).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}
