import { applyReasoningToBody, type ReasoningOptions } from "./reasoning.js";

export interface BrainChatRequest {
  brainUrl: string;
  prompt: string;
  reasoning: ReasoningOptions;
}

export type BrainStreamEvent =
  | { type: "assistant.delta"; text: string }
  | { type: "reasoning.delta"; text: string; hidden?: boolean }
  | { type: "usage"; usage: unknown }
  | { type: "done"; finishReason?: string | null };

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
    choices?: Array<{
      delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown };
      finish_reason?: string | null;
    }>;
    usage?: unknown;
  };
  const events: BrainStreamEvent[] = [];
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
  const body = applyReasoningToBody({
    model: "lynn-brain-router",
    stream: true,
    messages: [{ role: "user", content: request.prompt }],
  }, request.reasoning);

  const response = await fetch(new URL("/v1/chat/completions", request.brainUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
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
