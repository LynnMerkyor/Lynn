import path from "node:path";
import {
  CodexAppServerClient,
  type CodexAppServerClientOptions,
  type CodexAppServerNotification,
  type CodexAppServerRequest,
} from "../../shared/codex-app-server-client.js";
import {
  classifyAgentRunError,
  createAgentRunLifecycle,
  type AgentRunLifecycle,
  type AgentRunTerminal,
} from "../../shared/agent-run-lifecycle.js";
import { resolveToolApproval } from "./code-tool-render.js";
import { startCodexResponsesProxy } from "./codex-responses-proxy.js";
import type { CodeAgentLoopInput, CodeAgentLoopResult } from "./code-agent-loop.js";
import { nowIso, writeJsonLine } from "./jsonl.js";
import type { CodePlanItem } from "./plan-tool.js";
import type { ClientToolName } from "./tools/types.js";
import { readVersionInfo } from "./version.js";

type JsonObject = Record<string, unknown>;

export interface CodexHarnessLoopOptions {
  clientOptions?: CodexAppServerClientOptions;
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function textField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function appServerApprovalPolicy(value: CodeAgentLoopInput["toolCtx"]["approval"]): "on-request" | "never" {
  return value === "ask" ? "on-request" : "never";
}

function appServerEffort(value: CodeAgentLoopInput["reasoning"]["effort"]): string | null {
  if (value === "auto" || value === "off") return null;
  return value;
}

function itemTool(item: JsonObject): { id: string; name: string; clientTool: ClientToolName | null; args: Record<string, unknown> } | null {
  const id = textField(item.id);
  const type = textField(item.type);
  if (!id) return null;
  if (type === "commandExecution") {
    return { id, name: "command_execution", clientTool: "bash", args: { command: textField(item.command) } };
  }
  if (type === "fileChange") {
    return { id, name: "file_change", clientTool: "apply_patch", args: {} };
  }
  if (type === "mcpToolCall") {
    return { id, name: `mcp:${textField(item.server)}:${textField(item.tool)}`, clientTool: null, args: asObject(item.arguments) };
  }
  if (type === "dynamicToolCall") {
    return { id, name: textField(item.tool) || "dynamic_tool", clientTool: null, args: asObject(item.arguments) };
  }
  return null;
}

function toolSucceeded(item: JsonObject): boolean {
  const status = textField(item.status).toLowerCase();
  if (typeof item.success === "boolean") return item.success;
  return status === "completed" || status === "applied" || status === "succeeded";
}

function toolError(item: JsonObject): string | null {
  const error = asObject(item.error);
  return textField(error.message) || textField(item.aggregatedOutput) || null;
}

function planItems(value: unknown): CodePlanItem[] {
  if (!Array.isArray(value)) return [];
  return value.map((raw) => {
    const item = asObject(raw);
    const rawStatus = textField(item.status);
    const status: CodePlanItem["status"] = rawStatus === "completed"
      ? "completed"
      : rawStatus === "inProgress" || rawStatus === "in_progress"
        ? "in_progress"
        : "pending";
    return { status, content: textField(item.step) };
  }).filter((item) => item.content);
}

function finalTextFromTurn(turn: JsonObject): string {
  const items = Array.isArray(turn.items) ? turn.items : [];
  return items
    .map(asObject)
    .filter((item) => item.type === "agentMessage")
    .map((item) => textField(item.text))
    .filter(Boolean)
    .join("\n\n");
}

function messageText(content: NonNullable<CodeAgentLoopInput["resumeMessages"]>[number]["content"]): string {
  if (typeof content === "string") return content.trim();
  return content
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "image_url") return "[image from earlier turn omitted; inspect the current workspace if needed]";
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function codexTurnText(input: CodeAgentLoopInput): string {
  const memory = input.memoryFrame?.trim() || "";
  const resume = (input.resumeMessages || [])
    .slice(-32)
    .map((message) => {
      const text = messageText(message.content);
      if (!text && !message.tool_calls?.length) return "";
      const calls = message.tool_calls?.map((call) => `${call.function.name}(${call.function.arguments})`).join("\n") || "";
      const body = [text, calls].filter(Boolean).join("\n");
      const label = message.role === "tool" ? `tool${message.name ? `:${message.name}` : ""}` : message.role;
      return `[${label}]\n${body}`;
    })
    .filter(Boolean)
    .join("\n\n")
    .slice(-60_000);
  if (!memory && !resume) return input.task;
  return [
    memory ? `[Lynn durable memory]\n${memory}` : "",
    resume ? `[Lynn resumed conversation — context only, not a new task]\n${resume}` : "",
    `[Current task]\n${input.task}`,
  ].filter(Boolean).join("\n\n");
}

async function approvalDecision(
  input: CodeAgentLoopInput,
  tool: ClientToolName,
  args: Record<string, unknown>,
): Promise<"accept" | "acceptForSession" | "decline"> {
  if (input.requestApproval) {
    const decision = await input.requestApproval({
      tool,
      args,
      cwd: input.toolCtx.cwd,
      preview: tool === "bash" ? textField(args.command) : undefined,
    });
    return decision === "approve_all" ? "acceptForSession" : decision === "approve" ? "accept" : "decline";
  }
  if (input.toolCtx.approval === "yolo" || input.toolCtx.approval === "on-failure") return "acceptForSession";
  if (input.toolCtx.approval === "never") return "decline";
  try {
    await resolveToolApproval({
      tool,
      approval: input.toolCtx.approval,
      cwd: input.toolCtx.cwd,
      json: input.json,
      input: input.input,
      output: input.output,
      preview: tool === "bash" ? textField(args.command) : undefined,
      args,
    });
    return "accept";
  } catch {
    return "decline";
  }
}

async function handleServerRequest(
  client: CodexAppServerClient,
  lifecycle: AgentRunLifecycle,
  input: CodeAgentLoopInput,
  request: CodexAppServerRequest,
): Promise<void> {
  const params = asObject(request.params);
  const method = request.method;
  if (method === "item/commandExecution/requestApproval") {
    lifecycle.transition("waiting_approval");
    const decision = await approvalDecision(input, "bash", { command: textField(params.command) });
    client.respond(request.id, { decision });
    lifecycle.transition("running");
    return;
  }
  if (method === "item/fileChange/requestApproval") {
    lifecycle.transition("waiting_approval");
    const decision = await approvalDecision(input, "apply_patch", {});
    client.respond(request.id, { decision });
    lifecycle.transition("running");
    return;
  }
  if (method === "execCommandApproval" || method === "applyPatchApproval") {
    lifecycle.transition("waiting_approval");
    const command = Array.isArray(params.command) ? params.command.map(String).join(" ") : textField(params.command);
    const decision = await approvalDecision(input, method === "execCommandApproval" ? "bash" : "apply_patch", { command });
    const legacyDecision = decision === "acceptForSession"
      ? "approved_for_session"
      : decision === "accept"
        ? "approved"
        : { denied: { rejection: "Denied by Lynn approval policy" } };
    client.respond(request.id, { decision: legacyDecision });
    lifecycle.transition("running");
    return;
  }
  if (method === "item/permissions/requestApproval") {
    lifecycle.transition("waiting_approval");
    const requested = asObject(params.permissions);
    const decision = await approvalDecision(input, "bash", { command: textField(params.reason) || "Additional runtime permissions" });
    const permissions: JsonObject = {};
    if (decision !== "decline") {
      if (requested.network && typeof requested.network === "object") permissions.network = requested.network;
      if (requested.fileSystem && typeof requested.fileSystem === "object") permissions.fileSystem = requested.fileSystem;
    }
    client.respond(request.id, {
      permissions,
      scope: decision === "acceptForSession" ? "session" : "turn",
    });
    lifecycle.transition("running");
    return;
  }
  if (method === "currentTime/read") {
    client.respond(request.id, { currentTime: new Date().toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    return;
  }
  if (method === "item/tool/requestUserInput") {
    client.respond(request.id, { answers: {} });
    return;
  }
  if (method === "mcpServer/elicitation/request") {
    client.respond(request.id, { action: "decline" });
    return;
  }
  if (method === "item/tool/call") {
    client.respond(request.id, {
      contentItems: [{ type: "inputText", text: "Lynn did not register this dynamic tool for the current harness turn." }],
      success: false,
    });
    return;
  }
  client.respondError(request.id, `Unsupported Codex app-server request: ${method}`);
}

function handleNotification(
  notification: CodexAppServerNotification,
  lifecycle: AgentRunLifecycle,
  input: CodeAgentLoopInput,
  state: { text: string; turnId: string },
): void {
  const params = asObject(notification.params);
  const eventTurnId = textField(params.turnId) || textField(asObject(params.turn).id);
  if (state.turnId && eventTurnId && eventTurnId !== state.turnId) return;
  switch (notification.method) {
    case "item/agentMessage/delta": {
      const delta = textField(params.delta);
      state.text += delta;
      input.onEvent?.({ type: "assistant.delta", text: delta });
      return;
    }
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta": {
      const delta = textField(params.delta);
      input.onEvent?.({ type: "reasoning.delta", text: delta });
      return;
    }
    case "turn/plan/updated": {
      const items = planItems(params.plan);
      if (items.length) input.onEvent?.({ type: "plan.updated", items });
      return;
    }
    case "thread/compacted":
      lifecycle.transition("compacting");
      input.onEvent?.({ type: "runtime.compacted", messages: 0 });
      lifecycle.transition("running");
      return;
    case "item/started": {
      const tool = itemTool(asObject(params.item));
      if (!tool) return;
      const mutation = lifecycle.beginTool(tool.id, tool.name, JSON.stringify(tool.args));
      if (!mutation.accepted) return;
      if (tool.clientTool) input.onEvent?.({ type: "tool.requested", tool: tool.clientTool, args: tool.args });
      else input.onEvent?.({ type: "tool.progress", message: `${tool.name} · running` });
      return;
    }
    case "item/completed": {
      const item = asObject(params.item);
      const tool = itemTool(item);
      if (!tool) return;
      const ok = toolSucceeded(item);
      const error = ok ? null : toolError(item);
      const mutation = lifecycle.finishTool(tool.id, { ok, error });
      if (!mutation.accepted) return;
      if (tool.clientTool) {
        input.onEvent?.({ type: "tool.result", result: { ok, tool: tool.clientTool, output: item.aggregatedOutput || item.changes || item.result, ...(error ? { error } : {}) } });
      } else {
        input.onEvent?.({ type: "tool.progress", message: `${tool.name} · ${ok ? "done" : "failed"}` });
      }
      return;
    }
    default:
      return;
  }
}

export async function runCodexHarnessLoop(input: CodeAgentLoopInput, options: CodexHarnessLoopOptions = {}): Promise<CodeAgentLoopResult> {
  const lifecycle = createAgentRunLifecycle({ scope: "cli-codex" });
  const started = lifecycle.start();
  input.onEvent?.({ type: "run.started", runId: started.snapshot.runId, phase: "running", revision: started.snapshot.revision });
  if (input.json) {
    writeJsonLine({
      type: "code.run.started",
      ts: nowIso(),
      runId: started.snapshot.runId,
      phase: "running",
      revision: started.snapshot.revision,
      harness: "codex",
    });
  }
  const emitFinished = (terminal: AgentRunTerminal, snapshot: ReturnType<AgentRunLifecycle["snapshot"]>): void => {
    input.onEvent?.({ type: "run.finished", runId: snapshot.runId, snapshot, terminal });
    if (input.json) {
      writeJsonLine({
        type: "code.run.finished",
        ts: nowIso(),
        runId: snapshot.runId,
        phase: snapshot.phase,
        code: terminal.code,
        ok: terminal.ok,
        resumable: terminal.resumable,
        partial: terminal.partial,
        message: terminal.message,
        harness: "codex",
      });
    }
  };
  let proxy;
  try {
    proxy = await startCodexResponsesProxy({
      brainUrl: input.brainUrl,
      provider: input.fallbackProvider,
      reasoning: input.reasoning,
    });
  } catch (error) {
    const finished = lifecycle.finish(classifyAgentRunError(error, { signal: input.signal }));
    const terminal = finished.snapshot.terminal as AgentRunTerminal;
    emitFinished(terminal, finished.snapshot);
    throw error;
  }
  const proxyEnvKey = "LYNN_CODEX_RESPONSES_PROXY_TOKEN";
  const model = input.fallbackProvider?.model || "lynn-brain-router";
  const configOverrides = [
    'model_provider="lynn"',
    `model_providers.lynn={name="Lynn BYOK",base_url=${tomlString(proxy.baseUrl)},env_key="${proxyEnvKey}",wire_api="responses"}`,
  ];
  const client = new CodexAppServerClient({
    cwd: input.toolCtx.cwd,
    env: { [proxyEnvKey]: proxy.bearerToken },
    configOverrides,
    clientVersion: readVersionInfo().version,
    ...options.clientOptions,
  });
  const state = { text: "", turnId: "" };
  const stopNotification = client.onNotification((notification) => handleNotification(notification, lifecycle, input, state));
  const stopServerRequests = client.onServerRequest((request) => {
    void handleServerRequest(client, lifecycle, input, request).catch((error) => {
      try {
        client.respondError(request.id, error instanceof Error ? error.message : String(error));
      } catch {}
    });
  });
  client.onDiagnostic((message) => input.onEvent?.({ type: "tool.progress", message: `codex harness: ${message}` }));

  try {
    await client.start();
    const threadResponse = await client.startThread({
      model,
      modelProvider: "lynn",
      allowProviderModelFallback: false,
      cwd: path.resolve(input.toolCtx.cwd),
      approvalPolicy: appServerApprovalPolicy(input.toolCtx.approval),
      sandbox: input.toolCtx.sandbox || "workspace-write",
      ephemeral: true,
    });
    const threadId = textField(asObject(threadResponse.thread).id);
    if (!threadId) throw new Error("Codex app-server did not return a thread id");
    const turnInput: JsonObject[] = [{ type: "text", text: codexTurnText(input), text_elements: [] }];
    for (const mediaPath of input.imagePaths || []) {
      turnInput.push({ type: "localImage", path: path.resolve(mediaPath) });
    }
    const turnResponse = await client.startTurn({
      threadId,
      input: turnInput,
      cwd: path.resolve(input.toolCtx.cwd),
      approvalPolicy: appServerApprovalPolicy(input.toolCtx.approval),
      model,
      effort: appServerEffort(input.reasoning.effort),
    });
    state.turnId = textField(asObject(turnResponse.turn).id);
    if (!state.turnId) throw new Error("Codex app-server did not return a turn id");
    const completed = await client.waitForTurn(threadId, state.turnId, { signal: input.signal });
    const turn = completed.turn;
    const status = textField(turn.status);
    if (!state.text.trim()) state.text = finalTextFromTurn(turn);
    if (status !== "completed") {
      const turnError = asObject(turn.error);
      throw new Error(textField(turnError.message) || `Codex turn ended with status ${status || "unknown"}`);
    }
    const finished = lifecycle.finish({ code: "completed", partial: false });
    const terminal = finished.snapshot.terminal as AgentRunTerminal;
    emitFinished(terminal, finished.snapshot);
    return {
      text: state.text,
      maxStepsReached: false,
      usageSummary: null,
      usageRecords: [],
      runId: finished.snapshot.runId,
      terminal,
    };
  } catch (error) {
    const classified = classifyAgentRunError(error, { signal: input.signal, partial: !!state.text.trim() });
    const finished = lifecycle.finish(classified);
    const terminal = finished.snapshot.terminal as AgentRunTerminal;
    emitFinished(terminal, finished.snapshot);
    throw error;
  } finally {
    stopNotification();
    stopServerRequests();
    await client.stop().catch(() => undefined);
    await proxy.stop().catch(() => undefined);
  }
}
