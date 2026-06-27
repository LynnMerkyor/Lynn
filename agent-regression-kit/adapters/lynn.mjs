import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { filterOutBrainManagedCustomTools, isBrainManagedCustomToolName } from "../../core/brain-managed-tools.ts";
import { createLynnAgentSession } from "../../core/agent-runtime/create-session.ts";
import { SessionManager } from "../../core/agent-runtime/session-manager.ts";
import { buildLocalQwen35DirectMessages, shouldRetryLocalQwen35WithoutThinking } from "../../server/chat/local-qwen35-direct-policy.ts";
import { buildLocalOfficeDirectAnswer } from "../../server/chat/local-office-answer.ts";
import { buildLocalWorkspaceContext, shouldAttachLocalWorkspaceContext } from "../../server/chat/local-workspace-context.ts";
import { shouldUseLocalQwen35DirectBridge } from "../../server/chat/local-qwen35-direct-policy.ts";
import { inferReportResearchKind } from "../../server/chat/report-research-context.ts";
import {
  containsNonProgressPseudoToolSimulation,
  flushStreamingPseudoToolBlocks,
  stripStreamingPseudoToolBlocks,
} from "../../server/chat/stream-sanitizer.ts";
import {
  buildToolStormFallbackText,
  isEvidenceTool,
  updateToolStormGuard,
} from "../../server/chat/tool-storm-guard.ts";
import { resolveInitialToolUseBehavior, TOOL_USE_BEHAVIOR } from "../../server/chat/tool-use-behavior.ts";
import {
  containsPseudoToolSimulation,
  countPseudoToolMarkers,
  scanPseudoToolMarkers,
  stripPseudoToolCallMarkup,
} from "../../shared/pseudo-tool-call.ts";
import { classifyRouteIntent } from "../../shared/task-route-intent.ts";
import { startScriptedOpenAIProvider } from "../src/fake-openai-provider.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI_BIN = path.join(REPO_ROOT, "cli", "bin", "lynn.mjs");

export function createLynnAdapter() {
  return {
    name: "lynn",
    version: "backend-v1",
    async run(operation, input = {}, context = {}) {
      switch (operation) {
        case "route_intent":
          return runRouteIntent(input);
        case "local_workspace_context":
          return runLocalWorkspaceContext(input);
        case "pseudo_tool_sanitizer":
          return runPseudoToolSanitizer(input);
        case "stream_sanitizer":
          return runStreamSanitizer(input);
        case "local_office_answer":
          return runLocalOfficeAnswer(input);
        case "realtime_kind":
          return runRealtimeKind(input);
        case "tool_use_behavior":
          return runToolUseBehavior(input);
        case "tool_storm_guard":
          return runToolStormGuard(input);
        case "brain_managed_tools":
          return runBrainManagedTools(input);
        case "local_qwen35_retry":
          return runLocalQwen35Retry(input);
        case "local_qwen35_history":
          return runLocalQwen35History(input, context);
        case "scripted_provider_probe":
          return runScriptedProviderProbe(input, context);
        case "brain_v2_route_trace":
          return runBrainV2RouteTrace(input, context);
        case "native_session_trace":
          return runNativeSessionTrace(input, context);
        case "cli_provider_trace":
          return runCliProviderTrace(input, context);
        default:
          throw new Error(`Unsupported Lynn regression operation: ${operation}`);
      }
    },
  };
}

function runRouteIntent(input) {
  const prompt = String(input.prompt || "");
  const intent = classifyRouteIntent(prompt, input.options || {});
  return { prompt, intent };
}

function runLocalWorkspaceContext(input) {
  const prompt = String(input.prompt || "");
  const routeIntent = input.routeIntent || classifyRouteIntent(prompt, input.routeOptions || {});
  const cwd = path.resolve(String(input.cwd || process.cwd()));
  const attach = shouldAttachLocalWorkspaceContext(prompt, routeIntent);
  const contextText = buildLocalWorkspaceContext({
    promptText: prompt,
    cwd,
    ...(input.options || {}),
  });
  const directBridge = shouldUseLocalQwen35DirectBridge(prompt, {
    isLocalModel: true,
    routeIntent,
    toolBehavior: TOOL_USE_BEHAVIOR.RUN_LLM_AGAIN,
    ...(input.localBridgeOptions || {}),
  });
  return {
    routeIntent,
    cwd,
    attach,
    directBridge,
    contextText,
  };
}

function runPseudoToolSanitizer(input) {
  const raw = String(input.text || "");
  const stripped = stripPseudoToolCallMarkup(raw);
  return {
    raw,
    contains: containsPseudoToolSimulation(raw),
    markerCount: countPseudoToolMarkers(raw),
    stripped,
    strippedContains: containsPseudoToolSimulation(stripped),
    scan: scanPseudoToolMarkers(raw),
  };
}

function runStreamSanitizer(input) {
  const chunks = Array.isArray(input.chunks) ? input.chunks : [input.text || ""];
  const state = {};
  const events = chunks.map((chunk) => stripStreamingPseudoToolBlocks(state, chunk));
  const flush = flushStreamingPseudoToolBlocks(state);
  const text = [...events.map((event) => event.text), flush.text].join("");
  return {
    events,
    flush,
    text,
    suppressed: events.some((event) => event.suppressed) || flush.suppressed,
    nonProgress: containsNonProgressPseudoToolSimulation(chunks.join("")),
  };
}

function runLocalOfficeAnswer(input) {
  const prompt = String(input.prompt || "");
  const answer = buildLocalOfficeDirectAnswer(prompt);
  return {
    prompt,
    hasAnswer: Boolean(answer),
    answer,
  };
}

function runRealtimeKind(input) {
  const prompt = String(input.prompt || "");
  return {
    prompt,
    kind: inferReportResearchKind(prompt),
  };
}

function runToolUseBehavior(input) {
  const prompt = String(input.prompt || "");
  const decision = resolveInitialToolUseBehavior(prompt, input.options || {});
  return {
    prompt,
    ...decision,
  };
}

function runToolStormGuard(input) {
  const state = {
    originalPromptText: input.originalPromptText || input.prompt || "",
    effectivePromptText: input.effectivePromptText || "",
    hasOutput: input.hasOutput ?? false,
  };
  const decisions = [];
  for (const call of input.calls || []) {
    decisions.push(updateToolStormGuard(state, call.name, call.args || {}));
  }
  const finalDecision = decisions.at(-1) || null;
  return {
    decisions,
    finalDecision,
    fallbackText: finalDecision ? buildToolStormFallbackText(finalDecision, input.summaryText || "") : "",
    evidenceTools: (input.tools || []).map((name) => ({ name, evidence: isEvidenceTool(name) })),
    state,
  };
}

function runBrainManagedTools(input) {
  const tools = Array.isArray(input.tools) ? input.tools : [];
  const kept = filterOutBrainManagedCustomTools(tools);
  return {
    managedNames: tools.filter((tool) => isBrainManagedCustomToolName(tool?.name)).map((tool) => tool.name),
    keptNames: kept.map((tool) => tool.name),
    flags: Object.fromEntries(tools.map((tool) => [String(tool?.name || ""), isBrainManagedCustomToolName(tool?.name)])),
  };
}

function runLocalQwen35Retry(input) {
  return {
    retry: shouldRetryLocalQwen35WithoutThinking(input),
  };
}

async function runLocalQwen35History(input, context) {
  const currentPrompt = String(input.currentPrompt || "");
  let sessionPath = input.sessionPath ? path.resolve(String(input.sessionPath)) : "";
  if (!sessionPath) {
    let root = context.vars?.fixtureRoot || "";
    if (!root) {
      const slug = String(context.case?.id || "case").replace(/[^a-z0-9._-]+/gi, "-").slice(0, 64) || "case";
      root = await fs.mkdtemp(path.join(os.tmpdir(), `lynn-agent-history-${slug}-`));
      context.addCleanup?.(() => fs.rm(root, { recursive: true, force: true }));
    }
    sessionPath = path.join(root, "session.jsonl");
  }
  if (Array.isArray(input.messages)) {
    await fs.mkdir(path.dirname(sessionPath), { recursive: true });
    const lines = input.messages.map((message) => JSON.stringify({
      type: "message",
      message,
    }));
    await fs.writeFile(sessionPath, `${lines.join("\n")}\n`, "utf8");
  }
  const messages = buildLocalQwen35DirectMessages(sessionPath, currentPrompt, input.effectivePromptText || currentPrompt);
  const userMessages = messages.filter((message) => message.role === "user").map((message) => message.content);
  return {
    sessionPath,
    messages,
    userMessages,
    lastUser: [...messages].reverse().find((message) => message.role === "user")?.content || "",
    currentPromptCount: userMessages.filter((text) => text.trim() === currentPrompt.trim()).length,
  };
}

async function runNativeSessionTrace(input, context) {
  const provider = await startScriptedOpenAIProvider({
    script: input.providerScript || input.script || [],
    defaultModel: input.model?.id || "scripted-model",
    models: input.models || [],
  });
  context.addCleanup?.(() => provider.close());
  const cwd = await resolveTraceCwd(input, context);
  const sessionManager = SessionManager.create(cwd, cwd);
  const events = [];
  const finalTexts = [];
  const tools = buildTraceTools(input.tools || []);
  try {
    const { session } = await createLynnAgentSession({
      cwd,
      sessionManager,
      model: {
        id: input.model?.id || "scripted-model",
        provider: input.model?.provider || "scripted-provider",
        api: input.model?.api || "openai-completions",
        baseUrl: provider.baseUrl,
        apiKey: input.model?.apiKey || "test-key",
      },
      tools,
      customTools: buildTraceTools(input.customTools || []),
      thinkingLevel: input.thinkingLevel || "auto",
    });
    session.subscribe((event) => {
      const canonical = canonicalSessionEvent(event);
      events.push(canonical);
      if (canonical.type === "message_end" && canonical.role === "assistant") {
        finalTexts.push(canonical.content || "");
      }
    });

    const prompts = Array.isArray(input.prompts) ? input.prompts : [input.prompt || ""];
    for (const prompt of prompts) {
      await session.prompt(String(prompt || ""));
    }
  } finally {
    await provider.close();
  }

  const messages = sessionManager.buildSessionContext().messages || [];
  const providerRequests = provider.requests.map(canonicalProviderRequest);
  const diagnostics = buildTraceDiagnostics({
    prompts: Array.isArray(input.prompts) ? input.prompts : [input.prompt || ""],
    events,
    finalTexts,
    messages,
    providerRequests,
  });
  return {
    cwd,
    events,
    eventTypes: events.map((event) => event.type),
    assistantEventTypes: events.map((event) => event.assistantEventType).filter(Boolean),
    toolStarts: events.filter((event) => event.type === "tool_execution_start"),
    toolEnds: events.filter((event) => event.type === "tool_execution_end"),
    finalTexts,
    finalText: finalTexts.at(-1) || "",
    messages: messages.map(canonicalMessage),
    messagesJson: JSON.stringify(messages),
    diagnostics,
    provider: {
      baseUrl: provider.baseUrl,
      requestCount: provider.requestCount,
      modelProbeCount: provider.modelProbeCount,
      requests: providerRequests,
      requestModels: provider.requests.map((request) => request.body?.model || ""),
      lastUserTexts: provider.requests.map((request) => lastMessageText(request.body?.messages, "user")),
      requestToolNames: provider.requests.map((request) => Array.isArray(request.body?.tools)
        ? request.body.tools.map((tool) => tool?.function?.name || tool?.name || "").filter(Boolean)
        : []),
    },
  };
}

async function resolveTraceCwd(input, context) {
  if (input.cwd) return path.resolve(String(input.cwd));
  if (context.vars?.fixtureRoot) return context.vars.fixtureRoot;
  const slug = String(context.case?.id || "case").replace(/[^a-z0-9._-]+/gi, "-").slice(0, 64) || "case";
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), `lynn-agent-trace-${slug}-`));
  context.addCleanup?.(() => fs.rm(cwd, { recursive: true, force: true }));
  return cwd;
}

function buildTraceTools(tools) {
  return (Array.isArray(tools) ? tools : []).map((tool) => ({
    name: String(tool.name || ""),
    description: tool.description || `Trace fixture tool ${tool.name || ""}`,
    parameters: tool.parameters || { type: "object", properties: {} },
    async execute(_toolCallId, args) {
      if (tool.throw) throw new Error(String(tool.throw));
      if (tool.result && typeof tool.result === "object") return tool.result;
      const text = interpolateToolResult(String(tool.resultText || tool.text || `${tool.name || "tool"} ok`), args);
      return {
        isError: Boolean(tool.isError),
        content: [{ type: "text", text }],
      };
    },
  })).filter((tool) => tool.name);
}

function interpolateToolResult(text, args) {
  return text.replace(/\{\{\s*args\.([A-Za-z0-9_.-]+)\s*\}\}/g, (_match, key) => {
    const value = getPath(args, key);
    return value == null ? "" : String(value);
  });
}

function canonicalSessionEvent(event) {
  const assistant = event?.assistantMessageEvent;
  if (assistant) {
    return {
      type: "message_update",
      role: event.role || "",
      assistantEventType: assistant.type || "",
      text: assistant.text || assistant.delta || "",
      error: assistant.error || "",
      toolName: assistant.toolCall?.function?.name || "",
      toolCallId: assistant.toolCall?.id || "",
      args: parseArgs(assistant.toolCall?.function?.arguments),
    };
  }
  if (event?.type === "tool_execution_start" || event?.type === "tool_execution_end") {
    return {
      type: event.type,
      toolName: event.toolName || "",
      toolCallId: event.toolCallId || "",
      args: event.args || {},
      isError: event.isError === true,
      resultText: toolResultText(event.result),
    };
  }
  if (event?.type === "message_end") {
    return {
      type: "message_end",
      role: event.role || "",
      content: messageContentText(event.message?.content),
      reasoning: event.message?.reasoning_content || "",
    };
  }
  if (event?.type === "provider_meta") {
    return { type: "provider_meta", meta: event.meta || {} };
  }
  if (event?.type === "tool_progress") {
    return {
      type: "tool_progress",
      name: event.name || "",
      event: event.event || "",
      ok: event.ok,
      summary: event.summary || "",
    };
  }
  return { type: event?.type || "unknown" };
}

function canonicalMessage(message) {
  return {
    role: message?.role || "",
    content: messageContentText(message?.content),
    name: message?.name || "",
    tool_call_id: message?.tool_call_id || "",
    tool_calls: Array.isArray(message?.tool_calls)
      ? message.tool_calls.map((toolCall) => ({
        id: toolCall?.id || "",
        name: toolCall?.function?.name || "",
        args: parseArgs(toolCall?.function?.arguments),
      }))
      : [],
  };
}

function canonicalProviderRequest(request) {
  const body = request.body || {};
  return {
    count: request.count,
    model: body.model || "",
    stream: body.stream === true,
    toolNames: Array.isArray(body.tools)
      ? body.tools.map((tool) => tool?.function?.name || tool?.name || "").filter(Boolean)
      : [],
    messageRoles: Array.isArray(body.messages) ? body.messages.map((message) => message?.role || "") : [],
    lastUserText: lastMessageText(body.messages, "user"),
    lastToolText: lastMessageText(body.messages, "tool"),
  };
}

function lastMessageText(messages, role) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (role && list[i]?.role !== role) continue;
    return messageContentText(list[i]?.content);
  }
  return "";
}

function messageContentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && typeof part.text === "string") return part.text;
      return "";
    }).filter(Boolean).join("\n");
  }
  return "";
}

function toolResultText(result) {
  if (!result) return "";
  if (Array.isArray(result.content)) {
    return result.content.map((part) => part?.text || "").filter(Boolean).join("\n");
  }
  return "";
}

function parseArgs(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return {};
  }
}

function getPath(value, pathKey) {
  let current = value;
  for (const part of String(pathKey || "").split(".").filter(Boolean)) {
    if (current == null) return undefined;
    current = current[part];
  }
  return current;
}

async function runCliProviderTrace(input, context) {
  const provider = await startScriptedOpenAIProvider({
    script: input.providerScript || input.script || [],
    defaultModel: input.model?.id || "scripted-cli-model",
    models: input.models || [],
  });
  context.addCleanup?.(() => provider.close());
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), `lynn-cli-agent-regression-${context.case?.id || "case"}-`.replace(/[^a-z0-9._-]+/gi, "-")));
  context.addCleanup?.(() => fs.rm(dataDir, { recursive: true, force: true }));
  try {
    const args = [
      CLI_BIN,
      "-p",
      String(input.prompt || ""),
      "--json",
      "--no-ink",
      "--brain-url",
      "http://127.0.0.1:1",
      "--data-dir",
      dataDir,
      "--provider",
      input.model?.provider || "openai-compatible",
      "--base-url",
      provider.baseUrl,
      "--api-key",
      input.model?.apiKey || "sk-agent-regression",
      "--model",
      input.model?.id || "scripted-cli-model",
    ];
    const child = await runChild(process.execPath, args, {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        NO_COLOR: "1",
        FORCE_COLOR: "0",
      },
      timeoutMs: Number(input.timeoutMs || 20_000),
    });
    const events = parseJsonLines(child.stdout);
    const assistantText = events
      .filter((event) => event.type === "assistant.delta" && typeof event.text === "string")
      .map((event) => event.text)
      .join("");
    const finished = [...events].reverse().find((event) => event.type === "run.finished") || null;
    const providerRequests = provider.requests.map(canonicalProviderRequest);
    const diagnostics = buildCliDiagnostics({
      events,
      assistantText,
      finished,
      child,
      providerRequests,
    });
    return {
      code: child.code,
      stdout: child.stdout,
      stderr: child.stderr,
      events,
      eventTypes: events.map((event) => event.type),
      assistantText,
      finished,
      diagnostics,
      provider: {
        baseUrl: provider.baseUrl,
        requestCount: provider.requestCount,
        modelProbeCount: provider.modelProbeCount,
        requests: providerRequests,
        lastUserTexts: provider.requests.map((request) => lastMessageText(request.body?.messages, "user")),
      },
    };
  } finally {
    await provider.close();
  }
}

async function runScriptedProviderProbe(input, context) {
  const defaultModel = input.model?.id || input.defaultModel || "scripted-probe-model";
  const provider = await startScriptedOpenAIProvider({
    script: input.providerScript || input.script || [{ content: "probe ok" }],
    defaultModel,
    models: input.models || [defaultModel],
  });
  context.addCleanup?.(() => provider.close());
  try {
    const health = await fetchJson(`${provider.origin}/health`);
    const v1Models = await fetchJson(`${provider.baseUrl}/models`);
    const rootModels = await fetchJson(`${provider.origin}/models`);
    return {
      origin: provider.origin,
      baseUrl: provider.baseUrl,
      health,
      v1Models,
      rootModels,
      modelIds: [
        ...new Set([
          ...modelIds(v1Models),
          ...modelIds(rootModels),
        ]),
      ],
      provider: {
        requestCount: provider.requestCount,
        modelProbeCount: provider.modelProbeCount,
      },
    };
  } finally {
    await provider.close();
  }
}

async function runBrainV2RouteTrace(input, context) {
  const modelId = input.model?.id || "p-fake";
  const provider = await startScriptedOpenAIProvider({
    script: input.providerScript || input.script || [{ content: "brain v2 route ok" }],
    defaultModel: modelId,
    models: input.models || [modelId],
  });
  context.addCleanup?.(() => provider.close());
  try {
    const childInput = {
      routerPath: path.join(REPO_ROOT, "brain-v2-mirror", "router.ts"),
      registryPath: path.join(REPO_ROOT, "brain-v2-mirror", "provider-registry.ts"),
      messages: input.messages || [{ role: "user", content: String(input.prompt || "") }],
      tools: input.tools ?? null,
      capabilityRequired: input.capabilityRequired,
      extraBody: input.extraBody || null,
      reasoningEffort: input.reasoningEffort ?? "low",
    };
    const child = await runChild(process.execPath, [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      brainV2RouteTraceChildSource(),
      Buffer.from(JSON.stringify(childInput), "utf8").toString("base64url"),
    ], {
      cwd: REPO_ROOT,
      env: buildBrainV2RouteTraceEnv(provider, input, modelId),
      timeoutMs: Number(input.timeoutMs || 20_000),
    });
    const childOutput = parseLastJsonLine(child.stdout);
    const providerRequests = provider.requests.map(canonicalProviderRequest);
    const diagnostics = buildBrainV2RouteDiagnostics({
      child,
      childOutput,
      providerRequests,
      modelProbeCount: provider.modelProbeCount,
      expectedPrompt: input.prompt,
    });
    return {
      code: child.code,
      stdout: child.stdout,
      stderr: child.stderr,
      timedOut: child.timedOut === true,
      ...childOutput,
      diagnostics,
      provider: {
        baseUrl: provider.baseUrl,
        requestCount: provider.requestCount,
        modelProbeCount: provider.modelProbeCount,
        requests: providerRequests,
        requestModels: provider.requests.map((request) => request.body?.model || ""),
        lastUserTexts: provider.requests.map((request) => lastMessageText(request.body?.messages, "user")),
        requestToolNames: provider.requests.map((request) => Array.isArray(request.body?.tools)
          ? request.body.tools.map((tool) => tool?.function?.name || tool?.name || "").filter(Boolean)
          : []),
      },
    };
  } finally {
    await provider.close();
  }
}

function buildBrainV2RouteTraceEnv(provider, input, modelId) {
  return {
    ...process.env,
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    BRAIN_V2_ENABLE_P_FAKE: "1",
    BRAIN_V2_REGRESSION_P_FAKE: "1",
    BRAIN_V2_P_FAKE_BASE: provider.baseUrl,
    BRAIN_V2_P_FAKE_KEY: input.model?.apiKey || "none",
    BRAIN_V2_P_FAKE_MODEL: modelId,
    BRAIN_V2_P_FAKE_TIMEOUT_MS: String(input.providerTimeoutMs || 5_000),
    BRAIN_V2_P_FAKE_HEALTH_PROBE_MS: String(input.healthProbeMs || 500),
    BRAIN_V2_DIRECT_KNOWN_OFFICIAL: "0",
    BRAIN_V2_DIRECT_OFFICIAL_MODEL_PREFETCH: "0",
    BRAIN_V2_DIRECT_WEATHER_PREFETCH: "0",
    BRAIN_V2_DIRECT_SPORTS_PREFETCH: "0",
    BRAIN_V2_DIRECT_MARKET_PREFETCH: "0",
    BRAIN_V2_PRE_SEARCH: "0",
    BRAIN_V2_LOCAL_HEALTH_PROBE: input.localHealthProbe === false ? "0" : "1",
  };
}

function brainV2RouteTraceChildSource() {
  return String.raw`
import { pathToFileURL } from "node:url";

const encoded = process.argv.at(-1) || "";
const input = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
const registry = await import(pathToFileURL(input.registryPath).href);
registry.resetCooldownStateForTests?.();
const router = await import(pathToFileURL(input.routerPath).href);

const chunks = [];
const logs = [];
const result = await router.run({
  messages: input.messages || [],
  tools: input.tools ?? null,
  capabilityRequired: input.capabilityRequired,
  extraBody: input.extraBody || null,
  reasoningEffort: input.reasoningEffort ?? null,
  onChunk(chunk, meta) {
    chunks.push(canonicalBrainV2Chunk(chunk, meta));
  },
  log(level, message) {
    logs.push({ level: String(level || ""), message: String(message || "") });
  },
});

const contentText = chunks
  .filter((chunk) => chunk.type === "content")
  .map((chunk) => chunk.delta || "")
  .join("");

console.log(JSON.stringify({
  result: canonicalResult(result),
  chunks,
  chunkTypes: chunks.map((chunk) => chunk.type),
  contentText,
  logs,
  status: registry.getProviderStatusSnapshot(input.capabilityRequired),
  cooldown: registry.getCooldownState(),
}));

function canonicalResult(result) {
  return {
    ok: result?.ok === true,
    providerId: result?.providerId ? String(result.providerId) : null,
    iterations: Number(result?.iterations || 0),
    forwardedToClient: result?.forwardedToClient === true,
    clientToolCalls: Number(result?.clientToolCalls || 0),
    hitMaxIterations: result?.hitMaxIterations === true,
    error: result?.error || "",
  };
}

function canonicalBrainV2Chunk(chunk, meta) {
  return {
    type: chunk?.type || "",
    delta: typeof chunk?.delta === "string" ? chunk.delta : "",
    reason: chunk?.reason || "",
    usage: chunk?.type === "usage" ? chunk.usage ?? null : undefined,
    toolCallNames: Array.isArray(chunk?.delta)
      ? chunk.delta.map((item) => item?.function?.name || "").filter(Boolean)
      : [],
    providerId: meta?.providerId ? String(meta.providerId) : "",
    fallback_from: Array.isArray(meta?.fallback_from)
      ? meta.fallback_from.map((item) => ({
        id: item?.id ? String(item.id) : "",
        reason: item?.reason || "",
      }))
      : [],
  };
}
`;
}

function runChild(command, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1000).unref();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

function parseJsonLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { type: "parse_error", raw: line };
      }
    });
}

function parseLastJsonLine(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // Keep scanning; imported code may print non-JSON diagnostics.
    }
  }
  throw new Error(`No JSON payload found in child stdout: ${String(text || "").slice(0, 500)}`);
}

async function fetchJson(url) {
  const res = await fetch(url);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return {
    ok: res.ok,
    status: res.status,
    json,
    text,
  };
}

function modelIds(response) {
  const data = response?.json?.data;
  return Array.isArray(data) ? data.map((item) => item?.id).filter(Boolean) : [];
}

function buildTraceDiagnostics({ prompts, events, finalTexts, messages, providerRequests }) {
  const assistantEventTypes = events.map((event) => event.assistantEventType).filter(Boolean);
  const eventTypes = events.map((event) => event.type);
  const promptTexts = (Array.isArray(prompts) ? prompts : []).map(String);
  const lastUserTexts = providerRequests.map((request) => request.lastUserText || "");
  const finalNonEmpty = finalTexts.filter((text) => String(text || "").trim()).length;
  const finalEmpty = finalTexts.length - finalNonEmpty;
  const staleEchoes = finalTexts.map((text, index) => {
    const priorPrompts = promptTexts.slice(0, index).filter(Boolean);
    return priorPrompts.filter((prompt) => String(text || "").includes(prompt));
  });
  return {
    promptCount: promptTexts.length,
    providerRequestCount: providerRequests.length,
    messageEndCount: eventTypes.filter((type) => type === "message_end").length,
    agentEndCount: eventTypes.filter((type) => type === "agent_end").length,
    textDeltaCount: assistantEventTypes.filter((type) => type === "text_delta").length,
    thinkingDeltaCount: assistantEventTypes.filter((type) => type === "thinking_delta").length,
    toolStartCount: eventTypes.filter((type) => type === "tool_execution_start").length,
    toolEndCount: eventTypes.filter((type) => type === "tool_execution_end").length,
    toolResultHandoffCount: providerRequests.filter((request) => request.lastToolText).length,
    visibleAnswerCount: finalNonEmpty,
    emptyFinalCount: finalEmpty,
    reasoningOnlyFallbackCount: finalTexts.filter((text) => /模型这次没有返回可见内容/.test(String(text || ""))).length,
    turnClosed: eventTypes.filter((type) => type === "agent_end").length === promptTexts.length,
    lastUserTexts,
    latestUserText: lastUserTexts.at(-1) || "",
    staleEchoes,
    staleEchoCount: staleEchoes.reduce((sum, items) => sum + items.length, 0),
    sessionMessageRoles: (messages || []).map((message) => message?.role || ""),
  };
}

function buildCliDiagnostics({ events, assistantText, finished, child, providerRequests }) {
  const parseErrors = events.filter((event) => event.type === "parse_error");
  return {
    exitCode: child.code,
    timedOut: child.timedOut === true,
    parseErrorCount: parseErrors.length,
    providerRequestCount: providerRequests.length,
    assistantDeltaCount: events.filter((event) => event.type === "assistant.delta").length,
    providerEventCount: events.filter((event) => event.type === "provider").length,
    runFinishedCount: events.filter((event) => event.type === "run.finished").length,
    finishedOk: finished?.ok === true,
    visibleAnswerNonEmpty: String(assistantText || "").trim().length > 0,
    lastUserTexts: providerRequests.map((request) => request.lastUserText || ""),
  };
}

function buildBrainV2RouteDiagnostics({ child, childOutput, providerRequests, modelProbeCount, expectedPrompt }) {
  const chunks = Array.isArray(childOutput?.chunks) ? childOutput.chunks : [];
  const statusRoute = Array.isArray(childOutput?.status?.route) ? childOutput.status.route : [];
  const providerIds = [...new Set(chunks.map((chunk) => chunk.providerId).filter(Boolean))];
  const contentText = String(childOutput?.contentText || "");
  return {
    exitCode: child.code,
    timedOut: child.timedOut === true,
    providerRequestCount: providerRequests.length,
    modelProbeCountObserved: Number(modelProbeCount || 0),
    routeHead: statusRoute[0] || "",
    routeIncludesPFake: statusRoute.includes("p-fake"),
    usedProviderIds: providerIds,
    usedPFake: providerIds.includes("p-fake") || childOutput?.result?.providerId === "p-fake",
    contentChunkCount: chunks.filter((chunk) => chunk.type === "content").length,
    finishChunkCount: chunks.filter((chunk) => chunk.type === "finish").length,
    visibleAnswerNonEmpty: contentText.trim().length > 0,
    fallbackCount: chunks.reduce((sum, chunk) => sum + (Array.isArray(chunk.fallback_from) ? chunk.fallback_from.length : 0), 0),
    lastUserTexts: providerRequests.map((request) => request.lastUserText || ""),
    latestUserText: providerRequests.at(-1)?.lastUserText || "",
    expectedPromptSeen: expectedPrompt ? providerRequests.some((request) => request.lastUserText.includes(String(expectedPrompt))) : true,
  };
}
