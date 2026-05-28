export type BridgeStatus = "connecting" | "connected" | "disconnected" | "error" | (string & {});

export interface BridgeAttachment {
  type: "image" | "audio" | "video" | "file" | (string & {});
  url?: string;
  platformRef?: string;
  _messageId?: string;
  filename?: string;
  mimeType?: string;
  duration?: number;
  size?: number;
  width?: number;
  height?: number;
}

export interface BridgeMessagePayload {
  platform?: string;
  chatId: string;
  userId?: string;
  sessionKey: string;
  text: string;
  senderName?: string | null;
  avatarUrl?: string | null;
  isGroup?: boolean;
  attachments?: BridgeAttachment[];
  _msgId?: string;
}

export type BridgeMessageHandler = (msg: BridgeMessagePayload) => void | Promise<void>;
export type BridgeStatusHandler = (status: BridgeStatus, error?: string) => void;

export interface SendMediaBufferMeta {
  mime: string;
  filename: string;
}

export interface BridgeAdapterCapabilities {
  proactive?: boolean;
}

export interface BridgeAdapter {
  capabilities?: BridgeAdapterCapabilities;
  sendReply(chatId: string, text: string, ...args: unknown[]): Promise<unknown>;
  sendBlockReply?(chatId: string, text: string, ...args: unknown[]): Promise<unknown>;
  sendDraft?(chatId: string, text: string): Promise<unknown>;
  sendMedia?(chatId: string, source: string): Promise<unknown>;
  sendMediaBuffer?(chatId: string, buffer: Buffer, meta: SendMediaBufferMeta): Promise<unknown>;
  downloadImage?(platformRef: string): Promise<Buffer>;
  downloadFile?(messageId: string, fileKey: string): Promise<Buffer>;
  resolveOwnerChatId?(userId: string): string | null | undefined;
  canReply?(chatId: string): boolean;
  stop(): void | Promise<void>;
  getMe?(): Promise<unknown>;
}
