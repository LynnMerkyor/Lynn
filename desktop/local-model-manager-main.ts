import { EventEmitter } from "node:events";
import type {
  LocalModelIpcAction,
  LocalModelIpcError,
  LocalModelIpcErrorResponse,
  LocalModelIpcEvent,
  LocalModelIpcRequest,
  LocalModelIpcResponse,
  LocalModelIpcStatusEvent,
  LocalModelIpcSuccessResponse,
  LocalModelIpcValidationResult,
  LocalModelProgress,
  LocalModelSafeStatusSnapshot,
} from "../shared/local-model-ipc.js";

export const BACKEND_ACTIONS = Object.freeze([
  "prepare",
  "download",
  "verify",
  "install",
  "start",
  "stop",
  "health",
  "remove",
] as const satisfies readonly LocalModelIpcAction[]);

type AnyRecord = Record<string, any>;
type LocalModelBackendResult = LocalModelSafeStatusSnapshot | { status?: unknown } | unknown;

export type LocalModelBackendContext = {
  emitProgress(progress: unknown): void;
  emitStatus(status: unknown): void;
  emitError(error: unknown, status?: unknown): void;
};

export type LocalModelBackend = {
  [Action in LocalModelIpcAction]: (
    request: Extract<LocalModelIpcRequest, { action: Action }>,
    context: LocalModelBackendContext,
  ) => Promise<LocalModelBackendResult> | LocalModelBackendResult;
};

export type LocalModelIpcContract = {
  validateLocalModelIpcRequest(input: unknown): LocalModelIpcValidationResult;
  sanitizeLocalModelStatusSnapshot(input: unknown): LocalModelSafeStatusSnapshot;
  sanitizeLocalModelError(input: unknown, action?: LocalModelIpcAction): LocalModelIpcError | undefined;
  sanitizeLocalModelProgress(input: unknown, action?: LocalModelIpcAction): LocalModelProgress;
  isLocalModelIpcAction(input: unknown): input is LocalModelIpcAction;
};

export type LocalModelManagerMainOptions = {
  backend: LocalModelBackend;
  contract?: LocalModelIpcContract | null;
  contractLoader?: () => Promise<LocalModelIpcContract>;
};

export type LocalModelManagerEventListener = (event: LocalModelIpcEvent) => void;

const DEFAULT_REQUEST_ID = "invalid-request";
const DEFAULT_ACTION: LocalModelIpcAction = "health";

export async function loadDefaultLocalModelIpcContract(): Promise<LocalModelIpcContract> {
  const candidates = ["../shared/local-model-ipc.js", "../shared/local-model-ipc.ts"];
  let lastError: unknown;
  for (const specifier of candidates) {
    try {
      return await import(specifier) as LocalModelIpcContract;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Unable to load local model IPC contract.");
}

export function createLocalModelManagerMain(options: LocalModelManagerMainOptions): LocalModelManagerMain {
  return new LocalModelManagerMain(options);
}

export class LocalModelManagerMain {
  readonly backend: LocalModelBackend;
  #contract: LocalModelIpcContract | null;
  readonly #contractLoader: () => Promise<LocalModelIpcContract>;
  readonly #events = new EventEmitter();

  constructor(options: LocalModelManagerMainOptions) {
    const backend = options.backend;
    assertBackend(backend);
    this.backend = backend;
    this.#contract = options.contract || null;
    this.#contractLoader = options.contractLoader || loadDefaultLocalModelIpcContract;
  }

  async handleRequest(raw: unknown): Promise<LocalModelIpcResponse> {
    const contract = await this.#loadContract();
    const validation = contract.validateLocalModelIpcRequest(raw);
    if (!validation.ok) {
      const requestId = getRequestId(raw);
      const action = getAction(raw, contract);
      const error = sanitizeError(contract, {
        reason: validation.reason,
        message: validation.message,
      }, action);
      const response: LocalModelIpcErrorResponse = { requestId, action, ok: false, error };
      this.#emit({ type: "error", requestId, action, error });
      return response;
    }

    const request = validation.request;
    const context = this.#createBackendContext(contract, request);

    try {
      const result = await this.backend[request.action](request as never, context);
      const status = sanitizeStatus(contract, statusFromBackendResult(result), request);
      const response: LocalModelIpcSuccessResponse = {
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
      const response: LocalModelIpcErrorResponse = {
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

  subscribe(listener: LocalModelManagerEventListener): () => void {
    if (typeof listener !== "function") {
      throw new TypeError("Local model manager subscription requires a listener function.");
    }
    this.#events.on("event", listener);
    return () => {
      this.#events.off("event", listener);
    };
  }

  async #loadContract(): Promise<LocalModelIpcContract> {
    if (!this.#contract) {
      this.#contract = await this.#contractLoader();
    }
    assertContract(this.#contract);
    return this.#contract;
  }

  #createBackendContext(contract: LocalModelIpcContract, request: LocalModelIpcRequest): LocalModelBackendContext {
    return {
      emitProgress: (progress: unknown) => {
        const progressInput = isRecord(progress) ? { ...progress, action: request.action } : { action: request.action };
        const safeProgress = contract.sanitizeLocalModelProgress(progressInput, request.action);
        this.#emit({
          type: "progress",
          requestId: request.requestId,
          action: request.action,
          progress: safeProgress,
        });
      },
      emitStatus: (status: unknown) => {
        const event: LocalModelIpcStatusEvent = {
          type: "status",
          requestId: request.requestId,
          status: sanitizeStatus(contract, status, request),
        };
        this.#emit(event);
      },
      emitError: (error: unknown, status?: unknown) => {
        const safeError = sanitizeError(contract, error, request.action);
        const event: LocalModelIpcEvent = {
          type: "error",
          requestId: request.requestId,
          action: request.action,
          error: safeError,
          ...(status !== undefined ? { status: sanitizeStatus(contract, status, request) } : {}),
        };
        this.#emit(event);
      },
    };
  }

  #emit(event: LocalModelIpcEvent): void {
    this.#events.emit("event", event);
  }
}

function assertBackend(backend: unknown): asserts backend is LocalModelBackend {
  if (!backend || typeof backend !== "object") {
    throw new TypeError("Local model manager requires an injected backend.");
  }
  const record = backend as AnyRecord;
  const missing = BACKEND_ACTIONS.filter((action) => typeof record[action] !== "function");
  if (missing.length) {
    throw new TypeError(`Local model manager backend is missing handlers: ${missing.join(", ")}`);
  }
}

function assertContract(contract: unknown): asserts contract is LocalModelIpcContract {
  const required = [
    "validateLocalModelIpcRequest",
    "sanitizeLocalModelStatusSnapshot",
    "sanitizeLocalModelError",
    "sanitizeLocalModelProgress",
    "isLocalModelIpcAction",
  ];
  const missing = required.filter((name) => typeof (contract as AnyRecord | null | undefined)?.[name] !== "function");
  if (missing.length) {
    throw new TypeError(`Local model IPC contract is missing exports: ${missing.join(", ")}`);
  }
}

function getRequestId(raw: unknown): string {
  return isRecord(raw) && isNonEmptyString(raw.requestId) ? raw.requestId : DEFAULT_REQUEST_ID;
}

function getAction(raw: unknown, contract: LocalModelIpcContract): LocalModelIpcAction {
  return isRecord(raw) && contract.isLocalModelIpcAction(raw.action) ? raw.action : DEFAULT_ACTION;
}

function statusFromBackendResult(result: unknown): unknown {
  if (isRecord(result) && isRecord(result.status)) return result.status;
  return result;
}

function statusFromBackendError(error: unknown): unknown {
  if (!isRecord(error)) return undefined;
  if (error.status !== undefined) return error.status;
  if (error.statusSnapshot !== undefined) return error.statusSnapshot;
  if (error.snapshot !== undefined) return error.snapshot;
  return undefined;
}

function sanitizeStatus(
  contract: LocalModelIpcContract,
  status: unknown,
  request: LocalModelIpcRequest,
): LocalModelSafeStatusSnapshot {
  const base = isRecord(status) ? status : {};
  return contract.sanitizeLocalModelStatusSnapshot({
    ...base,
    modelId: request.modelId,
    variantId: base.variantId || request.variantId,
    action: request.action,
  });
}

function sanitizeError(
  contract: LocalModelIpcContract,
  error: unknown,
  action: LocalModelIpcAction,
): LocalModelIpcError {
  return contract.sanitizeLocalModelError(error, action) || contract.sanitizeLocalModelError({
    reason: "unknown",
    message: "The local model operation failed.",
  }, action)!;
}

function isRecord(value: unknown): value is AnyRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
