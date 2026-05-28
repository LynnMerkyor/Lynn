declare module "node-telegram-bot-api" {
  export interface TelegramBotOptions {
    polling?: boolean | Record<string, unknown>;
    [key: string]: unknown;
  }

  export interface TelegramUser {
    id: number | string;
    first_name?: string;
    username?: string;
    [key: string]: unknown;
  }

  export interface TelegramChat {
    id: number | string;
    type: "private" | "group" | "supergroup" | "channel" | (string & {});
    [key: string]: unknown;
  }

  export interface TelegramPhotoSize {
    file_id: string;
    width?: number;
    height?: number;
    [key: string]: unknown;
  }

  export interface TelegramDocument {
    file_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
    [key: string]: unknown;
  }

  export interface TelegramVoice {
    file_id: string;
    mime_type?: string;
    duration?: number;
    [key: string]: unknown;
  }

  export interface TelegramVideo {
    file_id: string;
    file_name?: string;
    mime_type?: string;
    duration?: number;
    [key: string]: unknown;
  }

  export interface TelegramMessage {
    text?: string;
    caption?: string;
    photo?: TelegramPhotoSize[];
    document?: TelegramDocument;
    voice?: TelegramVoice;
    video?: TelegramVideo;
    chat: TelegramChat;
    from?: TelegramUser;
    [key: string]: unknown;
  }

  export interface TelegramFileOptions {
    filename?: string;
    contentType?: string;
    [key: string]: unknown;
  }

  export default class TelegramBot {
    constructor(token: string, options?: TelegramBotOptions);
    on(event: "message", listener: (message: TelegramMessage) => void | Promise<void>): this;
    on(event: "polling_error", listener: (error: Error) => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
    getFileLink(fileId: string): Promise<string>;
    sendMessage(chatId: string, text: string): Promise<unknown>;
    sendPhoto(chatId: string, photo: string | Buffer, options?: Record<string, unknown>, fileOptions?: TelegramFileOptions): Promise<unknown>;
    sendVideo(chatId: string, video: string | Buffer, options?: Record<string, unknown>, fileOptions?: TelegramFileOptions): Promise<unknown>;
    sendAudio(chatId: string, audio: string | Buffer, options?: Record<string, unknown>, fileOptions?: TelegramFileOptions): Promise<unknown>;
    sendDocument(chatId: string, document: string | Buffer, options?: Record<string, unknown>, fileOptions?: TelegramFileOptions): Promise<unknown>;
    _request(method: string, options: Record<string, unknown>): Promise<unknown>;
    removeAllListeners(): this;
    stopPolling(): Promise<unknown>;
    getMe(): Promise<unknown>;
  }
}

declare module "ws" {
  export type RawData = Buffer | ArrayBuffer | Buffer[] | ArrayBufferView;

  export interface WebSocketOptions {
    [key: string]: unknown;
  }

  export default class WebSocket {
    static readonly OPEN: number;
    readonly OPEN: number;
    readyState: number;
    constructor(address: string | URL, options?: WebSocketOptions);
    on(event: "open", listener: () => void): this;
    on(event: "message", listener: (data: RawData, isBinary: boolean) => void): this;
    on(event: "close", listener: (code: number, reason: Buffer) => void): this;
    on(event: "error", listener: (error: Error) => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
    send(data: string | Buffer): void;
    send(data: string, options: { compress: boolean }, callback: (err?: Error) => void): void;
    close(): void;
    removeAllListeners(): this;
  }

  export { WebSocket };

  export class WebSocketServer {
    constructor(options?: WebSocketOptions);
    on(event: string, listener: (...args: unknown[]) => void): this;
    close(callback?: (err?: Error) => void): void;
  }
}
