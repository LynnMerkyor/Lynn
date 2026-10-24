/**
 * brain-turn-stream.ts — one model turn as a stream of semantic events.
 *
 * The raw provider stream only tells us "some argument characters arrived". The
 * agent loop needs a stronger signal: "this tool call is complete, you can start
 * running it now". This module owns that transition. It is the single place that
 * knows how to:
 *
 *   - accumulate tool-call deltas by index;
 *   - decide when a call's arguments form valid JSON (so it can execute before
 *     the model has finished the turn);
 *   - flush everything that is left when the stream ends.
 *
 * Consumers (the main loop, the compaction/self-verify helper) get `tool_call`
 * events as early as possible, which is what makes streaming tool execution
 * possible without a second protocol.
 */
import { streamBrainChat, type ChatMessage, type ChatToolDefinition } from "./brain-client.js";
import type { BrainStreamEvent } from "./brain-client.js";
import { createStreamingToolCallAccumulator, type CollectedToolCall } from "./code-tool-protocol.js";
import type { CliProviderProfile } from "./provider-profile.js";
import type { ReasoningOptions } from "./reasoning.js";

export type BrainTurnEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string; hidden?: boolean }
  | { type: "tool_call"; index: number; call: CollectedToolCall }
  | { type: "provider"; provider: string }
  | { type: "tool_progress"; event: Extract<BrainStreamEvent, { type: "tool_progress" }> }
  | { type: "usage"; usage: unknown }
  | { type: "error"; error: Extract<BrainStreamEvent, { type: "brain.error" }> }
  | { type: "done" };

export interface BrainTurnRequest {
  brainUrl: string;
  fallbackProvider?: CliProviderProfile | null;
  messages: ChatMessage[];
  reasoning: ReasoningOptions;
  tools?: ChatToolDefinition[];
  noTools?: boolean;
  signal?: AbortSignal;
}

/**
 * True when the accumulated arguments are valid JSON for a tool call.
 * Empty arguments are not treated as complete here: they are flushed when the
 * stream ends (or when another call starts), because a provider may still append
 * characters to an empty string.
 */
export function isToolCallArgumentsComplete(call: CollectedToolCall | undefined): boolean {
  if (!call?.name) return false;
  const args = (call.arguments || "").trim();
  if (!args) return false;
  try {
    const parsed: unknown = JSON.parse(args);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

export async function* streamBrainTurn(request: BrainTurnRequest): AsyncGenerator<BrainTurnEvent> {
  const accumulator = createStreamingToolCallAccumulator();
  const emitted = new Set<number>();
  let failure: unknown = null;

  const emitReady = (index: number, force: boolean): BrainTurnEvent | null => {
    if (emitted.has(index)) return null;
    const call = accumulator.get(index);
    if (!call?.name) return null;
    if (!force && !isToolCallArgumentsComplete(call)) return null;
    emitted.add(index);
    return {
      type: "tool_call",
      index,
      call: { ...call, arguments: call.arguments || "{}" },
    };
  };

  try {
    for await (const event of streamBrainChat({
      brainUrl: request.brainUrl,
      fallbackProvider: request.fallbackProvider ?? undefined,
      reasoning: request.reasoning,
      messages: request.messages,
      tools: request.noTools ? undefined : request.tools,
      toolChoice: request.noTools ? "none" : undefined,
      signal: request.signal,
    })) {
      switch (event.type) {
        case "assistant.delta":
          yield { type: "text", text: event.text };
          break;
        case "reasoning.delta":
          yield { type: "reasoning", text: event.text, ...(event.hidden ? { hidden: true } : {}) };
          break;
        case "tool_call.delta": {
          accumulator.append(event);
          for (const index of accumulator.indexes().sort((left, right) => left - right)) {
            if (emitted.has(index)) continue;
            const ready = emitReady(index, false);
            if (!ready) break;
            if (ready) yield ready;
          }
          break;
        }
        case "provider":
          yield { type: "provider", provider: event.activeProvider };
          break;
        case "tool_progress":
          yield { type: "tool_progress", event };
          break;
        case "usage":
          yield { type: "usage", usage: event.usage };
          break;
        case "brain.error":
          yield { type: "error", error: event };
          return;
        default:
          break;
      }
    }
  } catch (error) {
    failure = error;
  }

  if (failure) throw failure;
  request.signal?.throwIfAborted();
  for (const index of accumulator.indexes().sort((left, right) => left - right)) {
    const ready = emitReady(index, true);
    if (ready) yield ready;
  }
  yield { type: "done" };
}
