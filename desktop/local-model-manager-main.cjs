"use strict";

const { EventEmitter } = require("node:events");

const BACKEND_ACTIONS = Object.freeze([
  "prepare",
  "download",
  "verify",
  "install",
  "start",
  "stop",
  "health",
  "remove",
]);

const DEFAULT_REQUEST_ID = "invalid-request";
const DEFAULT_ACTION = "health";

async function loadDefaultLocalModelIpcContract() {
  const candidates = ["../shared/local-model-ipc.js", "../shared/local-model-ipc.ts"];
  let lastError;
  for (const specifier of candidates) {
    try {
      return await import(specifier);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Unable to load local model IPC contract.");
}

function createLocalModelManagerMain(options = {}) {
  return new LocalModelManagerMain(options);
}

class LocalModelManagerMain {
  constructor(options = {}) {
    const backend = options.backend;
    assertBackend(backend);
    this.backend = backend;
    this.contract = options.contract || null;
    this.contractLoader = options.contractLoader || loadDefaultLocalModelIpcContract;
    this.events = new EventEmitter();
  }

  async handleRequest(raw) {
    const contract = await this.#loadContract();
    const validation = contract.validateLocalModelIpcRequest(raw);
    if (!validation.ok) {
      const requestId = getRequestId(raw);
      const action = getAction(raw, contract);
      const error = sanitizeError(contract, {
        reason: validation.reason,
        message: validation.message,
      }, action);
      const response = { requestId, action, ok: false, error };
      this.#emit({ type: "error", requestId, action, error });
      return response;
    }

    const request = validation.request;
    const context = this.#createBackendContext(contract, request);

    try {
      const result = await this.backend[request.action](request, context);
      const status = sanitizeStatus(contract, statusFromBackendResult(result), request);
      const response = {
        requestId: request.requestId,
        action: request.action,
        ok: true,
        status,
      };
      this.#emit({ type: "completed", requestId: request.requestId, response });
      return response;
    } catch (error) {
      const safeError = sanitizeError(contract, error, request.action);
      const status = statusFromBackendError(error);
      const response = {
        requestId: request.requestId,
        action: request.action,
        ok: false,
        error: safeError,
      };
      if (status !== undefined) {
        response.status = sanitizeStatus(contract, status, request);
      }
      this.#emit({
        type: "error",
        requestId: request.requestId,
        action: request.action,
        error: safeError,
        status: response.status,
      });
      return response;
    }
  }

  subscribe(listener) {
    if (typeof listener !== "function") {
      throw new TypeError("Local model manager subscription requires a listener function.");
    }
    this.events.on("event", listener);
    return () => {
      this.events.off("event", listener);
    };
  }

  async #loadContract() {
    if (!this.contract) {
      this.contract = await this.contractLoader();
    }
    assertContract(this.contract);
    return this.contract;
  }

  #createBackendContext(contract, request) {
    return {
      emitProgress: (progress) => {
        const progressInput = isRecord(progress) ? { ...progress, action: request.action } : { action: request.action };
        const safeProgress = contract.sanitizeLocalModelProgress(progressInput, request.action);
        this.#emit({
          type: "progress",
          requestId: request.requestId,
          action: request.action,
          progress: safeProgress,
        });
      },
      emitStatus: (status) => {
        this.#emit({
          type: "status",
          requestId: request.requestId,
          status: sanitizeStatus(contract, status, request),
        });
      },
      emitError: (error, status) => {
        const safeError = sanitizeError(contract, error, request.action);
        const event = {
          type: "error",
          requestId: request.requestId,
          action: request.action,
          error: safeError,
        };
        if (status !== undefined) {
          event.status = sanitizeStatus(contract, status, request);
        }
        this.#emit(event);
      },
    };
  }

  #emit(event) {
    this.events.emit("event", event);
  }
}

function assertBackend(backend) {
  if (!backend || typeof backend !== "object") {
    throw new TypeError("Local model manager requires an injected backend.");
  }
  const missing = BACKEND_ACTIONS.filter((action) => typeof backend[action] !== "function");
  if (missing.length) {
    throw new TypeError(`Local model manager backend is missing handlers: ${missing.join(", ")}`);
  }
}

function assertContract(contract) {
  const required = [
    "validateLocalModelIpcRequest",
    "sanitizeLocalModelStatusSnapshot",
    "sanitizeLocalModelError",
    "sanitizeLocalModelProgress",
    "isLocalModelIpcAction",
  ];
  const missing = required.filter((name) => typeof contract?.[name] !== "function");
  if (missing.length) {
    throw new TypeError(`Local model IPC contract is missing exports: ${missing.join(", ")}`);
  }
}

function getRequestId(raw) {
  return isRecord(raw) && isNonEmptyString(raw.requestId) ? raw.requestId : DEFAULT_REQUEST_ID;
}

function getAction(raw, contract) {
  return isRecord(raw) && contract.isLocalModelIpcAction(raw.action) ? raw.action : DEFAULT_ACTION;
}

function statusFromBackendResult(result) {
  if (isRecord(result) && isRecord(result.status)) return result.status;
  return result;
}

function statusFromBackendError(error) {
  if (!isRecord(error)) return undefined;
  if (error.status !== undefined) return error.status;
  if (error.statusSnapshot !== undefined) return error.statusSnapshot;
  if (error.snapshot !== undefined) return error.snapshot;
  return undefined;
}

function sanitizeStatus(contract, status, request) {
  const base = isRecord(status) ? status : {};
  return contract.sanitizeLocalModelStatusSnapshot({
    ...base,
    modelId: request.modelId,
    variantId: base.variantId || request.variantId,
    action: request.action,
  });
}

function sanitizeError(contract, error, action) {
  return contract.sanitizeLocalModelError(error, action) || contract.sanitizeLocalModelError({
    reason: "unknown",
    message: "The local model operation failed.",
  }, action);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

module.exports = {
  BACKEND_ACTIONS,
  LocalModelManagerMain,
  createLocalModelManagerMain,
  loadDefaultLocalModelIpcContract,
};
