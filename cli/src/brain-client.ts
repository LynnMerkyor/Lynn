import { applyReasoningToBody, type ReasoningOptions } from "./reasoning.js";

export interface BrainChatRequest {
  brainUrl: string;
  prompt?: string;
  messages?: ChatMessage[];
  reasoning: ReasoningOptions;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type BrainStreamEvent =
  | { type: "assistant.delta"; text: string }
  | { type: "reasoning.delta"; text: string; hidden?: boolean }
  | { type: "provider"; activeProvider: string; fallbackFrom?: Array<{ id: string; reason?: string }> }
  | { type: "tool_progress"; event: string; name: string; ms?: number; ok?: boolean }
  | { type: "brain.error"; error: string; code?: string }
  | { type: "usage"; usage: unknown }
  | { type: "done"; finishReason?: string | null };

export class BrainConnectionError extends Error {
  readonly brainUrl: string;

  constructor(brainUrl: string, cause: unknown) {
    super(formatBrainConnectionError(brainUrl, cause));
    this.name = "BrainConnectionError";
    this.brainUrl = brainUrl;
  }
}

export function formatBrainRecoveryHint(error: unknown): string {
  if (error instanceof BrainConnectionError) {
    return `Brain offline. Start Lynn GUI, or run with --mock-brain.`;
  }
  return error instanceof Error ? error.message : String(error);
}

export async function checkBrainReachable(brainUrl: string, timeoutMs = 350): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(new URL("/health", brainUrl), {
      method: "GET",
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function parseSsePayloads(chunk: string): string[] {
  const payloads: string[] = [];
  for (const block of chunk.split(/\n\n+/)) {
    const dataLines = block
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());
    if (dataLines.length) payloads.push(dataLines.join("\n"));
  }
  return payloads;
}

export function parseBrainStreamPayload(payload: string): BrainStreamEvent[] {
  if (!payload || payload === "[DONE]") return [{ type: "done" }];
  const parsed = JSON.parse(payload) as {
    object?: string;
    meta?: { active_provider?: unknown; fallback_from?: unknown };
    tool_progress?: { event?: unknown; name?: unknown; ms?: unknown; ok?: unknown };
    error?: unknown;
    code?: unknown;
    choices?: Array<{
      delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown };
      finish_reason?: string | null;
    }>;
    usage?: unknown;
  };
  const events: BrainStreamEvent[] = [];
  if (parsed.object === "lynn.provider") {
    const activeProvider = typeof parsed.meta?.active_provider === "string" ? parsed.meta.active_provider : "";
    const fallbackFrom = Array.isArray(parsed.meta?.fallback_from)
      ? parsed.meta.fallback_from
          .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
          .map((entry) => ({
            id: typeof entry.id === "string" ? entry.id : "",
            reason: typeof entry.reason === "string" ? entry.reason : undefined,
          }))
          .filter((entry) => entry.id)
      : undefined;
    if (activeProvider) events.push({ type: "provider", activeProvider, fallbackFrom });
  }
  if (parsed.object === "lynn.tool_progress") {
    const progress = parsed.tool_progress || {};
    const event = typeof progress.event === "string" ? progress.event : "";
    const name = typeof progress.name === "string" ? progress.name : "";
    if (event && name) {
      events.push({
        type: "tool_progress",
        event,
        name,
        ms: typeof progress.ms === "number" ? progress.ms : undefined,
        ok: typeof progress.ok === "boolean" ? progress.ok : undefined,
      });
    }
  }
  if (parsed.object === "lynn.error") {
    events.push({
      type: "brain.error",
      error: typeof parsed.error === "string" ? parsed.error : "Brain returned an error",
      code: typeof parsed.code === "string" ? parsed.code : undefined,
    });
  }
  for (const choice of parsed.choices || []) {
    const delta = choice.delta || {};
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
      events.push({ type: "reasoning.delta", text: delta.reasoning_content, hidden: true });
    } else if (typeof delta.reasoning === "string" && delta.reasoning) {
      events.push({ type: "reasoning.delta", text: delta.reasoning, hidden: true });
    }
    if (typeof delta.content === "string" && delta.content) {
      events.push({ type: "assistant.delta", text: delta.content });
    }
    if (choice.finish_reason) {
      events.push({ type: "done", finishReason: choice.finish_reason });
    }
  }
  if (parsed.usage) events.push({ type: "usage", usage: parsed.usage });
  return events;
}

export async function* streamBrainChat(request: BrainChatRequest): AsyncGenerator<BrainStreamEvent> {
  const messages = request.messages || (request.prompt ? [{ role: "user" as const, content: request.prompt }] : []);
  if (!messages.length) {
    throw new Error("Brain request requires a prompt or messages");
  }
  const body = applyReasoningToBody({
    model: "lynn-brain-router",
    stream: true,
    messages,
  }, request.reasoning);

  let response: Response;
  try {
    response = await fetch(new URL("/v1/chat/completions", request.brainUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new BrainConnectionError(request.brainUrl, error);
  }
  if (!response.ok || !response.body) {
    throw new Error(`Brain request failed: ${response.status} ${response.statusText}`.trim());
  }

  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    const split = buffer.split(/\n\n+/);
    buffer = split.pop() || "";
    for (const block of split) {
      for (const payload of parseSsePayloads(`${block}\n\n`)) {
        for (const event of parseBrainStreamPayload(payload)) yield event;
      }
    }
  }

  buffer += decoder.decode();
  for (const payload of parseSsePayloads(buffer)) {
    for (const event of parseBrainStreamPayload(payload)) yield event;
  }
}

function formatBrainConnectionError(brainUrl: string, error: unknown): string {
  const detail = error instanceof Error && error.message ? ` (${error.message})` : "";
  return [
    `Could not reach Lynn Brain at ${brainUrl}${detail}.`,
    "Start the Lynn GUI so the local Brain/router is running, or pass --brain-url to another compatible endpoint.",
    "For CLI-only smoke tests, use --mock-brain.",
  ].join(" ");
}
