import { extractText } from "./content-utils.js";
import { clearPendingMutationOnSuccessfulDelete } from "./turn-retry-policy.js";

/** tool_start broadcasts only these arg fields to avoid sending full file contents. */
export const TOOL_ARG_SUMMARY_KEYS = [
  "file_path",
  "path",
  "command",
  "cmd",
  "shell",
  "script",
  "pattern",
  "url",
  "query",
  "key",
  "value",
  "action",
  "type",
  "schedule",
  "prompt",
  "label",
];

export function normalizeToolArgsForSummary(toolName, rawArgs) {
  if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) return rawArgs;
  const args = { ...rawArgs };
  if (toolName === "bash" && (typeof args.command !== "string" || !args.command.trim())) {
    for (const key of ["query", "cmd", "shell", "script"]) {
      if (typeof args[key] === "string" && args[key].trim()) {
        args.command = args[key];
        break;
      }
    }
  }
  return args;
}

export function rememberSuccessfulTool(ss, toolName, toolSummary, rawArgs) {
  if (!ss || !toolName) return;
  ss.successfulToolCount = (ss.successfulToolCount || 0) + 1;
  const args = normalizeToolArgsForSummary(toolName, rawArgs) || {};
  const record = {
    name: toolName,
    command: typeof args.command === "string" ? args.command : "",
    filePath: typeof (args.file_path || args.path) === "string" ? (args.file_path || args.path) : "",
    outputPreview: typeof toolSummary?.outputPreview === "string" ? toolSummary.outputPreview : "",
  };
  ss.lastSuccessfulTools = [...(ss.lastSuccessfulTools || []), record].slice(-8);
  if (toolName === "bash" && record.command) {
    clearPendingMutationOnSuccessfulDelete(ss, record.command);
  }
}

export function rememberFailedTool(ss, toolName) {
  if (!ss || !toolName) return;
  ss.hasFailedTool = true;
  ss.lastFailedTools = [...(ss.lastFailedTools || []), toolName].slice(-8);
}

export function buildPrefetchToolSummary(context) {
  const lines = String(context || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^【系统已完成/.test(line))
    .filter((line) => !/^(?:下面是|请直接|如果资料不足|来源[:：]?)/.test(line));
  const outputPreview = lines.slice(0, 6).join("\n").slice(0, 200);
  return outputPreview ? { outputPreview } : {};
}

export function summarizeToolExecution(event) {
  const rawDetails = event?.result?.details || {};
  const toolName = event?.toolName || "";
  const normalizedArgs = normalizeToolArgsForSummary(toolName, event?.args) || {};
  const toolIsError = Boolean(event?.isError || event?.result?.isError);
  const summary = {};

  if (toolName === "edit" || toolName === "edit-diff") {
    if (rawDetails.diff) {
      const lines = rawDetails.diff.split("\n");
      let added = 0;
      let removed = 0;
      for (const line of lines) {
        if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
        if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
      }
      summary.linesAdded = added;
      summary.linesRemoved = removed;
      summary.filePath = normalizedArgs.file_path || normalizedArgs.path || "";
    }
  } else if (toolName === "write") {
    summary.filePath = normalizedArgs.file_path || normalizedArgs.path || "";
    const text = extractText(event?.result?.content);
    const bytesMatch = text.match(/(\d+)\s*bytes/i);
    if (bytesMatch) summary.bytesWritten = parseInt(bytesMatch[1], 10);
  } else if (toolName === "bash") {
    const text = extractText(event?.result?.content);
    if (text) summary.outputPreview = text.slice(0, 200);
    summary.command = (normalizedArgs.command || "").slice(0, 80);
    if (rawDetails.truncation) {
      summary.totalLines = rawDetails.truncation.totalLines;
      summary.truncated = true;
    }
  } else if (toolName === "grep" || toolName === "glob" || toolName === "find") {
    const text = extractText(event?.result?.content);
    if (text) {
      const matchLines = text.trim().split("\n").filter(Boolean);
      summary.matchCount = matchLines.length;
      summary.outputPreview = matchLines.slice(0, 5).join("\n");
    }
  } else if (toolName === "web_search") {
    const text = extractText(event?.result?.content);
    if (text) summary.outputPreview = text.slice(0, 200);
  } else if (toolName === "read") {
    summary.filePath = normalizedArgs.file_path || normalizedArgs.path || "";
    const text = extractText(event?.result?.content);
    if (text) summary.lineCount = text.split("\n").length;
  } else {
    const text = extractText(event?.result?.content);
    if (text) summary.outputPreview = text.slice(0, 200);
  }

  return {
    toolName,
    rawDetails,
    normalizedArgs,
    toolIsError,
    summary,
    publicSummary: Object.keys(summary).length > 0 ? summary : undefined,
  };
}
