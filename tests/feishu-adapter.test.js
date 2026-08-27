import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => {
  const handlers = new Map();
  const channel = {
    rawClient: {
      contact: {
        user: {
          get: vi.fn().mockResolvedValue({ data: { user: { nickname: "Lynn", avatar: { avatar_240: "https://avatar" } } } }),
        },
      },
    },
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    on: vi.fn((name, handler) => { handlers.set(name, handler); return () => handlers.delete(name); }),
    send: vi.fn().mockResolvedValue({ messageId: "sent-1" }),
    downloadResource: vi.fn().mockResolvedValue(Buffer.from("resource")),
  };
  return { handlers, channel, createLarkChannel: vi.fn(() => channel) };
});

vi.mock("@larksuiteoapi/node-sdk", () => ({
  createLarkChannel: sdk.createLarkChannel,
  LoggerLevel: { warn: "warn" },
}));

vi.mock("../lib/debug-log.js", () => ({ debugLog: () => null }));

import { __testing__, createFeishuAdapter, testFeishuConnection } from "../lib/bridge/feishu-adapter.js";

describe("Feishu Channel adapter", () => {
  beforeEach(() => {
    sdk.handlers.clear();
    vi.clearAllMocks();
    sdk.channel.connect.mockResolvedValue(undefined);
    sdk.channel.disconnect.mockResolvedValue(undefined);
  });

  it("uses the public Channel handshake and lifecycle", async () => {
    const onStatus = vi.fn();
    await createFeishuAdapter({ appId: "cli_test", appSecret: "secret", onMessage: vi.fn(), onStatus });

    expect(sdk.createLarkChannel).toHaveBeenCalledWith(expect.objectContaining({
      appId: "cli_test",
      appSecret: "secret",
      handshakeTimeoutMs: 15_000,
      wsConfig: { pingTimeout: 45 },
    }));
    expect(sdk.channel.connect).toHaveBeenCalledOnce();
    expect(onStatus).toHaveBeenLastCalledWith("connected");

    sdk.handlers.get("reconnecting")();
    expect(onStatus).toHaveBeenLastCalledWith("connecting");
    sdk.handlers.get("reconnected")();
    expect(onStatus).toHaveBeenLastCalledWith("connected");
  });

  it("tests credentials with the same real handshake and closes it", async () => {
    sdk.channel.botIdentity = { openId: "ou_bot", name: "Lynn Bot" };
    await expect(testFeishuConnection("cli_test", "secret")).resolves.toEqual({ name: "Lynn Bot", openId: "ou_bot" });
    expect(sdk.channel.connect).toHaveBeenCalledOnce();
    expect(sdk.channel.disconnect).toHaveBeenCalledOnce();
    delete sdk.channel.botIdentity;
  });

  it("normalizes text and structured resources without duplicate placeholders", async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    await createFeishuAdapter({ appId: "cli_test", appSecret: "secret", onMessage });

    await sdk.handlers.get("message")({
      messageId: "om_1",
      chatId: "oc_1",
      chatType: "group",
      senderId: "ou_1",
      content: "说明\n![image](img_1)\n<file key=\"file_1\" name=\"a.pdf\"/>",
      resources: [
        { type: "image", fileKey: "img_1" },
        { type: "file", fileKey: "file_1", fileName: "a.pdf" },
      ],
    });

    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      platform: "feishu",
      chatId: "oc_1",
      userId: "ou_1",
      sessionKey: "fs_group_oc_1",
      text: "说明",
      senderName: "Lynn",
      isGroup: true,
      attachments: [
        expect.objectContaining({ type: "image", platformRef: "img_1", _messageId: "om_1" }),
        expect.objectContaining({ type: "file", platformRef: "file_1", filename: "a.pdf", _messageId: "om_1" }),
      ],
    }));
  });

  it("routes sending and downloads through Channel", async () => {
    const adapter = await createFeishuAdapter({ appId: "cli_test", appSecret: "secret", onMessage: vi.fn() });

    await adapter.sendReply("oc_1", "hello");
    await adapter.sendMediaBuffer("oc_1", Buffer.from("png"), { mime: "image/png", filename: "a.png" });
    await adapter.downloadImage("img_1");
    await adapter.downloadFile("om_1", "file_1");

    expect(sdk.channel.send).toHaveBeenCalledWith("oc_1", { text: "hello" });
    expect(sdk.channel.send).toHaveBeenCalledWith("oc_1", { image: { source: expect.any(Buffer) } });
    expect(sdk.channel.downloadResource).toHaveBeenCalledWith("img_1", "image");
    expect(sdk.channel.downloadResource).toHaveBeenCalledWith("file_1", "file");
  });

  it("reports connection failures and disconnects the failed channel", async () => {
    sdk.channel.connect.mockRejectedValueOnce(Object.assign(new Error("bad credentials"), { code: "permission_denied" }));
    const onStatus = vi.fn();

    await expect(createFeishuAdapter({ appId: "bad", appSecret: "bad", onMessage: vi.fn(), onStatus })).rejects.toThrow("bad credentials");
    expect(onStatus).toHaveBeenLastCalledWith("error", "bad credentials");
    expect(sdk.channel.disconnect).toHaveBeenCalledOnce();
  });
});

describe("Feishu resource normalization", () => {
  it("keeps non-resource rich content", () => {
    expect(__testing__.stripResourcePlaceholders(
      "**标题**\n正文\n<audio key=\"audio_1\" duration=\"2s\"/>",
      [{ type: "audio", fileKey: "audio_1", durationMs: 2000 }],
    )).toBe("**标题**\n正文");
  });
});
