import { describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createLocalModelController } = require("../local-model-controller.cjs");

/* eslint-disable @typescript-eslint/no-explicit-any */

function setup() {
  const handlers: Record<string, any> = {};
  createLocalModelController({
    BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
    shell: {},
    wrapIpcHandler: (name: string, fn: any) => { handlers[name] = fn; },
    lynnHome: "/h",
    canReadPath: () => ({ allowed: true }),
    grantWebContentsAccess: () => {},
    resolveCanonicalPath: (p: string) => p,
    isPathInsideRoot: () => true,
  });
  return { handlers };
}

describe("local-model-controller: channel registration", () => {
  it("registers the llamacpp status + LOCAL_MODEL_IPC channels", () => {
    const { handlers } = setup();
    for (const ch of [
      "llamacpp-status", "llamacpp:state", "llamacpp:stop", "llamacpp:start-download",
      "llamacpp:pause-download", "llamacpp:cancel-download", "llamacpp:sources",
      "llamacpp:open-model-dir", "llamacpp:start-custom-model",
    ]) {
      expect(handlers).toHaveProperty(ch);
    }
  });
});

describe("local-model-controller: start-download payload validation (no VRAM/download for bad input)", () => {
  it("rejects array / non-string modelId / unknown modelId before downloading", async () => {
    const { handlers } = setup();
    const start = handlers["llamacpp:start-download"];
    expect(await start({ sender: {} }, [1, 2, 3])).toMatchObject({ ok: false, reason: "invalid-payload" });
    expect(await start({ sender: {} }, { modelId: 123 })).toMatchObject({ ok: false, reason: "invalid-model-id" });
    expect(await start({ sender: {} }, { modelId: "../etc/passwd" })).toMatchObject({ ok: false, reason: "invalid-model-id" });
    expect(await start({ sender: {} }, { modelId: "totally-unknown-model-xyz" })).toMatchObject({ ok: false, reason: "unknown-model-id" });
  });
});

describe("local-model-controller: start-custom-model path validation", () => {
  it("rejects missing / non-gguf / null-byte paths", async () => {
    const { handlers } = setup();
    const custom = handlers["llamacpp:start-custom-model"];
    expect(await custom({ sender: {} }, "")).toMatchObject({ ok: false, reason: "missing-model-path" });
    expect(await custom({ sender: {} }, "/models/weights.txt")).toMatchObject({ ok: false, reason: "not-gguf" });
    expect(await custom({ sender: {} }, "/models/x\0.gguf")).toMatchObject({ ok: false, reason: "invalid-model-path" });
  });
});
