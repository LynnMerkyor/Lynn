import { brainToolEvidenceMessages } from "../../shared/brain-tool-evidence.js";
import { type BrainStreamEvent, type ChatMessage } from "./brain-client.js";
import { formatBrainErrorForHuman, renderBrainEventForHuman, summarizeUsage, thinkingStatusLabel, type HumanBrainRenderState } from "./brain-render.js";
import { streamBrainTurn, type BrainTurnEvent } from "./brain-turn-stream.js";
import type { CodeAgentEvent } from "./code-agent-loop-types.js";
import { RESUME_REPAIR_NOTE } from "./code-resume.js";
import { codeToolDefinitions, parseCodeToolRequests, toolRequestFingerprint, toolRequestsFromCollectedCalls, type CodeToolRequest, type CollectedToolCall } from "./code-tool-protocol.js";
import { t } from "./i18n.js";
import { nowIso, writeJsonLine } from "./jsonl.js";
import { isSafeReadOnlyShellCommand } from "./local-command.js";
import type { CliProviderProfile } from "./provider-profile.js";
import { parseReasoningOptions, shouldRenderReasoning } from "./reasoning.js";
import { TerminalSpinner } from "./terminal-spinner.js";
import { dim, supportsColor } from "./terminal-style.js";
import { isMetaTool, isReadOnlyTool } from "./tool-scheduler.js";
import type { ClientToolName } from "./tools/types.js";


interface ClientToolStormState {
  recent: Array<{ fingerprint: string; readOnly: boolean }>;
}


interface ClientToolStormVerdict {
  suppress: boolean;
  repeatCount: number;
}


interface BrainTextResult {
  text: string;
  usageSummary: string | null;
  usageRecords: Array<{ usage: unknown; durationMs: number }>;
  toolCalls: CollectedToolCall[];
}


interface TurnForwarderContext {
  json: boolean;
  onEvent?: (event: CodeAgentEvent) => void;
  reasoning: ReturnType<typeof parseReasoningOptions>;
  spinner: TerminalSpinner;
  renderState: HumanBrainRenderState;
  startedAt: number;
  onText: (text: string) => void;
  onUsage: (usage: unknown, durationMs: number) => void;
  onEvidence: (event: Extract<BrainStreamEvent, { type: "tool_progress" }>) => void;
}

const TOOL_STORM_WINDOW = 8;


const EVIDENCE_RECOVERY_PROMPT = "请基于上文完整工具结果回答原问题，不再调用工具。自行判断相关性，区分事实、预测与证据不足，忽略无关搜索噪声，不得编造或复述工具日志。";
export function createClientToolStormState(seedMessages: readonly ChatMessage[] = []): ClientToolStormState {
  const state: ClientToolStormState = { recent: [] };
  seedClientToolStormState(state, seedMessages);
  return state;
}


export function observeClientToolRequest(state: ClientToolStormState, request: CodeToolRequest): ClientToolStormVerdict {
  if (isMetaTool(request.tool)) return { suppress: false, repeatCount: 1 };
  const fingerprint = toolRequestFingerprint(request);
  const previous = state.recent.filter((entry) => entry.fingerprint === fingerprint).length;
  if (previous > 0) {
    return { suppress: true, repeatCount: previous + 1 };
  }
  rememberClientToolRequest(state, request);
  return { suppress: false, repeatCount: 1 };
}


export function rememberClientToolRequest(state: ClientToolStormState, request: CodeToolRequest): void {
  if (isMetaTool(request.tool)) return;
  const readOnly = isReadOnlyTool(request.tool);
  if (!readOnly) {
    state.recent = state.recent.filter((entry) => !entry.readOnly);
  }
  state.recent.push({ fingerprint: toolRequestFingerprint(request), readOnly });
  if (state.recent.length > TOOL_STORM_WINDOW) {
    state.recent.splice(0, state.recent.length - TOOL_STORM_WINDOW);
  }
}


export function seedClientToolStormState(state: ClientToolStormState, messages: readonly ChatMessage[]): void {
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (message.role === "assistant" && message.tool_calls?.length) {
      const completedToolCallIds = completedToolCallsAfter(messages, i);
      const completedCalls = message.tool_calls
        .filter((toolCall) => completedToolCallIds.has(toolCall.id))
        .map((toolCall) => ({
          id: toolCall.id,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        }));
      for (const request of toolRequestsFromCollectedCalls(completedCalls, -1)) {
        rememberClientToolRequest(state, request);
      }
      continue;
    }
    if (message.role !== "assistant" || typeof message.content !== "string") continue;
    const next = messages[i + 1];
    if (next?.role !== "user" || typeof next.content !== "string") continue;
    if (!next.content.includes("Tool result") || next.content.includes(RESUME_REPAIR_NOTE)) continue;
    for (const request of parseCodeToolRequests(message.content)) {
      rememberClientToolRequest(state, request);
    }
  }
}


export function completedToolCallsAfter(messages: readonly ChatMessage[], assistantIndex: number): Set<string> {
  const completed = new Set<string>();
  const assistant = messages[assistantIndex];
  const required = new Set(assistant?.role === "assistant" ? assistant.tool_calls?.map((toolCall) => toolCall.id) || [] : []);
  for (let i = assistantIndex + 1; i < messages.length && required.size > 0; i += 1) {
    const candidate = messages[i];
    if (candidate.role !== "tool" || !candidate.tool_call_id || !required.has(candidate.tool_call_id)) break;
    if (typeof candidate.content === "string" && candidate.content.includes(RESUME_REPAIR_NOTE)) break;
    completed.add(candidate.tool_call_id);
    required.delete(candidate.tool_call_id);
  }
  return completed;
}



/** Why a tool is unavailable in plan mode, or null when it is allowed. */
export function planModeBlockedReason(
  planMode: boolean | undefined,
  tool: ClientToolName,
  args: CodeToolRequest["args"],
): string | null {
  if (!planMode) return null;
  if (tool === "update_plan" || tool === "exit_plan_mode" || tool === "update_working_checkpoint") return null;
  if (isReadOnlyTool(tool)) return null;
  if (tool === "bash") {
    return isSafeReadOnlyShellCommand(String(args.command || ""))
      ? null
      : "plan mode: only read-only shell commands are allowed. Present a plan with exit_plan_mode first.";
  }
  return `plan mode: ${tool} is disabled until the plan is approved. Explore read-only, then call exit_plan_mode.`;
}

export function evidenceMessageFromToolProgress(event: Extract<BrainStreamEvent, { type: "tool_progress" }>): ChatMessage | null {
  if (event.event !== "end" || event.ok === false) return null;
  const content = [
    event.summary,
    ...(Array.isArray(event.details) ? event.details : []),
  ].filter((line): line is string => typeof line === "string" && !!line.trim()).join("\n");
  if (!content.trim()) return null;
  return { role: "tool", name: event.name, content };
}


export function createTurnForwarder(ctx: TurnForwarderContext): (event: BrainTurnEvent) => void {
  const renderReasoning = shouldRenderReasoning(ctx.reasoning.display, ctx.json);
  const structured = ctx.json || !!ctx.onEvent;
  return (event) => {
    switch (event.type) {
      case "text":
        if (!structured) ctx.spinner.stop();
        ctx.onText(event.text);
        ctx.onEvent?.({ type: "assistant.delta", text: event.text });
        return;
      case "reasoning":
        if (!renderReasoning) return;
        if (!structured) ctx.spinner.stop();
        ctx.onEvent?.({ type: "reasoning.delta", text: event.text });
        if (ctx.json) writeJsonLine({ type: "reasoning.delta", ts: nowIso(), text: event.text, hidden: true });
        else if (!ctx.onEvent) process.stderr.write(dim(event.text, supportsColor(process.stderr)));
        return;
      case "provider": {
        const providerEvent: BrainStreamEvent = { type: "provider", activeProvider: event.provider };
        ctx.onEvent?.({ type: "provider", provider: event.provider });
        if (ctx.json) writeJsonLine({ type: "provider", ts: nowIso(), activeProvider: event.provider });
        if (!structured) {
          renderBrainEventForHuman(providerEvent, ctx.renderState, process.stderr);
          if (shouldResumeWaitingSpinner(providerEvent)) ctx.spinner.start();
        }
        return;
      }
      case "tool_progress":
        ctx.onEvidence(event.event);
        ctx.onEvent?.({ type: "tool.progress", message: [event.event.name, event.event.event].filter(Boolean).join(" ") });
        if (ctx.json) writeJsonLine({ ts: nowIso(), ...event.event });
        if (!structured) {
          renderBrainEventForHuman(event.event, ctx.renderState, process.stderr);
          if (shouldResumeWaitingSpinner(event.event)) ctx.spinner.start();
        }
        return;
      case "usage":
        if (!structured) ctx.spinner.stop();
        ctx.onUsage(event.usage, Date.now() - ctx.startedAt);
        return;
      default:
        return;
    }
  };
}


export async function collectBrainText(inputData: {
  brainUrl: string;
  fallbackProvider?: CliProviderProfile;
  messages: ChatMessage[];
  reasoning: ReturnType<typeof parseReasoningOptions>;
  json: boolean;
  label: string;
  danger?: boolean;
  noTools?: boolean;
  onEvent?: (event: CodeAgentEvent) => void;
  signal?: AbortSignal;
}): Promise<BrainTextResult> {
  let text = "";
  let usageSummary: string | null = null;
  const usageRecords: Array<{ usage: unknown; durationMs: number }> = [];
  const toolCalls: CollectedToolCall[] = [];
  const brainEvidenceMessages: ChatMessage[] = [];
  const spinner = new TerminalSpinner(process.stderr, inputData.label, { danger: inputData.danger });
  const renderState: HumanBrainRenderState = {};
  const startedAt = Date.now();
  const recoverModelAnswer = async (): Promise<BrainTextResult | null> => {
    const messages = [...inputData.messages, ...brainEvidenceMessages];
    if (inputData.noTools || inputData.signal?.aborted || text.trim() || toolCalls.length
      || !messages.some((message) => message.role === "tool")) return null;
    const recovered = await collectBrainText({
      ...inputData,
      messages: [...messages, {
        role: "user",
        content: "请基于上文完整工具结果回答原问题，不再调用工具。自行判断相关性，区分事实、预测与证据不足，忽略无关搜索噪声，不得编造或复述工具日志。",
      }],
      noTools: true,
    });
    if (!recovered.text.trim() || recovered.toolCalls.length) throw new Error("模型未能根据工具结果生成最终答案，请重试。");
    return { ...recovered, usageRecords: [...usageRecords, ...recovered.usageRecords] };
  };

  const forward = createTurnForwarder({
    json: inputData.json,
    onEvent: inputData.onEvent,
    reasoning: inputData.reasoning,
    spinner,
    renderState,
    startedAt,
    onText: (chunk) => { text += chunk; },
    onUsage: (usage, durationMs) => {
      usageRecords.push({ usage, durationMs });
      const summary = summarizeUsage(usage, { durationMs });
      usageSummary = summary || usageSummary;
      if (summary) inputData.onEvent?.({ type: "usage", summary });
      if (inputData.json) writeJsonLine({ type: "usage", ts: nowIso(), usage, durationMs });
      if (!inputData.json && !inputData.onEvent) {
        const waitingLabel = thinkingStatusLabel(usage, startedAt);
        if (waitingLabel) spinner.setLabel(waitingLabel);
      }
    },
    onEvidence: (event) => {
      const evidenceMessages = brainToolEvidenceMessages(event);
      if (evidenceMessages.length) {
        inputData.messages.push(...evidenceMessages);
      } else {
        const evidenceMessage = evidenceMessageFromToolProgress(event);
        if (evidenceMessage) brainEvidenceMessages.push(evidenceMessage);
      }
    },
  });

  if (!inputData.json && !inputData.onEvent) spinner.start();
  let streamError: Error | null = null;
  try {
    for await (const event of streamBrainTurn({
      brainUrl: inputData.brainUrl,
      fallbackProvider: inputData.fallbackProvider,
      messages: inputData.messages,
      reasoning: inputData.reasoning,
      tools: inputData.noTools ? undefined : codeToolDefinitions(),
      noTools: inputData.noTools,
      signal: inputData.signal,
    })) {
      if (event.type === "tool_call") {
        toolCalls.push(event.call);
        continue;
      }
      if (event.type === "error") {
        streamError = new Error(formatBrainErrorForHuman(event.error.error, event.error.code));
        continue;
      }
      if (event.type === "done") continue;
      forward(event);
    }
  } catch (error) {
    streamError = error instanceof Error ? error : new Error(String(error));
  } finally {
    spinner.stop();
  }

  if (streamError) {
    const recovered = await recoverModelAnswer();
    if (recovered) return recovered;
    throw streamError;
  }
  const recovered = await recoverModelAnswer();
  if (recovered) return recovered;
  return { text, usageSummary, usageRecords, toolCalls };
}


export async function recoverAnswerFromEvidence(input: {
  brainUrl: string;
  fallbackProvider?: CliProviderProfile;
  messages: ChatMessage[];
  reasoning: ReturnType<typeof parseReasoningOptions>;
  json: boolean;
  signal?: AbortSignal;
}): Promise<BrainTextResult | null> {
  if (input.signal?.aborted) return null;
  if (!input.messages.some((message) => message.role === "tool")) return null;
  const recovered = await collectBrainText({
    brainUrl: input.brainUrl,
    fallbackProvider: input.fallbackProvider,
    messages: [...input.messages, { role: "user", content: EVIDENCE_RECOVERY_PROMPT }],
    reasoning: input.reasoning,
    json: input.json,
    label: t("spinner.coding"),
    noTools: true,
    signal: input.signal,
  });
  if (!recovered.text.trim() || recovered.toolCalls.length) throw new Error("模型未能根据工具结果生成最终答案，请重试。");
  return recovered;
}


export function shouldResumeWaitingSpinner(event: BrainStreamEvent): boolean {
  return event.type === "provider" || event.type === "tool_progress";
}


export function eventWritesHumanOutput(event: BrainStreamEvent, renderReasoning: boolean, structuredOutput: boolean): boolean {
  if (structuredOutput) return false;
  return event.type === "assistant.delta"
    || event.type === "provider"
    || event.type === "tool_progress"
    || event.type === "brain.error"
    || event.type === "usage"
    || (event.type === "reasoning.delta" && renderReasoning);
}
