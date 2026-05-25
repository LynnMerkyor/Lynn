export const CHAT_LIFECYCLE_EVENTS = Object.freeze([
  "prompt_start",
  "tool_start",
  "tool_end",
  "turn_end",
  "turn_close",
] as const);

export type ChatLifecycleEvent = typeof CHAT_LIFECYCLE_EVENTS[number];
export type LifecycleHookContext = Record<string, unknown>;
export type LifecycleHookHandler = (context: LifecycleHookContext) => void;

interface LifecycleHookErrorMeta {
  eventName: string;
  context: LifecycleHookContext;
}

interface LifecycleHookOptions {
  events?: readonly string[];
  onError?: (err: unknown, meta: LifecycleHookErrorMeta) => void;
}

export interface LifecycleHooks {
  tap(eventName: string, handler: LifecycleHookHandler): () => void;
  run(eventName: string, context?: LifecycleHookContext): number;
  count(eventName: string): number;
}

export function createLifecycleHooks(opts: LifecycleHookOptions = {}): LifecycleHooks {
  const handlers = new Map<string, LifecycleHookHandler[]>();
  const validEvents = new Set<string>(opts.events || CHAT_LIFECYCLE_EVENTS);

  function assertEvent(eventName: string): void {
    if (!validEvents.has(eventName)) {
      throw new Error(`Unknown lifecycle hook: ${eventName}`);
    }
  }

  function tap(eventName: string, handler: LifecycleHookHandler): () => void {
    assertEvent(eventName);
    if (typeof handler !== "function") {
      throw new TypeError("Lifecycle hook handler must be a function");
    }
    const list = handlers.get(eventName) || [];
    list.push(handler);
    handlers.set(eventName, list);
    return () => {
      const next = (handlers.get(eventName) || []).filter((item) => item !== handler);
      if (next.length > 0) handlers.set(eventName, next);
      else handlers.delete(eventName);
    };
  }

  function run(eventName: string, context: LifecycleHookContext = {}): number {
    assertEvent(eventName);
    const list = handlers.get(eventName) || [];
    for (const handler of list) {
      try {
        handler(context);
      } catch (err) {
        opts.onError?.(err, { eventName, context });
      }
    }
    return list.length;
  }

  function count(eventName: string): number {
    assertEvent(eventName);
    return (handlers.get(eventName) || []).length;
  }

  return { tap, run, count };
}
