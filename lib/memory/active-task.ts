/**
 * active-task.js — 当前任务状态
 *
 * 这是记忆系统里的低延迟工作态层：不依赖 LLM、不做向量检索，
 * 只保存用户当前正在推进的目标、下一步和少量注意事项。
 */

import fs from "fs";
import path from "path";

export type ActiveTaskStatus = "idle" | "active" | "blocked" | "done";

export interface ActiveTaskState {
  title: string;
  status: ActiveTaskStatus;
  goal: string;
  next_step: string;
  project_path: string;
  notes: string[];
  evidence: string[];
  source: string;
  updated_at: string;
}

export type ActiveTaskInput = Partial<ActiveTaskState> & {
  nextStep?: unknown;
  projectPath?: unknown;
  updatedAt?: unknown;
};

const ACTIVE_STATUSES = new Set<ActiveTaskStatus>(["idle", "active", "blocked", "done"]);

function cleanString(value: unknown, maxLength = 500): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function cleanArray(value: unknown, maxItems = 6, maxLength = 300): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => cleanString(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function normalizeStatus(value: unknown): ActiveTaskStatus {
  const status = cleanString(value, 30).toLowerCase().replace(/\s+/g, "_");
  return ACTIVE_STATUSES.has(status as ActiveTaskStatus) ? status as ActiveTaskStatus : "active";
}

function isTaskInput(value: unknown): ActiveTaskInput {
  return typeof value === "object" && value !== null ? value as ActiveTaskInput : {};
}

function normalizeTask(input: ActiveTaskInput = {}): ActiveTaskState {
  const now = new Date().toISOString();
  const source = isTaskInput(input);
  return {
    title: cleanString(source.title, 160),
    status: normalizeStatus(source.status),
    goal: cleanString(source.goal, 800),
    next_step: cleanString(source.next_step ?? source.nextStep, 500),
    project_path: cleanString(source.project_path ?? source.projectPath, 500),
    notes: cleanArray(source.notes),
    evidence: cleanArray(source.evidence),
    source: cleanString(source.source, 120),
    updated_at: cleanString(source.updated_at ?? source.updatedAt, 80) || now,
  };
}

export class ActiveTaskMemory {
  private filePath: string;

  constructor({ filePath }: { filePath: string }) {
    this.filePath = filePath;
  }

  get(): ActiveTaskState | null {
    try {
      if (!this.filePath || !fs.existsSync(this.filePath)) return null;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf-8")) as ActiveTaskInput;
      const task = normalizeTask(parsed);
      return task.title || task.goal || task.next_step || task.notes.length > 0 ? task : null;
    } catch {
      return null;
    }
  }

  set(task: ActiveTaskInput): ActiveTaskState {
    const normalized = normalizeTask(task);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(normalized, null, 2));
    fs.renameSync(tmpPath, this.filePath);
    return normalized;
  }

  patch(partial: ActiveTaskInput): ActiveTaskState {
    return this.set({
      ...(this.get() || {}),
      ...(partial || {}),
      updated_at: new Date().toISOString(),
    });
  }

  clear(): void {
    try {
      if (this.filePath && fs.existsSync(this.filePath)) fs.unlinkSync(this.filePath);
    } catch {}
  }

  formatForPrompt(isZh = true): string {
    const task = this.get();
    if (!task || task.status === "idle" || task.status === "done") return "";

    const lines = [];
    if (task.title) lines.push(isZh ? `- 标题：${task.title}` : `- Title: ${task.title}`);
    if (task.goal) lines.push(isZh ? `- 目标：${task.goal}` : `- Goal: ${task.goal}`);
    lines.push(isZh ? `- 状态：${task.status}` : `- Status: ${task.status}`);
    if (task.next_step) lines.push(isZh ? `- 下一步：${task.next_step}` : `- Next step: ${task.next_step}`);
    if (task.project_path) lines.push(isZh ? `- 关联项目：${task.project_path}` : `- Project: ${task.project_path}`);
    for (const note of task.notes) {
      lines.push(isZh ? `- 注意：${note}` : `- Note: ${note}`);
    }
    for (const item of task.evidence) {
      lines.push(isZh ? `- 证据：${item}` : `- Evidence: ${item}`);
    }

    const header = isZh ? "## 当前任务状态" : "## Current Task State";
    const rule = isZh
      ? "当前对话里的新信息优先于这里的状态。"
      : "New information in the current conversation takes priority over this state.";
    return `${header}\n\n${rule}\n${lines.join("\n")}`;
  }
}
