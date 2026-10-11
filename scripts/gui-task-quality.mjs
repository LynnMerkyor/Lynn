export function releaseRegressionMustFail(report, level) {
  return report.blockerFailed.length > 0
    || (level !== "smoke" && report.criticalFailed.length > 0)
    || (level === "nightly" && report.failed.length > 0);
}

export async function rejectGuiToolAuthorization(active, message, { sessionPath, reject }) {
  if (message?.type !== "tool_authorization" || !sessionPath || message.sessionPath !== sessionPath) return false;
  if (typeof message.confirmId !== "string" || !message.confirmId.trim()) {
    active.errors.push("authorization:missing-confirm-id");
    return false;
  }
  if (active.authorizationDecisions.some((decision) => decision.confirmId === message.confirmId)) return false;
  const decision = { confirmId: message.confirmId, action: "rejected", status: "pending" };
  active.authorizationDecisions.push(decision);
  try {
    const result = await reject(message.confirmId, { action: "rejected" });
    if (result?.ok !== true) throw new Error("rejection-not-acknowledged");
    decision.status = "resolved";
  } catch {
    decision.status = "failed";
    active.errors.push("authorization:rejection-failed");
  }
  return true;
}

export function recordGuiToolLifecycle(active, message) {
  const progress = message?.type === "tool_progress";
  const event = progress ? message.event
    : ["tool_start", "tool_execution_start"].includes(message?.type) ? "start"
      : ["tool_end", "tool_execution_end"].includes(message?.type) ? "end" : null;
  const name = message?.name || message?.toolName || "";
  if (!name || !["start", "end"].includes(event)) return false;
  const id = message.toolCallId || message.id || "";
  const source = progress ? "tool_progress" : "local";
  if (event === "start") {
    active.tools.push({ id, name, source, success: null });
  } else {
    const success = progress ? message.ok === true : message.success ?? message.isError === false;
    const found = active.tools.find((tool) => tool.source === source && tool.success === null
      && (id ? tool.id === id : tool.name === name));
    if (found) found.success = success;
    else active.orphanToolEnds.push({ id, name, source, success });
  }
  return true;
}

export function captureGuiToolEvent(message) {
  if (message?.type === "tool_progress") {
    return { name: message.name || message.toolName, event: message.event, ok: message.ok, summary: message.summary, details: message.details };
  }
  if (message?.type === "tool_end" || message?.type === "tool_execution_end") {
    return { name: message.name || message.toolName, event: "end", ok: message.success ?? (message.isError === false), details: message.details };
  }
  return null;
}

export function validateGuiTaskEvidence({ answer, expected, finished, toolEvents = [], requiredTools = [] }) {
  if (!finished) return "assistant-turn-not-finished";
  if (!String(answer || "").trim()) return "assistant-answer-empty";
  if (!String(answer).includes(expected)) return "assistant-answer-missing-expected";
  if (/这轮检索拿到的可核验线索有限，先按可见内容收口|工具当前不可用|搜索提示：|综合答案：|模型这次没有返回可见内容|本轮已安全结束|模型返回的答案与当前日期或已有证据冲突/u.test(answer)) {
    return "assistant-answer-is-tool-fallback";
  }
  for (const name of requiredTools) {
    if (!toolEvents.some((event) => event.name === name && event.event === "end" && event.ok === true)) {
      return `required-tool-not-successful:${name}`;
    }
  }
  return null;
}
