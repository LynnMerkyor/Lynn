import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

vi.mock("../lib/debug-log.js", () => ({ debugLog: () => null }));
vi.mock("../lib/bridge/feishu-adapter.js", () => ({ testFeishuConnection: vi.fn() }));

import { createBridgeRoute } from "../server/routes/bridge.js";

describe("bridge session routes", () => {
  let tmpDir;
  let bridgeDir;
  let index;
  let app;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-bridge-route-"));
    bridgeDir = path.join(tmpDir, "sessions", "bridge");
    fs.mkdirSync(bridgeDir, { recursive: true });
    index = {
      fs_dm_contact: {
        userId: "contact",
        name: "Feishu contact",
        avatarUrl: "https://example.invalid/avatar.png",
      },
    };
    const engine = {
      lynnHome: tmpDir,
      agent: { sessionDir: path.join(tmpDir, "sessions") },
      getPreferences: () => ({ bridge: { feishu: { enabled: true }, owner: {} } }),
      savePreferences: vi.fn(),
      getBridgeIndex: () => index,
      saveBridgeIndex: vi.fn((next) => { index = next; }),
    };
    const manager = {
      getStatus: () => ({ feishu: { status: "connected" } }),
      getMessages: () => [],
      startPlatformFromConfig: vi.fn(),
      stopPlatform: vi.fn(),
      sendMediaFile: vi.fn(),
    };
    app = new Hono();
    app.route("/api", createBridgeRoute(engine, manager));
  });

  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("keeps a contact visible after its conversation context was cleared", async () => {
    const listRes = await app.request("/api/bridge/sessions?platform=feishu");
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    expect(list.sessions).toEqual([
      expect.objectContaining({
        sessionKey: "fs_dm_contact",
        displayName: "Feishu contact",
        file: null,
        hasHistory: false,
      }),
    ]);

    const messagesRes = await app.request("/api/bridge/sessions/fs_dm_contact/messages");
    expect(messagesRes.status).toBe(200);
    await expect(messagesRes.json()).resolves.toEqual({ messages: [], contextCleared: true });
  });

  it("clears history without deleting the contact from the session list", async () => {
    const file = "feishu-contact.jsonl";
    fs.writeFileSync(path.join(bridgeDir, file), '{"type":"message","message":{"role":"user","content":"hello"}}\n');
    index.fs_dm_contact.file = file;

    const resetRes = await app.request("/api/bridge/sessions/fs_dm_contact/reset", { method: "POST" });
    expect(resetRes.status).toBe(200);
    await expect(resetRes.json()).resolves.toEqual({ ok: true, contextCleared: true });
    expect(index.fs_dm_contact).toEqual(expect.objectContaining({ name: "Feishu contact" }));
    expect(index.fs_dm_contact.file).toBeUndefined();

    const listRes = await app.request("/api/bridge/sessions?platform=feishu");
    const list = await listRes.json();
    expect(list.sessions).toHaveLength(1);
    expect(list.sessions[0]).toEqual(expect.objectContaining({ sessionKey: "fs_dm_contact", hasHistory: false }));
  });
});
