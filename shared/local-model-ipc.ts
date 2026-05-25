export const LOCAL_MODEL_IPC_ACTIONS = Object.freeze([
  "prepare",
  "download",
  "verify",
  "install",
  "start",
  "stop",
  "health",
  "remove",
] as const);

export type LocalModelIpcAction = (typeof LOCAL_MODEL_IPC_ACTIONS)[number];

export const LOCAL_MODEL_IPC_EVENT_TYPES = Object.freeze([
  "progress",
  "status",
  "completed",
  "error",
] as const);

export type LocalModelIpcEventType = (typeof LOCAL_MODEL_IPC_EVENT_TYPES)[number];

export enum LocalModelIpcErrorReason {
  UNKNOWN = "unknown",
  CANCELLED = "cancelled",
  TIMEOUT = "timeout",
  NETWORK_UNAVAILABLE = "network_unavailable",
  DOWNLOAD_FAILED = "download_failed",
  DISK_SPACE = "disk_space",
  PERMISSION_DENIED = "permission_denied",
  CHECKSUM_MISMATCH = "checksum_mismatch",
  MODEL_NOT_FOUND = "model_not_found",
  INVALID_MODEL = "invalid_model",
  UNSUPPORTED_MODEL = "unsupported_model",
  LLAMACPP_MISSING = "llamacpp_missing",
  PORT_IN_USE = "port_in_use",
  HEALTH_CHECK_FAILED = "health_check_failed",
  SECURITY_BLOCKED = "security_blocked",
}

export const LOCAL_MODEL_SAFE_STAGES = Object.freeze([
  "idle",
  "preparing",
  "downloading",
  "verifying",
  "installing",
  "starting",
  "running",
  "stopping",
  "stopped",
  "removing",
  "removed",
  "failed",
  "unavailable",
] as const);

export type LocalModelSafeStage = (typeof LOCAL_MODEL_SAFE_STAGES)[number];

export const LOCAL_MODEL_PROGRESS_PHASES = Object.freeze([
  "queued",
  "resolving",
  "downloading",
  "verifying",
  "installing",
  "starting",
  "stopping",
  "removing",
  "done",
  "failed",
] as const);

export type LocalModelProgressPhase = (typeof LOCAL_MODEL_PROGRESS_PHASES)[number];

export type LocalModelSource = "official" | "mirror" | "bundled" | "manual";

export type LocalModelIpcRequestBase<TAction extends LocalModelIpcAction> = {
  requestId: string;
  action: TAction;
  modelId: string;
  variantId?: string;
};

export type LocalModelPrepareRequest = LocalModelIpcRequestBase<"prepare"> & {
  source?: LocalModelSource;
  force?: boolean;
};

export type LocalModelDownloadRequest = LocalModelIpcRequestBase<"download"> & {
  source?: LocalModelSource;
  resume?: boolean;
  expectedSizeBytes?: number;
};

export type LocalModelVerifyRequest = LocalModelIpcRequestBase<"verify"> & {
  checksum?: string;
};

export type LocalModelInstallRequest = LocalModelIpcRequestBase<"install"> & {
  replaceExisting?: boolean;
};

export type LocalModelStartRequest = LocalModelIpcRequestBase<"start"> & {
  contextTokens?: number;
  gpuLayers?: number;
  localOnly?: boolean;
};

export type LocalModelStopRequest = LocalModelIpcRequestBase<"stop"> & {
  force?: boolean;
};

export type LocalModelHealthRequest = LocalModelIpcRequestBase<"health"> & {
  includeProcess?: boolean;
};

export type LocalModelRemoveRequest = LocalModelIpcRequestBase<"remove"> & {
  keepPreferences?: boolean;
};

export type LocalModelIpcRequest =
  | LocalModelPrepareRequest
  | LocalModelDownloadRequest
  | LocalModelVerifyRequest
  | LocalModelInstallRequest
  | LocalModelStartRequest
  | LocalModelStopRequest
  | LocalModelHealthRequest
  | LocalModelRemoveRequest;

export type LocalModelProgress = {
  action: LocalModelIpcAction;
  phase: LocalModelProgressPhase;
  percent: number;
  transferredBytes?: number;
  totalBytes?: number;
  rateBytesPerSecond?: number;
  etaMs?: number;
  messageKey?: string;
  updatedAt?: number;
};

export type LocalModelIpcError = {
  reason: LocalModelIpcErrorReason;
  message: string;
  recoverable: boolean;
  action?: LocalModelIpcAction;
};

export type LocalModelSafeEndpoint = {
  origin: "loopback";
  url: string;
};

export type LocalModelSafeStatusSnapshot = {
  modelId: string;
  variantId?: string;
  displayName?: string;
  stage: LocalModelSafeStage;
  action?: LocalModelIpcAction;
  installed?: boolean;
  verified?: boolean;
  running?: boolean;
  source?: LocalModelSource;
  progress?: LocalModelProgress;
  endpoint?: LocalModelSafeEndpoint;
  sizeBytes?: number;
  contextTokens?: number;
  memoryRecommendedGb?: number;
  lastError?: LocalModelIpcError;
  updatedAt?: number;
};

export type LocalModelIpcSuccessResponse = {
  requestId: string;
  action: LocalModelIpcAction;
  ok: true;
  status: LocalModelSafeStatusSnapshot;
};

export type LocalModelIpcErrorResponse = {
  requestId: string;
  action: LocalModelIpcAction;
  ok: false;
  error: LocalModelIpcError;
  status?: LocalModelSafeStatusSnapshot;
};

export type LocalModelIpcResponse = LocalModelIpcSuccessResponse | LocalModelIpcErrorResponse;

export type LocalModelIpcProgressEvent = {
  type: "progress";
  requestId: string;
  action: LocalModelIpcAction;
  progress: LocalModelProgress;
};

export type LocalModelIpcStatusEvent = {
  type: "status";
  requestId?: string;
  status: LocalModelSafeStatusSnapshot;
};

export type LocalModelIpcCompletedEvent = {
  type: "completed";
  requestId: string;
  response: LocalModelIpcSuccessResponse;
};

export type LocalModelIpcErrorEvent = {
  type: "error";
  requestId?: string;
  action?: LocalModelIpcAction;
  error: LocalModelIpcError;
  status?: LocalModelSafeStatusSnapshot;
};

export type LocalModelIpcEvent =
  | LocalModelIpcProgressEvent
  | LocalModelIpcStatusEvent
  | LocalModelIpcCompletedEvent
  | LocalModelIpcErrorEvent;

export type LocalModelIpcValidationResult =
  | { ok: true; request: LocalModelIpcRequest }
  | { ok: false; reason: LocalModelIpcErrorReason; message: string };

const actionSet: ReadonlySet<string> = new Set(LOCAL_MODEL_IPC_ACTIONS);
const stageSet: ReadonlySet<string> = new Set(LOCAL_MODEL_SAFE_STAGES);
const phaseSet: ReadonlySet<string> = new Set(LOCAL_MODEL_PROGRESS_PHASES);
const sourceSet: ReadonlySet<string> = new Set(["official", "mirror", "bundled", "manual"]);

export function isLocalModelIpcAction(value: unknown): value is LocalModelIpcAction {
  return typeof value === "string" && actionSet.has(value);
}

export function isLocalModelSafeStage(value: unknown): value is LocalModelSafeStage {
  return typeof value === "string" && stageSet.has(value);
}

export function isLocalModelProgressPhase(value: unknown): value is LocalModelProgressPhase {
  return typeof value === "string" && phaseSet.has(value);
}

export function isLocalModelSource(value: unknown): value is LocalModelSource {
  return typeof value === "string" && sourceSet.has(value);
}

export function validateLocalModelIpcRequest(input: unknown): LocalModelIpcValidationResult {
  if (!isPlainRecord(input)) {
    return {
      ok: false,
      reason: LocalModelIpcErrorReason.INVALID_MODEL,
      message: "Local model IPC request must be an object.",
    };
  }
  if (!isNonEmptyString(input.requestId)) {
    return {
      ok: false,
      reason: LocalModelIpcErrorReason.INVALID_MODEL,
      message: "Local model IPC request is missing requestId.",
    };
  }
  if (!isLocalModelIpcAction(input.action)) {
    return {
      ok: false,
      reason: LocalModelIpcErrorReason.UNSUPPORTED_MODEL,
      message: "Unknown local model IPC action.",
    };
  }
  if (!isNonEmptyString(input.modelId)) {
    return {
      ok: false,
      reason: LocalModelIpcErrorReason.INVALID_MODEL,
      message: "Local model IPC request is missing modelId.",
    };
  }
  return { ok: true, request: input as LocalModelIpcRequest };
}

export function sanitizeLocalModelProgress(input: unknown, action: LocalModelIpcAction = "health"): LocalModelProgress {
  const record = isPlainRecord(input) ? input : {};
  const progressAction = isLocalModelIpcAction(record.action) ? record.action : action;
  const phase = isLocalModelProgressPhase(record.phase) ? record.phase : "queued";
  const percent = clampPercent(record.percent);
  const progress: LocalModelProgress = {
    action: progressAction,
    phase,
    percent,
  };
  copyNonNegativeNumber(record, progress, "transferredBytes");
  copyNonNegativeNumber(record, progress, "totalBytes");
  copyNonNegativeNumber(record, progress, "rateBytesPerSecond");
  copyNonNegativeNumber(record, progress, "etaMs");
  copyNonEmptyString(record, progress, "messageKey");
  copyNonNegativeNumber(record, progress, "updatedAt");
  return progress;
}

export function sanitizeLocalModelStatusSnapshot(input: unknown): LocalModelSafeStatusSnapshot {
  const record = isPlainRecord(input) ? input : {};
  const action = isLocalModelIpcAction(record.action) ? record.action : undefined;
  const snapshot: LocalModelSafeStatusSnapshot = {
    modelId: isNonEmptyString(record.modelId) ? record.modelId : "unknown",
    stage: isLocalModelSafeStage(record.stage) ? record.stage : "unavailable",
  };

  copyNonEmptyString(record, snapshot, "variantId");
  copyNonEmptyString(record, snapshot, "displayName");
  if (action) snapshot.action = action;
  copyBoolean(record, snapshot, "installed");
  copyBoolean(record, snapshot, "verified");
  copyBoolean(record, snapshot, "running");
  if (isLocalModelSource(record.source)) snapshot.source = record.source;
  if (record.progress !== undefined) snapshot.progress = sanitizeLocalModelProgress(record.progress, action || "health");
  const endpoint = sanitizeLoopbackEndpoint(record.endpoint);
  if (endpoint) snapshot.endpoint = endpoint;
  copyNonNegativeNumber(record, snapshot, "sizeBytes");
  copyNonNegativeNumber(record, snapshot, "contextTokens");
  copyNonNegativeNumber(record, snapshot, "memoryRecommendedGb");
  const lastError = sanitizeLocalModelError(record.lastError, action);
  if (lastError) snapshot.lastError = lastError;
  copyNonNegativeNumber(record, snapshot, "updatedAt");
  return snapshot;
}

export function sanitizeLocalModelError(
  input: unknown,
  action?: LocalModelIpcAction,
): LocalModelIpcError | undefined {
  if (input === undefined || input === null) return undefined;
  const reason = mapLocalModelIpcErrorReason(input);
  const message = isPlainRecord(input) && isNonEmptyString(input.message)
    ? safeErrorMessage(input.message)
    : defaultErrorMessage(reason);
  return {
    reason,
    message,
    recoverable: isRecoverableLocalModelError(reason),
    action,
  };
}

export function mapLocalModelIpcErrorReason(input: unknown): LocalModelIpcErrorReason {
  const text = stringifyErrorLike(input).toLowerCase();
  if (!text) return LocalModelIpcErrorReason.UNKNOWN;
  if (hasAny(text, ["cancel", "aborted", "aborterror"])) return LocalModelIpcErrorReason.CANCELLED;
  if (hasAny(text, ["timeout", "etimedout"])) return LocalModelIpcErrorReason.TIMEOUT;
  if (hasAny(text, ["enospc", "no space", "disk full"])) return LocalModelIpcErrorReason.DISK_SPACE;
  if (hasAny(text, ["eacces", "eperm", "permission"])) return LocalModelIpcErrorReason.PERMISSION_DENIED;
  if (hasAny(text, ["checksum", "sha256", "hash mismatch", "integrity"])) return LocalModelIpcErrorReason.CHECKSUM_MISMATCH;
  if (hasAny(text, ["eaddrinuse", "port in use", "address already in use"])) return LocalModelIpcErrorReason.PORT_IN_USE;
  if (hasAny(text, ["llama.cpp", "llama-server", "llama binary"])) return LocalModelIpcErrorReason.LLAMACPP_MISSING;
  if (hasAny(text, ["security", "unsafe", "private ip", "dns rebinding", "path traversal"])) return LocalModelIpcErrorReason.SECURITY_BLOCKED;
  if (hasAny(text, ["unsupported model", "unsupported quant", "unsupported"])) return LocalModelIpcErrorReason.UNSUPPORTED_MODEL;
  if (hasAny(text, ["enoent", "not found", "missing model"])) return LocalModelIpcErrorReason.MODEL_NOT_FOUND;
  if (hasAny(text, ["network", "enotfound", "eai_again", "econnreset", "econnrefused"])) {
    return LocalModelIpcErrorReason.NETWORK_UNAVAILABLE;
  }
  if (hasAny(text, ["health check", "unhealthy"])) return LocalModelIpcErrorReason.HEALTH_CHECK_FAILED;
  if (hasAny(text, ["download"])) return LocalModelIpcErrorReason.DOWNLOAD_FAILED;
  return LocalModelIpcErrorReason.UNKNOWN;
}

export function isRecoverableLocalModelError(reason: LocalModelIpcErrorReason): boolean {
  return ![
    LocalModelIpcErrorReason.CHECKSUM_MISMATCH,
    LocalModelIpcErrorReason.INVALID_MODEL,
    LocalModelIpcErrorReason.SECURITY_BLOCKED,
    LocalModelIpcErrorReason.UNSUPPORTED_MODEL,
  ].includes(reason);
}

function clampPercent(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.min(100, Math.max(0, numeric));
}

function sanitizeLoopbackEndpoint(input: unknown): LocalModelSafeEndpoint | undefined {
  if (!isPlainRecord(input) || !isNonEmptyString(input.url)) return undefined;
  try {
    const url = new URL(input.url);
    const hostname = url.hostname.toLowerCase();
    if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname)) return undefined;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return { origin: "loopback", url: url.toString() };
  } catch {
    return undefined;
  }
}

function safeErrorMessage(message: string): string {
  const redacted = message
    .replace(/[A-Za-z]:\\[^\s"'<>]+/g, "[local path]")
    .replace(/\/(?:Users|home|var|private|Volumes)\/[^\s"'<>]+/g, "[local path]")
    .replace(/(api[_-]?key|token|secret|authorization)=?[:\s]*[^\s"'<>]+/gi, "$1=[redacted]");
  return redacted.slice(0, 240);
}

function defaultErrorMessage(reason: LocalModelIpcErrorReason): string {
  switch (reason) {
    case LocalModelIpcErrorReason.CANCELLED:
      return "The local model operation was cancelled.";
    case LocalModelIpcErrorReason.TIMEOUT:
      return "The local model operation timed out.";
    case LocalModelIpcErrorReason.NETWORK_UNAVAILABLE:
      return "Network access is unavailable.";
    case LocalModelIpcErrorReason.DOWNLOAD_FAILED:
      return "The local model download failed.";
    case LocalModelIpcErrorReason.DISK_SPACE:
      return "Not enough disk space is available.";
    case LocalModelIpcErrorReason.PERMISSION_DENIED:
      return "Lynn does not have permission to complete this local model operation.";
    case LocalModelIpcErrorReason.CHECKSUM_MISMATCH:
      return "The local model file did not pass verification.";
    case LocalModelIpcErrorReason.MODEL_NOT_FOUND:
      return "The requested local model was not found.";
    case LocalModelIpcErrorReason.INVALID_MODEL:
      return "The local model request is invalid.";
    case LocalModelIpcErrorReason.UNSUPPORTED_MODEL:
      return "This local model configuration is not supported.";
    case LocalModelIpcErrorReason.LLAMACPP_MISSING:
      return "The local llama.cpp runtime is not available.";
    case LocalModelIpcErrorReason.PORT_IN_USE:
      return "The local model port is already in use.";
    case LocalModelIpcErrorReason.HEALTH_CHECK_FAILED:
      return "The local model health check failed.";
    case LocalModelIpcErrorReason.SECURITY_BLOCKED:
      return "The local model operation was blocked for safety.";
    default:
      return "The local model operation failed.";
  }
}

function stringifyErrorLike(input: unknown): string {
  if (typeof input === "string") return input;
  if (!isPlainRecord(input)) return "";
  const parts = [
    input.reason,
    input.code,
    input.name,
    input.message,
    input.cause,
  ];
  return parts.filter((part): part is string => typeof part === "string").join(" ");
}

function hasAny(text: string, needles: readonly string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function copyNonEmptyString<T extends Record<string, unknown>, K extends string>(
  source: Record<string, unknown>,
  target: T,
  key: K,
): void {
  if (isNonEmptyString(source[key])) {
    (target as Record<string, unknown>)[key] = source[key];
  }
}

function copyBoolean<T extends Record<string, unknown>, K extends string>(
  source: Record<string, unknown>,
  target: T,
  key: K,
): void {
  if (typeof source[key] === "boolean") {
    (target as Record<string, unknown>)[key] = source[key];
  }
}

function copyNonNegativeNumber<T extends Record<string, unknown>, K extends string>(
  source: Record<string, unknown>,
  target: T,
  key: K,
): void {
  const numeric = Number(source[key]);
  if (Number.isFinite(numeric) && numeric >= 0) {
    (target as Record<string, unknown>)[key] = numeric;
  }
}
