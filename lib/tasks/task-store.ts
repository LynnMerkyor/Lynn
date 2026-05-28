import fs from "fs";
import path from "path";
import crypto from "crypto";

const MAX_TASKS = 500;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type TaskStatus = "pending" | "running" | "waiting_approval" | "completed" | "failed" | "cancelled";

export const TASK_STATUS: Record<"PENDING" | "RUNNING" | "WAITING_APPROVAL" | "COMPLETED" | "FAILED" | "CANCELLED", TaskStatus> = {
  PENDING: "pending",
  RUNNING: "running",
  WAITING_APPROVAL: "waiting_approval",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
};
export type TaskRunnerKind = "delegate" | "plan" | "review" | "generic" | (string & {});

export interface TaskRunnerPayload extends Record<string, unknown> {
  agentId?: string | null;
  prompt?: string | null;
  model?: unknown;
  readOnly?: boolean;
  systemAppend?: string | null;
  noMemory?: boolean;
  noTools?: boolean;
  cwdOverride?: string | null;
  runtimeSessionPath?: string | null;
  context?: string | null;
  reviewerKind?: string | null;
}

export interface TaskRunner {
  kind: TaskRunnerKind;
  payload: TaskRunnerPayload;
}

export interface TaskProgress extends Record<string, unknown> {
  total?: number | null;
  completed?: number;
  currentLabel?: string | null;
}

export interface TaskApprovalPayload extends Record<string, unknown> {
  command?: unknown;
  reason?: unknown;
  description?: unknown;
  category?: unknown;
  identifier?: unknown;
  trustedRoot?: unknown;
  title?: unknown;
  message?: unknown;
}

export interface TaskApproval extends Record<string, unknown> {
  ts?: string;
  confirmId?: string;
  kind?: string;
  status?: string;
  value?: unknown;
  payload?: TaskApprovalPayload | null;
}

export interface TaskEvent extends Record<string, unknown> {
  ts?: string;
  type: string;
  level?: string;
  message?: string;
  data?: unknown;
}

export interface TaskArtifact extends Record<string, unknown> {
  ts?: string;
  type?: string;
  label?: string;
  text?: string;
  sessionPath?: string;
  sessionFile?: string;
  reviewerName?: string | null;
  structured?: unknown;
  followUpPrompt?: string | null;
}

export interface TaskMetadata extends Record<string, unknown> {
  autoRun?: boolean;
  activityRecorded?: boolean;
  autoVerify?: boolean;
  retryOf?: string;
  retriedAt?: string;
  reviewId?: string | null;
  reviewerName?: string | null;
  findingsCount?: number;
  workflowGate?: string | null;
}

export interface TaskSnapshot extends Record<string, unknown> {
  capturedAt?: string;
  agentId?: string | null;
  agentName?: string | null;
  sessionPath?: string | null;
  runtimeSessionPath?: string | null;
  cwd?: string | null;
  securityMode?: string | null;
  planMode?: boolean;
  currentModel?: unknown;
  taskModel?: unknown;
  defaultChatModel?: unknown;
  utilityModel?: unknown;
  utilityLargeModel?: unknown;
  promptPreview?: string | null;
}

export interface TaskRecord extends Record<string, unknown> {
  id: string;
  type: string;
  title: string;
  status: TaskStatus;
  scope: string;
  agentId: string | null;
  sessionPath: string | null;
  source: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  resultSummary: string | null;
  error: string | null;
  interruptible: boolean;
  runKey: string | null;
  runner: TaskRunner;
  progress: TaskProgress;
  review: unknown | null;
  approvals: TaskApproval[];
  events: TaskEvent[];
  metadata: TaskMetadata;
  artifacts: TaskArtifact[];
  snapshot: TaskSnapshot | null;
}

export interface TaskCreateInput extends Record<string, unknown> {
  id?: string | null;
  type?: string | null;
  title?: string | null;
  status?: TaskStatus | null;
  scope?: string | null;
  agentId?: string | null;
  sessionPath?: string | null;
  source?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  resultSummary?: string | null;
  error?: string | null;
  interruptible?: boolean;
  runKey?: string | null;
  runner?: TaskRunner | null;
  progress?: TaskProgress | null;
  review?: unknown | null;
  approvals?: TaskApproval[] | null;
  events?: TaskEvent[] | null;
  metadata?: TaskMetadata | null;
  artifacts?: TaskArtifact[] | null;
  snapshot?: TaskSnapshot | null;
}

export type TaskUpdatePayload = Partial<TaskRecord> & Record<string, unknown>;
export type TaskUpdater = TaskUpdatePayload | ((current: TaskRecord) => TaskUpdatePayload | null | undefined);

export interface TaskEventInput extends Record<string, unknown> {
  type?: string | null;
  level?: string | null;
  message?: string | null;
  data?: unknown;
}

export interface TaskApprovalInput extends Record<string, unknown> {
  confirmId?: string;
  kind?: string;
  status?: string;
  value?: unknown;
  payload?: TaskApprovalPayload | null;
}

export interface TaskArtifactInput extends Record<string, unknown> {
  type?: string;
  label?: string;
  text?: string;
  sessionPath?: string;
  sessionFile?: string;
  reviewerName?: string | null;
  structured?: unknown;
  followUpPrompt?: string | null;
}

export interface PersistedTasksJson {
  tasks?: TaskRecord[];
}

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

function nowIso(): string {
  return new Date().toISOString();
}

function asArray<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

export class TaskStore {
  private _filePath: string;
  private _tasks: TaskRecord[];

  constructor(filePath: string) {
    this._filePath = filePath;
    this._tasks = [];
    this._load();
  }

  _load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this._filePath, "utf-8")) as PersistedTasksJson;
      this._tasks = asArray(raw?.tasks);
    } catch {
      this._tasks = [];
    }
  }

  _save(): void {
    fs.mkdirSync(path.dirname(this._filePath), { recursive: true });
    const tmpPath = `${this._filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify({ tasks: this._tasks }, null, 2) + "\n", "utf-8");
    fs.renameSync(tmpPath, this._filePath);
  }

  _trim(): void {
    if (this._tasks.length <= MAX_TASKS) return;
    this._tasks = this._tasks
      .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))
      .slice(0, MAX_TASKS);
  }

  list(): TaskRecord[] {
    return this._tasks
      .slice()
      .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))
      .map((task) => clone(task));
  }

  get(taskId: string): TaskRecord | null {
    const task = this._tasks.find((entry) => entry.id === taskId);
    return task ? clone(task) : null;
  }

  create(input: TaskCreateInput = {}): TaskRecord {
    const createdAt = nowIso();
    const task: TaskRecord = {
      id: input.id || `task_${crypto.randomUUID()}`,
      type: input.type || "generic",
      title: input.title || input.type || "Task",
      status: input.status || TASK_STATUS.PENDING,
      scope: input.scope || "agent",
      agentId: input.agentId || null,
      sessionPath: input.sessionPath || null,
      source: input.source || "manual",
      createdAt,
      updatedAt: createdAt,
      startedAt: input.startedAt || null,
      finishedAt: input.finishedAt || null,
      resultSummary: input.resultSummary || null,
      error: input.error || null,
      interruptible: input.interruptible !== false,
      runKey: input.runKey || null,
      runner: input.runner || {
        kind: input.type || "generic",
        payload: {},
      },
      progress: input.progress || {
        total: null,
        completed: 0,
        currentLabel: null,
      },
      review: input.review || null,
      approvals: input.approvals || [],
      events: input.events || [],
      metadata: input.metadata || {},
      artifacts: input.artifacts || [],
      snapshot: input.snapshot || null,
    };

    this._tasks.unshift(task);
    this._trim();
    this._save();
    return clone(task);
  }

  update(taskId: string, updater?: TaskUpdater): TaskRecord | null {
    const index = this._tasks.findIndex((entry) => entry.id === taskId);
    if (index === -1) return null;

    const current = this._tasks[index];
    const partial = typeof updater === "function" ? updater(clone(current)) : updater;
    if (!partial || typeof partial !== "object") return clone(current);

    const next: TaskRecord = {
      ...current,
      ...partial,
      updatedAt: nowIso(),
    };
    this._tasks[index] = next;
    this._save();
    return clone(next);
  }

  appendEvent(taskId: string, event?: TaskEventInput | null): TaskRecord | null {
    return this.update(taskId, (task) => ({
      events: [
        ...asArray(task.events),
        {
          ts: nowIso(),
          type: event?.type || "log",
          level: event?.level || "info",
          message: event?.message || "",
          data: event?.data ?? null,
        },
      ].slice(-400),
    }));
  }

  appendApproval(taskId: string, approval?: TaskApprovalInput | null): TaskRecord | null {
    return this.update(taskId, (task) => ({
      approvals: [
        ...asArray(task.approvals),
        {
          ts: nowIso(),
          ...approval,
        },
      ].slice(-100),
    }));
  }

  addArtifact(taskId: string, artifact?: TaskArtifactInput | null): TaskRecord | null {
    return this.update(taskId, (task) => ({
      artifacts: [
        ...asArray(task.artifacts),
        {
          ts: nowIso(),
          ...artifact,
        },
      ].slice(-100),
    }));
  }
}
