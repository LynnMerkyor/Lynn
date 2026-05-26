/**
 * EventBus — 统一事件总线
 *
 * 通过 engine.setEventBus() 注入，Engine 的 _emitEvent / subscribe 委托到这里。
 * 支持带过滤的订阅：按 sessionPath / event type 过滤。
 * 支持 request/handle 请求响应模式，供 plugin 间通信使用。
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface HubEvent {
  type: string;
  _hubContext?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface EventFilter {
  sessionPath?: string | null;
  types?: string[];
}

export type EventCallback = (
  event: HubEvent,
  sessionPath?: string | null,
) => void | Promise<void>;

export interface RequestOptions {
  timeout?: number;
}

export type BusHandler<Payload = unknown, Result = unknown> = (
  payload: Payload,
) => Result | Promise<Result | typeof EventBus.SKIP> | typeof EventBus.SKIP;

interface Subscriber {
  callback: EventCallback;
  filter: EventFilter;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class BusNoHandlerError extends Error {
  readonly type: string;

  constructor(type: string) {
    super(`No handler registered for "${type}"`);
    this.name = "BusNoHandlerError";
    this.type = type;
  }
}

export class BusTimeoutError extends Error {
  readonly type: string;

  constructor(type: string, ms: number) {
    super(`Request "${type}" timeout after ${ms}ms`);
    this.name = "BusTimeoutError";
    this.type = type;
  }
}

export class EventBus {
  private _subscribers: Map<number, Subscriber>;
  private _nextId: number;
  private _handlers: Map<string, BusHandler[]>;
  private _asyncContext: AsyncLocalStorage<Record<string, unknown>>;

  constructor() {
    this._subscribers = new Map();
    this._nextId = 0;
    this._handlers = new Map();
    this._asyncContext = new AsyncLocalStorage();
  }

  runWithContext<T>(context: Record<string, unknown> | null | undefined, fn: () => T): T {
    return this._asyncContext.run(context || {}, fn);
  }

  /**
   * 订阅事件
   * @param {Function} callback  (event, sessionPath) => void
   * @param {object} [filter]
   * @param {string} [filter.sessionPath]  只接收该 session 的事件
   * @param {string[]} [filter.types]      只接收这些 event.type
   * @returns {Function} unsubscribe
   */
  subscribe(callback: EventCallback, filter: EventFilter = {}): () => boolean {
    const id = ++this._nextId;
    this._subscribers.set(id, { callback, filter });
    return () => this._subscribers.delete(id);
  }

  /**
   * 发射事件
   * @param {object} event        事件对象，需有 type 字段
   * @param {string|null} sessionPath  关联的 session 路径
   */
  emit(event: HubEvent, sessionPath?: string | null): void {
    const context = this._asyncContext.getStore();
    const eventWithContext = context && Object.keys(context).length
      ? { ...event, _hubContext: context }
      : event;
    for (const [, { callback, filter }] of this._subscribers) {
      if (filter.sessionPath && filter.sessionPath !== sessionPath) continue;
      if (filter.types && !filter.types.includes(eventWithContext.type)) continue;
      try {
        const result = callback(eventWithContext, sessionPath);
        if (result && typeof result.then === "function") {
          result.catch((err) => {
            console.error("[EventBus] subscriber async error:", errorMessage(err));
          });
        }
      } catch (err) {
        console.error("[EventBus] subscriber error:", errorMessage(err));
      }
    }
  }

  /** 清理所有订阅和 handler */
  clear(): void {
    this._subscribers.clear();
    this._handlers.clear();
  }

  static readonly SKIP = Symbol("BUS_SKIP");

  /**
   * 注册请求处理器
   * @param {string} type           请求类型
   * @param {Function} handler      async (payload) => result | EventBus.SKIP
   * @returns {Function} unhandle
   */
  handle<Payload = unknown, Result = unknown>(
    type: string,
    handler: BusHandler<Payload, Result>,
  ): () => void {
    if (!this._handlers.has(type)) this._handlers.set(type, []);
    this._handlers.get(type)!.push(handler as BusHandler);
    return () => {
      const arr = this._handlers.get(type);
      if (!arr) return;
      const idx = arr.indexOf(handler as BusHandler);
      if (idx !== -1) arr.splice(idx, 1);
      if (arr.length === 0) this._handlers.delete(type);
    };
  }

  /**
   * 发起请求，等待第一个不返回 SKIP 的 handler 响应
   * @param {string} type
   * @param {object} payload
   * @param {object} [options]
   * @param {number} [options.timeout=30000]
   * @returns {Promise<any>}
   */
  async request<Result = unknown, Payload = unknown>(
    type: string,
    payload: Payload,
    options: RequestOptions = {},
  ): Promise<Result> {
    const handlers = this._handlers.get(type);
    if (!handlers || handlers.length === 0) throw new BusNoHandlerError(type);
    const timeout = options.timeout ?? 30000;

    let timerId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timerId = setTimeout(() => reject(new BusTimeoutError(type, timeout)), timeout);
    });

    try {
      return await Promise.race<Result>([
        this._tryHandlers(type, handlers, payload),
        timeoutPromise,
      ]);
    } finally {
      clearTimeout(timerId);
    }
  }

  private async _tryHandlers<Result = unknown, Payload = unknown>(
    type: string,
    handlers: BusHandler[],
    payload: Payload,
  ): Promise<Result> {
    for (const h of [...handlers]) {
      const result = await h(payload);
      if (result !== EventBus.SKIP) return result as Result;
    }
    throw new BusNoHandlerError(type);
  }

  /**
   * 检查某个 type 是否有已注册的 handler
   * @param {string} type
   * @returns {boolean}
   */
  hasHandler(type: string): boolean {
    const arr = this._handlers.get(type);
    return arr != null && arr.length > 0;
  }
}
