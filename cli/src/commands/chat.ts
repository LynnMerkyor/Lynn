import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { getStringFlag, hasFlag, type ParsedArgs } from "../args.js";
import { streamBrainChat, type BrainStreamEvent, type ChatMessage } from "../brain-client.js";
import { parseReasoningOptions, shouldRenderReasoning } from "../reasoning.js";

export async function runChat(args: ParsedArgs): Promise<number> {
  const mockBrain = hasFlag(args.flags, "mock-brain", "mock");
  const brainUrl = getStringFlag(args.flags, "brain-url") || process.env.LYNN_BRAIN_URL || "http://127.0.0.1:8790";
  const reasoning = parseReasoningOptions(args);
  const messages: ChatMessage[] = [];
  const rl = readline.createInterface({ input, output, terminal: true });

  output.write("Lynn chat. Type /exit to leave, /clear to reset context.\n\n");
  try {
    for (;;) {
      const text = (await rl.question("> ")).trim();
      if (!text) continue;
      if (text === "/exit" || text === "/quit") break;
      if (text === "/help") {
        output.write("/exit leave chat\n/clear reset context\n/help show commands\n\n");
        continue;
      }
      if (text === "/clear") {
        messages.length = 0;
        output.write("Context cleared.\n\n");
        continue;
      }

      messages.push({ role: "user", content: text });
      if (mockBrain) {
        const answer = `Mock Lynn response: ${text}`;
        messages.push({ role: "assistant", content: answer });
        output.write(`${answer}\n\n`);
        continue;
      }

      let assistant = "";
      try {
        for await (const event of streamBrainChat({ brainUrl, messages, reasoning })) {
          if (renderChatEvent(event, shouldRenderReasoning(reasoning.display, false))) {
            assistant += event.text;
          }
        }
      } catch (error) {
        messages.pop();
        const message = error instanceof Error ? error.message : String(error);
        output.write(`\nLynn error: ${message}\n\n`);
        continue;
      }
      messages.push({ role: "assistant", content: assistant });
      output.write("\n\n");
    }
  } finally {
    rl.close();
  }
  return 0;
}

function renderChatEvent(event: BrainStreamEvent, renderReasoning: boolean): event is { type: "assistant.delta"; text: string } {
  if (event.type === "assistant.delta") {
    output.write(event.text);
    return true;
  }
  if (event.type === "reasoning.delta" && renderReasoning) {
    process.stderr.write(event.text);
  }
  return false;
}
