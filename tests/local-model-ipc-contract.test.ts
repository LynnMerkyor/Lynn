import { describe, expect, it } from "vitest";
import {
  LOCAL_MODEL_IPC_ACTIONS,
  LocalModelIpcErrorReason,
  isLocalModelIpcAction,
  mapLocalModelIpcErrorReason,
  sanitizeLocalModelError,
  sanitizeLocalModelProgress,
  sanitizeLocalModelStatusSnapshot,
  validateLocalModelIpcRequest,
} from "../shared/local-model-ipc.js";

describe("local model IPC contract", () => {
  it("keeps the action union explicit", () => {
    expect(LOCAL_MODEL_IPC_ACTIONS).toEqual([
      "prepare",
      "download",
      "verify",
      "install",
      "start",
      "stop",
      "health",
      "remove",
    ]);
    for (const action of LOCAL_MODEL_IPC_ACTIONS) {
      expect(isLocalModelIpcAction(action)).toBe(true);
      expect(validateLocalModelIpcRequest({
        requestId: `req-${action}`,
        action,
        modelId: "qwen35-9b-q4km-imatrix",
      })).toMatchObject({ ok: true });
    }
    expect(isLocalModelIpcAction("restart")).toBe(false);
    expect(validateLocalModelIpcRequest({
      requestId: "req-bad",
      action: "restart",
      modelId: "qwen35-9b-q4km-imatrix",
    })).toEqual({
      ok: false,
      reason: LocalModelIpcErrorReason.UNSUPPORTED_MODEL,
      message: "Unknown local model IPC action.",
    });
  });

  it("clamps progress to a safe UI shape", () => {
    expect(sanitizeLocalModelProgress({
      action: "download",
      phase: "downloading",
      percent: 133.7,
      transferredBytes: 25,
      totalBytes: 10,
      rateBytesPerSecond: -1,
      etaMs: Number.POSITIVE_INFINITY,
      messageKey: "localModel.download",
    })).toEqual({
      action: "download",
      phase: "downloading",
      percent: 100,
      transferredBytes: 25,
      totalBytes: 10,
      messageKey: "localModel.download",
    });

    expect(sanitizeLocalModelProgress({
      action: "download",
      phase: "nope",
      percent: -4,
    }, "verify")).toEqual({
      action: "download",
      phase: "queued",
      percent: 0,
    });
  });

  it("strips secrets and raw paths from renderer-facing status snapshots", () => {
    const snapshot = sanitizeLocalModelStatusSnapshot({
      modelId: "qwen35-9b-q4km-imatrix",
      variantId: "q4km",
      displayName: "Qwen3.5-9B Q4_K_M",
      stage: "running",
      action: "start",
      installed: true,
      verified: true,
      running: true,
      source: "mirror",
      sizeBytes: 5_380_000_000,
      contextTokens: 32768,
      memoryRecommendedGb: 24,
      modelPath: "/Users/lynn/.lynn/models/Qwen3.5-9B.gguf",
      downloadUrl: "https://example.invalid/model.gguf?token=secret",
      apiKey: "sk-secret",
      token: "tp-secret",
      env: { HF_TOKEN: "secret" },
      endpoint: {
        url: "http://user:pass@127.0.0.1:18099/v1?apiKey=secret#debug",
      },
      progress: {
        action: "start",
        phase: "starting",
        percent: 45,
      },
      lastError: {
        code: "EACCES",
        message: "permission denied /Users/lynn/.lynn/models/private.gguf token=secret",
      },
    });

    expect(snapshot).toEqual({
      modelId: "qwen35-9b-q4km-imatrix",
      variantId: "q4km",
      displayName: "Qwen3.5-9B Q4_K_M",
      stage: "running",
      action: "start",
      installed: true,
      verified: true,
      running: true,
      source: "mirror",
      progress: {
        action: "start",
        phase: "starting",
        percent: 45,
      },
      endpoint: {
        origin: "loopback",
        url: "http://127.0.0.1:18099/v1",
      },
      sizeBytes: 5_380_000_000,
      contextTokens: 32768,
      memoryRecommendedGb: 24,
      lastError: {
        reason: LocalModelIpcErrorReason.PERMISSION_DENIED,
        message: "permission denied [local path] token=[redacted]",
        recoverable: true,
        action: "start",
      },
    });
    expect("modelPath" in snapshot).toBe(false);
    expect("downloadUrl" in snapshot).toBe(false);
    expect("apiKey" in snapshot).toBe(false);
    expect("token" in snapshot).toBe(false);
    expect("env" in snapshot).toBe(false);
  });

  it("does not expose non-loopback endpoints", () => {
    expect(sanitizeLocalModelStatusSnapshot({
      modelId: "qwen35-9b-q4km-imatrix",
      stage: "running",
      endpoint: { url: "https://download.example.invalid/v1?token=secret" },
    })).toEqual({
      modelId: "qwen35-9b-q4km-imatrix",
      stage: "running",
    });
  });

  it("maps unsafe implementation errors to user-safe reasons", () => {
    expect(mapLocalModelIpcErrorReason({ code: "ENOSPC" })).toBe(LocalModelIpcErrorReason.DISK_SPACE);
    expect(mapLocalModelIpcErrorReason({ code: "EADDRINUSE" })).toBe(LocalModelIpcErrorReason.PORT_IN_USE);
    expect(mapLocalModelIpcErrorReason({ message: "SHA256 checksum mismatch" })).toBe(LocalModelIpcErrorReason.CHECKSUM_MISMATCH);
    expect(mapLocalModelIpcErrorReason({ message: "DNS rebinding private IP blocked" })).toBe(LocalModelIpcErrorReason.SECURITY_BLOCKED);
    expect(mapLocalModelIpcErrorReason({ message: "llama.cpp binary missing" })).toBe(LocalModelIpcErrorReason.LLAMACPP_MISSING);

    expect(sanitizeLocalModelError({
      code: "ENOTFOUND",
      message: "fetch failed for /Users/lynn/.cache/model.gguf apiKey=secret",
    }, "download")).toEqual({
      reason: LocalModelIpcErrorReason.NETWORK_UNAVAILABLE,
      message: "fetch failed for [local path] apiKey=[redacted]",
      recoverable: true,
      action: "download",
    });
  });
});
