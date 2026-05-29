import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { getStringFlag, hasFlag, type ParsedArgs } from "../args.js";
import { BrainConnectionError, streamBrainChat, type BrainStreamEvent, type ChatMessage } from "../brain-client.js";
import { renderProvidersInfo, resolveProvidersInfo } from "./providers.js";
import { parseReasoningOptions, shouldRenderReasoning } from "../reasoning.js";
import { TerminalSpinner } from "../terminal-spinner.js";

export async function runChat(args: ParsedArgs, options: { intro?: boolean; brainReachable?: boolean } = {}): Promise<number> {
  const mockBrain = hasFlag(args.flags, "mock-brain", "mock");
  const brainUrl = getStringFlag(args.flags, "brain-url") || process.env.LYNN_BRAIN_URL || "http://127.0.0.1:8790";
  const reasoning = parseReasoningOptions(args);
  const mode = resolveMode(args);
  const messages: ChatMessage[] = [];
  const rl = readline.createInterface({ input, output, terminal: input.isTTY && output.isTTY });

  if (options.intro !== false) {
    output.write(`Lynn chat. Type /exit to leave, /clear to reset context, /model to review route, /mode to review permissions.\nmode: ${renderMode(mode)}\n\n`);
  } else if (options.brainReachable === false && !mockBrain) {
    output.write(`Brain offline. Start the Lynn GUI, then send again. Use /providers for BYOK, /mode for permissions, /exit to leave.\nmode: ${renderMode(mode)}\n\n`);
  }
  async function handleText(raw: string): Promise<"continue" | "break"> {
    const text = raw.trim();
    if (!text) return "continue";
    if (text === "/exit" || text === "/quit") return "break";
    if (text === "/help") {
      output.write("/exit leave chat\n/clear reset context\n/model show model/BYOK route\n/providers show BYOK setup\n/mode show permission mode\n/mode ask|yolo|read-only|workspace|danger change permission mode\n/help show commands\n\n");
      return "continue";
    }
    if (text === "/mode") {
      output.write(`mode: ${renderMode(mode)}\nUse /mode yolo for full local tool permission, or /mode ask to return to guarded mode. Shift+Tab toggle is planned for the full TUI pass.\n\n`);
      return "continue";
    }
    if (text.startsWith("/mode ")) {
      const result = applyModeCommand(mode, text.slice(6).trim());
      output.write(`${result}\nmode: ${renderMode(mode)}\n\n`);
      return "continue";
    }
    if (text === "/model" || text === "/providers") {
      output.write(`${renderProvidersInfo(await resolveProvidersInfo(args))}\n\n`);
      return "continue";
    }
    if (text === "/clear") {
      messages.length = 0;
      output.write("Context cleared.\n\n");
      return "continue";
    }

    messages.push({ role: "user", content: text });
    if (mockBrain) {
      const answer = `Mock Lynn response: ${text}`;
      messages.push({ role: "assistant", content: answer });
      output.write(`${answer}\n\n`);
      return "continue";
    }

    let assistant = "";
    const spinner = new TerminalSpinner(process.stderr);
    const renderReasoning = shouldRenderReasoning(reasoning.display, false);
    try {
      spinner.start();
      for await (const event of streamBrainChat({ brainUrl, messages, reasoning })) {
        if (event.type === "assistant.delta" || (event.type === "reasoning.delta" && renderReasoning)) {
          spinner.stop();
        }
        if (renderChatEvent(event, renderReasoning)) {
          assistant += event.text;
        }
      }
    } catch (error) {
      spinner.stop();
      messages.pop();
      output.write(`\n${formatChatError(error)}\n\n`);
      return "continue";
    } finally {
      spinner.stop();
    }
    messages.push({ role: "assistant", content: assistant });
    output.write("\n\n");
    return "continue";
  }

  try {
    if (!input.isTTY) {
      for await (const line of rl) {
        if (await handleText(line) === "break") break;
      }
    } else {
      for (;;) {
        const text = await rl.question("> ");
        if (await handleText(text) === "break") break;
      }
    }
  } finally {
    rl.close();
  }
  return 0;
}

interface ChatMode {
  approval: "ask" | "on-failure" | "never" | "yolo";
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
}

function resolveMode(args: ParsedArgs): ChatMode {
  const approval = getStringFlag(args.flags, "approval");
  const sandbox = getStringFlag(args.flags, "sandbox");
  return {
    approval: approval === "on-failure" || approval === "never" || approval === "yolo" ? approval : "ask",
    sandbox: sandbox === "read-only" || sandbox === "danger-full-access" ? sandbox : "workspace-write",
  };
}

export function renderMode(mode: ChatMode): string {
  return `${mode.approval} / ${mode.sandbox}`;
}

export function applyModeCommand(mode: ChatMode, raw: string): string {
  const value = raw.toLowerCase();
  if (value === "yolo") {
    mode.approval = "yolo";
    mode.sandbox = "danger-full-access";
    return "YOLO mode enabled.";
  }
  if (value === "ask" || value === "guarded") {
    mode.approval = "ask";
    mode.sandbox = "workspace-write";
    return "Guarded mode enabled.";
  }
  if (value === "read-only" || value === "readonly") {
    mode.approval = "ask";
    mode.sandbox = "read-only";
    return "Read-only mode enabled.";
  }
  if (value === "workspace" || value === "workspace-write") {
    mode.approval = "ask";
    mode.sandbox = "workspace-write";
    return "Workspace-write mode enabled.";
  }
  if (value === "danger" || value === "danger-full-access") {
    mode.approval = "yolo";
    mode.sandbox = "danger-full-access";
    return "Danger-full-access mode enabled.";
  }
  return `Unknown mode: ${raw || "(empty)"}. Try /mode ask or /mode yolo.`;
}

export function formatChatError(error: unknown): string {
  if (error instanceof BrainConnectionError) {
    return `Brain offline: start the Lynn GUI so the local router is running, then retry. Use /providers for BYOK or /exit to leave. (${error.brainUrl})`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return `Lynn error: ${message}`;
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
