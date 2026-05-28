import { describe, expect, it, vi } from "vitest";
import * as localModelIpcContract from "../shared/local-model-ipc.js";
import { LocalModelIpcErrorReason } from "../shared/local-model-ipc.js";

const {
  BACKEND_ACTIONS,
  createLocalModelManagerMain,
} = await import("../desktop/local-model-manager-main.ts");

function makeBackend(overrides = {}) {
  const backend = {};
  for (const action of BACKEND_ACTIONS) {
    backend[action] = vi.fn(async (request) => ({
      modelId: request.modelId,
      variantId: request.variantId,
      action: request.action,
      stage: "stopped",
      updatedAt: 1,
    }));
  }
  return { ...backend, ...overrides };
}

function makeManager(backend) {
  return createLocalModelManagerMain({
    backend,
    contract: localModelIpcContract,
  });
}

describe("LocalModelManagerMain", () => {
  it("returns a sanitized validation error before backend dispatch", async () => {
    const backend = makeBackend();
    const manager = makeManager(backend);
    const events = [];
    manager.subscribe((event) => events.push(event));

    const response = await manager.handleRequest({
      action: "download",
      modelId: "qwen35-9b-q4km-imatrix",
    });

    expect(response).toEqual({
      requestId: "invalid-request",
      action: "download",
      ok: false,
      error: {
        reason: LocalModelIpcErrorReason.INVALID_MODEL,
        message: "Local model IPC request is missing requestId.",
        recoverable: false,
        action: "download",
      },
    });
    expect(backend.download).not.toHaveBeenCalled();
    expect(events).toEqual([{
      type: "error",
      requestId: "invalid-request",
      action: "download",
      error: response.error,
    }]);
  });

  it("dispatches validated requests to the injected backend and sanitizes status", async () => {
    const backend = makeBackend({
      download: vi.fn(async () => ({
        status: {
          modelId: "backend-overwrite",
          action: "remove",
          stage: "running",
          modelPath: "/Users/lynn/.lynn/models/private.gguf",
          apiKey: "sk-secret",
          endpoint: {
            url: "http://user:pass@127.0.0.1:18099/v1?apiKey=secret#debug",
          },
        },
      })),
    });
    const manager = makeManager(backend);

    const response = await manager.handleRequest({
      requestId: "req-download",
      action: "download",
      modelId: "qwen35-9b-q4km-imatrix",
      variantId: "q4km",
      resume: true,
    });

    expect(backend.download).toHaveBeenCalledTimes(1);
    expect(backend.download.mock.calls[0][0]).toMatchObject({
      requestId: "req-download",
      action: "download",
      modelId: "qwen35-9b-q4km-imatrix",
      variantId: "q4km",
      resume: true,
    });
    expect(response).toEqual({
      requestId: "req-download",
      action: "download",
      ok: true,
      status: {
        modelId: "qwen35-9b-q4km-imatrix",
        variantId: "q4km",
        stage: "running",
        action: "download",
        endpoint: {
          origin: "loopback",
          url: "http://127.0.0.1:18099/v1",
        },
      },
    });
    expect("modelPath" in response.status).toBe(false);
    expect("apiKey" in response.status).toBe(false);
  });

  it("sanitizes backend exceptions and optional failure status", async () => {
    const backendError = new Error("EACCES /Users/lynn/.lynn/models/private.gguf token=secret");
    backendError.status = {
      modelId: "qwen35-9b-q4km-imatrix",
      stage: "failed",
      modelPath: "/Users/lynn/.lynn/models/private.gguf",
      lastError: backendError,
    };

    const backend = makeBackend({
      start: vi.fn(async () => {
        throw backendError;
      }),
    });
    const manager = makeManager(backend);

    const response = await manager.handleRequest({
      requestId: "req-start",
      action: "start",
      modelId: "qwen35-9b-q4km-imatrix",
    });

    expect(response.ok).toBe(false);
    expect(response.error).toEqual({
      reason: LocalModelIpcErrorReason.PERMISSION_DENIED,
      message: "EACCES [local path] token=[redacted]",
      recoverable: true,
      action: "start",
    });
    expect(response.status).toEqual({
      modelId: "qwen35-9b-q4km-imatrix",
      stage: "failed",
      action: "start",
      lastError: response.error,
    });
    expect(JSON.stringify(response)).not.toContain("/Users/lynn");
    expect(JSON.stringify(response)).not.toContain("secret");
  });

  it("emits sanitized progress, status, and completion events", async () => {
    const backend = makeBackend({
      download: vi.fn(async (_request, context) => {
        context.emitProgress({
          action: "remove",
          phase: "downloading",
          percent: 180,
          totalBytes: 10,
          token: "secret",
        });
        context.emitStatus({
          stage: "running",
          modelPath: "/Users/lynn/.lynn/models/private.gguf",
          endpoint: {
            url: "http://localhost:18099/v1?token=secret",
          },
        });
        return {
          stage: "running",
          endpoint: {
            url: "http://localhost:18099/v1?token=secret",
          },
        };
      }),
    });
    const manager = makeManager(backend);
    const events = [];
    const unsubscribe = manager.subscribe((event) => events.push(event));

    const response = await manager.handleRequest({
      requestId: "req-progress",
      action: "download",
      modelId: "qwen35-9b-q4km-imatrix",
    });
    unsubscribe();
    await manager.handleRequest({
      requestId: "req-after-unsubscribe",
      action: "health",
      modelId: "qwen35-9b-q4km-imatrix",
    });

    expect(response.ok).toBe(true);
    expect(events).toEqual([
      {
        type: "progress",
        requestId: "req-progress",
        action: "download",
        progress: {
          action: "download",
          phase: "downloading",
          percent: 100,
          totalBytes: 10,
        },
      },
      {
        type: "status",
        requestId: "req-progress",
        status: {
          modelId: "qwen35-9b-q4km-imatrix",
          stage: "running",
          action: "download",
          endpoint: {
            origin: "loopback",
            url: "http://localhost:18099/v1",
          },
        },
      },
      {
        type: "completed",
        requestId: "req-progress",
        response,
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("/Users/lynn");
    expect(JSON.stringify(events)).not.toContain("secret");
  });
});
