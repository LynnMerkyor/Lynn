import { describe, expect, it } from "vitest";

import { managerStartResult } from "../desktop/local-model-controller.cjs";

describe("local model custom-start IPC result", () => {
  it("reports a ready endpoint as successful", () => {
    expect(managerStartResult(
      { status: "ready", port: 18099 },
      { modelId: "local-test", modelPath: "C:\\models\\test.gguf" },
    )).toEqual({
      ok: true,
      status: "ready",
      port: 18099,
      modelId: "local-test",
      modelPath: "C:\\models\\test.gguf",
    });
  });

  it("does not claim success when llama-server is missing", () => {
    const result = managerStartResult({
      status: "needs-binary",
      expectedPath: "C:\\Users\\test\\.lynn\\llamacpp\\bin\\llama-server.exe",
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("llamacpp-binary-not-found");
    expect(result.detail).toContain("llama-server was not found in PATH");
  });

  it("does not claim the selected GGUF started when another endpoint owns the port", () => {
    expect(managerStartResult({
      status: "standby",
      reason: "external-instance",
      port: 18099,
    })).toMatchObject({
      ok: false,
      reason: "llamacpp-port-in-use",
      status: "standby",
    });
  });

  it("returns the child output when startup fails", () => {
    const result = managerStartResult({
      status: "failed",
      reason: "startup-timeout",
      error: "failed to load model shard",
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "startup-timeout",
      detail: "failed to load model shard",
      status: "failed",
    });
  });
});
