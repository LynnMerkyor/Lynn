import { renderCard, renderPlanCard } from "./terminal-spinner.js";

export type CodePlanStatus = "pending" | "in_progress" | "completed";

export interface CodePlanItem {
  content: string;
  status: CodePlanStatus;
  id?: string;
}

export function normalizePlanItems(value: unknown): CodePlanItem[] {
  const rawItems = planArray(value);
  return rawItems
    .map((item, index) => normalizePlanItem(item, index))
    .filter((item): item is CodePlanItem => !!item);
}

export function renderPlanItems(items: readonly CodePlanItem[]): string {
  if (!items.length) return renderCard({ kind: "plan", title: "plan", body: ["no items"] }, false);
  return renderPlanCard(items.map((item, index) => ({
    status: item.status,
    text: `${item.id || `P${index + 1}`}: ${item.content}`,
  })), false, "plan");
}

function planArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  for (const key of ["plan", "items", "todos", "tasks", "steps"]) {
    const candidate = record[key];
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function normalizePlanItem(value: unknown, index: number): CodePlanItem | null {
  if (typeof value === "string") {
    const content = value.trim();
    return content ? { content, status: "pending", id: `P${index + 1}` } : null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const content = firstString(record.content, record.text, record.title, record.task, record.step, record.message)?.trim();
  if (!content) return null;
  const status = normalizeStatus(firstString(record.status, record.state));
  const id = firstString(record.id, record.key, record.name);
  return {
    content,
    status,
    ...(id ? { id } : { id: `P${index + 1}` }),
  };
}

function normalizeStatus(value: string | undefined): CodePlanStatus {
  const key = (value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (key === "in_progress" || key === "doing" || key === "active" || key === "current" || key === "running") return "in_progress";
  if (key === "completed" || key === "complete" || key === "done" || key === "finished" || key === "success") return "completed";
  return "pending";
}

function firstString(...values: unknown[]): string | undefined {
  const value = values.find((entry) => typeof entry === "string" && entry.trim());
  return typeof value === "string" ? value : undefined;
}
