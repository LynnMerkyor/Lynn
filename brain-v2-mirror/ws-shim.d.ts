declare module 'ws' {
  export default class WebSocket {
    constructor(url: string, options?: Record<string, unknown>);
    on(event: 'open', listener: () => void): this;
    on(event: 'message', listener: (data: Buffer | ArrayBuffer | Buffer[] | Uint8Array) => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
    on(event: 'close', listener: () => void): this;
    send(data: string | Buffer, callback?: (err?: Error) => void): void;
    close(): void;
  }
}
