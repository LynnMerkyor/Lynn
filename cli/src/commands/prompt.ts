import { getStringFlag, type ParsedArgs } from "../args.js";
import { nowIso, writeJsonLine } from "../jsonl.js";

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

  if (options.json) {
    writeJsonLine({ type: "run.started", ts: nowIso(), prompt });
  }

  if (options.mockBrain) {
    const text = `Mock Lynn response: ${prompt}`;
    if (options.json) {
      writeJsonLine({ type: "assistant.delta", ts: nowIso(), text });
      writeJsonLine({ type: "run.finished", ts: nowIso(), ok: true });
    } else {
      process.stdout.write(`${text}\n`);
    }
    return 0;
  }

  throw new Error("Brain streaming is not implemented yet; use --mock-brain for scaffold smoke tests");
}
