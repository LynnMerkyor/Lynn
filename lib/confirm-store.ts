/**
 * ConfirmStore — 阻塞式确认存储
 *
 * 工具调用时创建 pending confirmation，阻塞 tool.execute() 的 Promise。
 * 前端渲染确认卡片，用户操作后通过 REST API resolve Promise。
 * 支持超时自动 resolve、session 终止时批量清理。
 */

import crypto from "crypto";

const DEFAULT_TIMEOUT = 5 * 60 * 1000; // 5 分钟

export type ConfirmKind = string;
export type ConfirmAction = string;

export interface ConfirmPayload {
  [key: string]: unknown;
}

export interface ConfirmResult {
  action: ConfirmAction;
  value?: unknown;
}

export type OnResolvedCallback = (confirmId: string, action: ConfirmAction) => void;

interface PendingEntry {
  resolve: (result: ConfirmResult) => void;
  timer: NodeJS.Timeout;
  sessionPath: string | null | undefined;
  kind: ConfirmKind;
  payload: ConfirmPayload;
}

export class ConfirmStore {
  private _pending: Map<string, PendingEntry>;
  public onResolved: OnResolvedCallback | null;

  constructor() {
    this._pending = new Map();
    this.onResolved = null;
  }

  /**
   * 创建一个 pending confirmation，返回 confirmId 和阻塞 Promise
   *
   * @param kind - 确认类型（'settings' | 'cron'）
   * @param payload - 确认内容（传给前端渲染卡片）
   * @param sessionPath - 所属 session（用于批量清理）
   * @param timeoutMs - 超时毫秒数
   * @returns confirmId 和阻塞 Promise
   */
  create(
    kind: ConfirmKind,
    payload: ConfirmPayload,
    sessionPath?: string | null,
    timeoutMs: number = DEFAULT_TIMEOUT
  ): { confirmId: string; promise: Promise<ConfirmResult> } {
    const confirmId = crypto.randomUUID();
    let resolve: (result: ConfirmResult) => void;
    const promise = new Promise<ConfirmResult>(r => { resolve = r; });

    const timer = setTimeout(() => {
      if (this._pending.has(confirmId)) {
        this._pending.delete(confirmId);
        resolve({ action: "timeout" });
        this.onResolved?.(confirmId, "timeout");
      }
    }, timeoutMs);

    this._pending.set(confirmId, { resolve: resolve!, timer, sessionPath, kind, payload });
    return { confirmId, promise };
  }

  /**
   * resolve 一个 pending confirmation
   *
   * @param confirmId - 确认 ID
   * @param action - 用户操作
   * @param value - 用户可能编辑后的值
   * @returns 是否找到并 resolve 了
   */
  resolve(confirmId: string, action: ConfirmAction, value?: unknown): boolean {
    const entry = this._pending.get(confirmId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this._pending.delete(confirmId);
    entry.resolve({ action, value });
    return true;
  }

  /**
   * 查看 pending confirmation 的详情
   * @param confirmId - 确认 ID
   * @returns pending entry 或 null
   */
  peek(confirmId: string): PendingEntry | null {
    return this._pending.get(confirmId) || null;
  }

  /**
   * session 终止时，清理该 session 的所有 pending confirmation
   * @param sessionPath - session 路径
   */
  abortBySession(sessionPath: string): void {
    for (const [id, entry] of this._pending) {
      if (entry.sessionPath === sessionPath) {
        clearTimeout(entry.timer);
        this._pending.delete(id);
        entry.resolve({ action: "aborted" });
        this.onResolved?.(id, "aborted");
      }
    }
  }

  /** 获取 pending 数量（调试用） */
  get size(): number { return this._pending.size; }
}
