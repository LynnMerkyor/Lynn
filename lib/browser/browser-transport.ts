/**
 * browser-transport.js — BrowserManager 通信传输层
 *
 * 抽象 IPC 和 WS 两种传输方式，BrowserManager 只依赖 transport 接口。
 */

export type BrowserTransportHandler = (msg: unknown) => void;
type IpcMessageListener = (msg: unknown) => void;
type WebSocketMessageListener = (data: unknown) => void;

export interface BrowserWebSocket {
  on(event: "message", listener: WebSocketMessageListener): unknown;
  off(event: "message", listener: WebSocketMessageListener): unknown;
  send(data: string): unknown;
  readonly readyState?: number;
}

export interface BrowserTransport {
  readonly connected: boolean;
  send(msg: unknown): void;
  onMessage(handler: BrowserTransportHandler): void;
}

/** 基于 Node IPC 的传输（fork 模式，现有行为） */
export class IpcTransport implements BrowserTransport {
  private _boundListener: IpcMessageListener | null;

  constructor() {
    this._boundListener = null;
  }

  get connected(): boolean {
    return typeof process.send === "function";
  }

  send(msg: unknown): void {
    const send = process.send;
    if (typeof send !== "function") {
      throw new TypeError("process.send is not a function");
    }
    send(msg as Parameters<typeof send>[0]);
  }

  onMessage(handler: BrowserTransportHandler): void {
    // 清理旧 listener（防止重复注册）
    if (this._boundListener) {
      process.off("message", this._boundListener);
    }
    this._boundListener = (msg) => handler(msg);
    process.on("message", this._boundListener);
  }
}

/** 基于 WebSocket 的传输（spawn 模式） */
export class WsTransport implements BrowserTransport {
  private _ws: BrowserWebSocket | null;
  private _handler: BrowserTransportHandler | null;
  private _boundListener: WebSocketMessageListener | null;

  constructor() {
    this._ws = null;
    this._handler = null;
    this._boundListener = null;
  }

  get connected(): boolean {
    return this._ws?.readyState === 1; // WebSocket.OPEN
  }

  /** 由 server 启动时注入 ws 实例 */
  attach(ws: BrowserWebSocket | null): void {
    // 先清理旧 listener
    if (this._ws && this._boundListener) {
      this._ws.off("message", this._boundListener);
    }
    this._ws = ws;
    if (this._handler && ws) {
      this._boundListener = (data) => {
        let msg;
        try { msg = JSON.parse(String(data)); } catch { return; }
        this._handler!(msg);
      };
      ws.on("message", this._boundListener);
    }
  }

  detach(): void {
    if (this._ws && this._boundListener) {
      this._ws.off("message", this._boundListener);
    }
    this._ws = null;
    this._boundListener = null;
  }

  send(msg: unknown): void {
    const ws = this._ws;
    if (!this.connected || !ws) throw new Error("Browser WS transport not connected");
    ws.send(JSON.stringify(msg));
  }

  onMessage(handler: BrowserTransportHandler): void {
    this._handler = handler;
    // 如果 ws 已存在，立即绑定
    if (this._ws) {
      this.attach(this._ws);
    }
  }
}
