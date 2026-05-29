import { getStringFlag, hasFlag, type ParsedArgs } from "../args.js";
import { streamBrainChat, type BrainStreamEvent } from "../brain-client.js";
import { nowIso, writeJsonLine } from "../jsonl.js";
import { parseReasoningOptions, shouldRenderReasoning } from "../reasoning.js";
import { appendSessionTurn, resolveDataDir } from "../session/store.js";

export interface PromptOptions {
  json?: boolean;
  mockBrain?: boolean;
}

export function resolvePrompt(args: ParsedArgs): string {
  return getStringFlag(args.flags, "p", "print", "prompt") || args.positionals.join(" ").trim();
}

export async function runPrompt(args: ParsedArgs, options: PromptOptions = {}): Promise<number> {
  const prompt = resolvePrompt(args);
  if (!prompt) {
    throw new Error("prompt is required");
  }
  const reasoning = parseReasoningOptions(args);
  const brainUrl = getStringFlag(args.flags, "brain-url") || process.env.LYNN_BRAIN_URL || "http://127.0.0.1:8790";
  const saveSession = hasFlag(args.flags, "save-session", "session") || !!process.env.LYNN_CLI_SAVE_SESSION;
  const sessionPath = getStringFlag(args.flags, "session");
  const dataDir = resolveDataDir(getStringFlag(args.flags, "data-dir"));
  const title = getStringFlag(args.flags, "title");

  if (options.json) {
    writeJsonLine({ type: "run.started", ts: nowIso(), prompt, reasoning });
  }

  if (options.mockBrain) {
    const text = `Mock Lynn response: ${prompt}`;
    if (options.json) {
      writeJsonLine({ type: "assistant.delta", ts: nowIso(), text });
      writeJsonLine({ type: "run.finished", ts: nowIso(), ok: true });
    } else {
      process.stdout.write(`${text}\n`);
    }
    if (saveSession) {
      const savedPath = await appendSessionTurn({ dataDir, sessionPath, cwd: process.cwd(), title, prompt, assistant: text, modelProvider: "mock", modelId: "mock-brain" });
      if (options.json) writeJsonLine({ type: "session.saved", ts: nowIso(), path: savedPath });
    }
    return 0;
  }

  let assistant = "";
  let sawReasoning = false;
  for await (const event of streamBrainChat({ brainUrl, prompt, reasoning })) {
    handleBrainEvent(event, {
      json: !!options.json,
      renderReasoning: shouldRenderReasoning(reasoning.display, !!options.json),
    });
    if (event.type === "reasoning.delta") sawReasoning = true;
    if (event.type === "assistant.delta") assistant += event.text;
  }
  if (saveSession) {
    const savedPath = await appendSessionTurn({ dataDir, sessionPath, cwd: process.cwd(), title, prompt, assistant, modelProvider: "brain", modelId: "lynn-brain-router" });
    if (options.json) writeJsonLine({ type: "session.saved", ts: nowIso(), path: savedPath });
  }
  if (options.json) {
    writeJsonLine({ type: "run.finished", ts: nowIso(), ok: true, reasoningReturned: sawReasoning });
  } else {
    process.stdout.write("\n");
  }
  return 0;
}

function handleBrainEvent(event: BrainStreamEvent, opts: { json: boolean; renderReasoning: boolean }): void {
  if (opts.json) {
    if (event.type === "assistant.delta" || event.type === "reasoning.delta") {
      writeJsonLine({ ...event, ts: nowIso() });
    } else if (event.type === "usage") {
      writeJsonLine({ type: "usage", ts: nowIso(), usage: event.usage });
    }
    return;
  }

  if (event.type === "assistant.delta") {
    process.stdout.write(event.text);
  } else if (event.type === "reasoning.delta" && opts.renderReasoning) {
    process.stderr.write(event.text);
  }
}
