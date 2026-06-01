import type { FleetWorkerEvent } from "../../shared/fleet-events.js";

export function externalJsonEvents(line: string, workerId: string, agent: string): FleetWorkerEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const record = parsed as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "";
  const out: FleetWorkerEvent[] = [];
  const text = externalText(record);
  if (text) {
    if (/reason|thinking|thought/i.test(type)) {
      out.push({ type: "reasoning.delta", workerId, agent, text, hidden: true });
    } else {
      out.push({ type: "assistant.delta", workerId, agent, text });
    }
  }
  out.push(...externalItemEvents(record, workerId, agent));
  out.push(...externalToolEvents(record, workerId, agent));
  if (!out.length && type) {
    out.push({ type: "worker.progress", workerId, agent, message: `external:${type}`, data: record });
  }
  return out;
}

function externalText(record: Record<string, unknown>): string {
  for (const key of ["text", "content", "result", "summary", "message"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  const message = record.message;
  if (message && typeof message === "object" && !Array.isArray(message)) {
    const nested = message as Record<string, unknown>;
    if (typeof nested.content === "string" && nested.content.trim()) return nested.content;
    if (Array.isArray(nested.content)) {
      return nested.content
        .map((part) => part && typeof part === "object" && !Array.isArray(part) ? (part as Record<string, unknown>).text : "")
        .filter((part): part is string => typeof part === "string" && !!part.trim())
        .join("");
    }
  }
  const delta = record.delta;
  if (delta && typeof delta === "object" && !Array.isArray(delta)) {
    const nested = delta as Record<string, unknown>;
    if (typeof nested.text === "string" && nested.text.trim()) return nested.text;
    if (typeof nested.content === "string" && nested.content.trim()) return nested.content;
  }
  return "";
}

function externalToolName(record: Record<string, unknown>): string {
  for (const key of ["tool", "toolName", "name"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim() && /tool|call|bash|edit|read|write|grep|glob/i.test(String(record.type || value))) return value;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const name = (value as Record<string, unknown>).name;
      if (typeof name === "string" && name.trim()) return name;
    }
  }
  const toolUse = record.tool_use ?? record.toolUse;
  if (toolUse && typeof toolUse === "object" && !Array.isArray(toolUse)) {
    const name = (toolUse as Record<string, unknown>).name;
    if (typeof name === "string" && name.trim()) return name;
  }
  return "";
}

function externalItemEvents(record: Record<string, unknown>, workerId: string, agent: string): FleetWorkerEvent[] {
  const item = nestedRecord(record.item) ?? nestedRecord(nestedRecord(record.data)?.item);
  if (!item) return [];
  const out: FleetWorkerEvent[] = [];
  const topType = typeof record.type === "string" ? record.type.toLowerCase() : "";
  const itemType = String(item.type || item.kind || "").toLowerCase();
  const text = externalText(item);
  if (text && /reason|thinking|thought/.test(itemType || topType)) {
    out.push({ type: "reasoning.delta", workerId, agent, text, hidden: true });
  } else if (text && /assistant|message|response|answer/.test(itemType || topType)) {
    out.push({ type: "assistant.delta", workerId, agent, text });
  }
  const command = stringField(item, ["command", "cmd", "shell", "input"]);
  if (command && /command|shell|bash|exec|terminal/.test(itemType || topType)) {
    if (/start|running|created|begin/.test(topType) || /start|running|created|begin/.test(String(item.status || "").toLowerCase())) {
      out.push({ type: "shell.started", workerId, agent, command, approval: "auto" });
    } else if (/complete|completed|finish|finished|done|end/.test(topType) || "exit_code" in item || "exitCode" in item) {
      const exitCode = numberField(item, ["exit_code", "exitCode", "code"]) ?? 0;
      out.push({ type: "shell.finished", workerId, agent, command, exitCode, ok: exitCode === 0 });
    }
  }
  const output = stringField(item, ["output", "stdout", "stderr"]);
  if (output && /output|stdout|stderr/.test(itemType || topType)) {
    out.push({ type: "shell.output", workerId, agent, stream: item.stderr ? "stderr" : "stdout", text: output });
  }
  return out;
}

function externalToolEvents(record: Record<string, unknown>, workerId: string, agent: string): FleetWorkerEvent[] {
  const out: FleetWorkerEvent[] = [];
  const toolName = externalToolName(record);
  if (toolName) {
    const ok = externalOk(record);
    if (ok === null) out.push({ type: "tool.started", workerId, agent, name: toolName, argsPreview: externalArgsPreview(record) });
    else out.push({ type: "tool.finished", workerId, agent, name: toolName, ok });
  }
  const message = record.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return out;
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return out;
  for (const part of content) {
    if (!part || typeof part !== "object" || Array.isArray(part)) continue;
    const item = part as Record<string, unknown>;
    const type = typeof item.type === "string" ? item.type.toLowerCase() : "";
    const name = typeof item.name === "string" && item.name.trim() ? item.name : "tool_result";
    if (/tool_use|tool-call|tool_call/.test(type)) {
      out.push({ type: "tool.started", workerId, agent, name, argsPreview: previewValue(item.input ?? item.args ?? item.arguments) });
    } else if (/tool_result|tool-result/.test(type)) {
      out.push({ type: "tool.finished", workerId, agent, name, ok: item.is_error !== true });
    }
  }
  return out;
}

function externalArgsPreview(record: Record<string, unknown>): string | undefined {
  return previewValue(record.args ?? record.arguments ?? record.input);
}

function nestedRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringField(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

function numberField(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    const number = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN;
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function previewValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 240 ? `${text.slice(0, 240)}...` : text;
}

function externalOk(record: Record<string, unknown>): boolean | null {
  if (typeof record.ok === "boolean") return record.ok;
  if (typeof record.success === "boolean") return record.success;
  const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
  if (/tool.*(finish|result|complete|end)/.test(type)) return !record.error;
  if (/tool.*(start|use|call)/.test(type)) return null;
  return null;
}
