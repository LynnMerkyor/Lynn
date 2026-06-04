import { describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createFileIpcController } = require("../file-ipc.cjs");

/* eslint-disable @typescript-eslint/no-explicit-any */

function setup() {
  const handlers: Record<string, any> = {};
  const onHandlers: Record<string, any> = {};
  createFileIpcController({
    app: { getPath: () => "/tmp" },
    BrowserWindow: { fromWebContents: () => null, getFocusedWindow: () => null, getAllWindows: () => [] },
    dialog: {}, shell: {}, nativeImage: {},
    wrapIpcHandler: (name: string, fn: any) => { handlers[name] = fn; },
    wrapIpcOn: (name: string, fn: any) => { onHandlers[name] = fn; },
    ipcMain: { on: () => {}, handle: () => {} },
    mt: (k: string, _v: unknown, fb: string) => fb || k,
    lynnHome: "/h",
    getMainWindow: () => null, getCurrentAgentId: () => null,
    canReadPath: () => ({ allowed: true }), canWritePath: () => ({ allowed: true }),
    grantWebContentsAccess: () => {}, resolveCanonicalPath: (p: string) => p,
    logger: { log() {}, warn() {}, error() {} },
  });
  return { handlers, all: { ...handlers, ...onHandlers } };
}

describe("file-ipc: channel registration completeness", () => {
  it("registers all 29 file IPC channels (guards against silent drops in refactors)", () => {
    const { all } = setup();
    expect(Object.keys(all)).toHaveLength(29);
  });

  it("registers the security-critical file channels", () => {
    const { all } = setup();
    for (const ch of ["read-file", "write-file", "grant-file-access", "avatar:upload", "select-gguf-model", "confirm-action", "open-external", "save-file-dialog"]) {
      expect(all).toHaveProperty(ch);
    }
  });
});

describe("file-ipc: avatar:upload role guard", () => {
  it("rejects roles other than agent/user before touching the filesystem", async () => {
    const { handlers } = setup();
    expect(await handlers["avatar:upload"]({ sender: {} }, "hacker")).toEqual({ ok: false, reason: "bad-role" });
  });
});
