import { emitKeypressEvents } from "node:readline";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { getStringFlag, hasFlag, parseArgs, type ParsedArgs } from "../args.js";
import { BrainConnectionError, streamBrainChat, type BrainStreamEvent, type ChatMessage } from "../brain-client.js";
import { renderProvidersInfo, resolveProvidersInfo, runProviders } from "./providers.js";
import { parseReasoningOptions, shouldRenderReasoning } from "../reasoning.js";
import { TerminalSpinner } from "../terminal-spinner.js";
import { renderBrainEventForHuman, summarizeUsage, type HumanBrainRenderState } from "../brain-render.js";
import { dangerLine, dim, red, supportsColor } from "../terminal-style.js";
import { renderStartupBanner } from "../startup.js";
import { renderStatusBar } from "../status-bar.js";
import { resolveCliProviderProfile } from "../provider-profile.js";
import { t } from "../i18n.js";
import { MarkdownStream } from "../markdown.js";
import { appendHistory, historyPath, loadHistory } from "../history.js";
import { completeSlash } from "../completion.js";
import { resolveEffectivePermissions } from "../permissions.js";

export const CHAT_SLASH_COMMANDS = [
  "/exit",
  "/quit",
  "/help",
  "/fast",
  "/think",
  "/reasoning",
  "/mode",
  "/model",
  "/setup",
  "/byok",
  "/providers",
  "/providers set",
  "/providers unset",
  "/providers test",
  "/providers presets",
  "/byok set",
  "/byok unset",
  "/clear",
];

export function completeChatInput(line: string): [string[], string] {
  const result = completeSlash(line, CHAT_SLASH_COMMANDS);
  return [result.matches, line];
}

export async function runChat(args: ParsedArgs, options: { intro?: boolean; brainReachable?: boolean } = {}): Promise<number> {
  const mockBrain = hasFlag(args.flags, "mock-brain", "mock");
  const brainUrl = getStringFlag(args.flags, "brain-url") || process.env.LYNN_BRAIN_URL || "http://127.0.0.1:8790";
  let reasoning = parseReasoningOptions(args);
  const mode = await resolveChatMode(args);
  let cliProvider = await resolveCliProviderProfile(args);
  const messages: ChatMessage[] = [];
  const histFile = historyPath();
  const rl = readline.createInterface({
    input,
    output,
    terminal: input.isTTY && output.isTTY,
    completer: completeChatInput,
    history: loadHistory(histFile).reverse(),
  });
  const cleanupModeHotkey = input.isTTY && output.isTTY
    ? installModeHotkey({ input, output, readlineInterface: rl, mode })
    : () => {};

  if (options.intro !== false) {
    output.write(`${renderStartupBanner({
      brainUrl,
      brainStatus: "unknown",
      modeLabel: renderMode(mode),
      modelLabel: chatRouteLabel(cliProvider?.profile),
      byokLabel: cliProvider?.profile ? t("startup.byok.cliFallback") : undefined,
    })}\n\n`);
  } else if (options.brainReachable === false && !mockBrain) {
    output.write(`${renderOfflineChatHint(mode, brainUrl, cliProvider?.profile)}\n\n`);
  }
  async function handleText(raw: string): Promise<"continue" | "break"> {
    const text = raw.trim();
    if (!text) return "continue";
    appendHistory(text, histFile);
    if (text === "/exit" || text === "/quit") return "break";
    if (text === "/help") {
      output.write(`${t("chat.help")}\n\n`);
      return "continue";
    }
    if (text === "/fast") {
      reasoning = { ...reasoning, effort: "off" };
      output.write(`${t("chat.fast")}\n\n`);
      return "continue";
    }
    if (text === "/think") {
      reasoning = { ...reasoning, effort: "high" };
      output.write(`${t("chat.think")}\n\n`);
      return "continue";
    }
    if (text === "/reasoning") {
      output.write(`${t("chat.reasoning.show", { effort: reasoning.effort, display: reasoning.display })}\n\n`);
      return "continue";
    }
    if (text.startsWith("/reasoning ")) {
      const result = applyReasoningCommand(reasoning, text.slice(11).trim());
      reasoning = result.reasoning;
      output.write(`${result.message}\n${t("reasoning.state", { effort: reasoning.effort, display: reasoning.display })}\n\n`);
      return "continue";
    }
    if (text === "/mode") {
      output.write(`${t("chat.mode.show", { mode: renderMode(mode) })}\n\n`);
      return "continue";
    }
    if (text.startsWith("/mode ")) {
      const result = applyModeCommand(mode, text.slice(6).trim());
      output.write(renderInteractiveModeChange(result, mode, supportsColor(output)));
      return "continue";
    }
    if (text === "/model" || text === "/providers" || text === "/byok") {
      output.write(`${renderProvidersInfo(await resolveProvidersInfo(args))}\n\n`);
      return "continue";
    }
    const providerCommand = buildChatProviderArgs(text, args);
    if (providerCommand) {
      if (shouldShowProviderSetUsage(providerCommand, input.isTTY && output.isTTY)) {
        output.write(`${t("chat.providers.setUsage")}\n\n`);
        return "continue";
      }
      const previousRoute = chatRouteLabel(cliProvider?.profile);
      try {
        const code = await runProviders(providerCommand, false);
        if (shouldRefreshProviderRoute(providerCommand)) {
          cliProvider = await resolveCliProviderProfile(providerCommand) || await resolveCliProviderProfile(args);
          const nextRoute = chatRouteLabel(cliProvider?.profile);
          const changed = previousRoute !== nextRoute;
          output.write(`\n${t(changed ? "chat.providers.routeReloaded" : "chat.providers.routeUnchanged", { route: nextRoute })}\n\n`);
        } else if (code === 0) {
          output.write("\n");
        }
      } catch (error) {
        output.write(`${formatChatError(error)}\n\n`);
      }
      return "continue";
    }
    if (text.startsWith("/providers ") || text.startsWith("/byok ")) {
      output.write(`${t("chat.providers.usage")}\n\n`);
      return "continue";
    }
    if (text === "/clear") {
      messages.length = 0;
      output.write(`${t("chat.cleared")}\n\n`);
      return "continue";
    }

    messages.push({ role: "user", content: text });
    if (mockBrain) {
      const answer = t("mock.response", { text });
      messages.push({ role: "assistant", content: answer });
      output.write(`${answer}\n\n`);
      return "continue";
    }

    let assistant = "";
    let latestUsage: string | null = null;
    const renderState: HumanBrainRenderState = {};
    const spinner = new TerminalSpinner(process.stderr);
    const renderReasoning = shouldRenderReasoning(reasoning.display, false);
    const md = new MarkdownStream((s) => output.write(s), supportsColor(output));
    const turnStarted = Date.now();
    try {
      spinner.start();
      for await (const event of streamBrainChat({ brainUrl, messages, reasoning, fallbackProvider: cliProvider?.profile })) {
        if (event.type === "assistant.delta" || (event.type === "reasoning.delta" && renderReasoning)) {
          spinner.stop();
        }
        if (event.type === "assistant.delta") {
          md.push(event.text);
          assistant += event.text;
        } else {
          if (event.type === "usage") latestUsage = summarizeUsage(event.usage, { durationMs: Date.now() - turnStarted });
          renderChatEvent(event, renderReasoning, renderState, turnStarted);
        }
        if (event.type === "brain.error") {
          throw new Error(event.code ? `${event.error} (${event.code})` : event.error);
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
    md.end();
    messages.push({ role: "assistant", content: assistant });
    output.write(`\n${renderStatusBar({
      model: renderState.provider || t("status.chat.prefix"),
      cwd: process.cwd(),
      mode: renderMode(mode),
      reasoning: reasoning.effort,
      usage: latestUsage,
      color: supportsColor(output),
    })}\n\n`);
    return "continue";
  }

  try {
    if (!input.isTTY) {
      for await (const line of rl) {
        if (await handleText(line) === "break") break;
      }
    } else {
      const prompt = "› ";
      for (;;) {
        const text = await rl.question(prompt);
        if (await handleText(text) === "break") break;
      }
    }
  } finally {
    cleanupModeHotkey();
    rl.close();
  }
  return 0;
}

export interface ChatMode {
  approval: "ask" | "on-failure" | "never" | "yolo";
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
}

interface KeypressLike {
  name?: string;
  shift?: boolean;
  sequence?: string;
}

export interface ModeHotkeyStreams {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  readlineInterface: unknown;
  mode: ChatMode;
}

export async function resolveChatMode(args: ParsedArgs): Promise<ChatMode> {
  const permissions = await resolveEffectivePermissions(args);
  return {
    approval: permissions.approval,
    sandbox: permissions.sandbox,
  };
}

export function renderMode(mode: ChatMode): string {
  return `${mode.approval} / ${mode.sandbox}`;
}

export function chatRouteLabel(provider?: { provider: string; model: string } | null): string {
  if (provider) return `CLI BYOK: ${provider.model}`;
  return "MiMo via Brain router (auto)";
}

export function splitChatCommandLine(raw: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaping = false;
  for (const char of raw.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaping) current += "\\";
  if (current) tokens.push(current);
  return tokens;
}

export function buildChatProviderArgs(raw: string, baseArgs: ParsedArgs): ParsedArgs | null {
  const tokens = splitChatCommandLine(raw);
  const head = tokens[0]?.toLowerCase();
  if (head !== "/providers" && head !== "/byok" && head !== "/setup") return null;
  if (head === "/setup") {
    const parsed = parseArgs(["providers", "set", ...tokens.slice(1).filter((value) => value.toLowerCase() !== "set")]);
    const dataDir = getStringFlag(baseArgs.flags, "data-dir");
    if (dataDir && !getStringFlag(parsed.flags, "data-dir")) parsed.flags["data-dir"] = dataDir;
    return parsed;
  }
  const rest = tokens.slice(1);
  const subcommand = (rest[0] || "").toLowerCase();
  if (!["set", "unset", "clear", "reset", "test", "presets"].includes(subcommand)) return null;
  const parsed = parseArgs(["providers", ...rest]);
  const dataDir = getStringFlag(baseArgs.flags, "data-dir");
  if (dataDir && !getStringFlag(parsed.flags, "data-dir")) parsed.flags["data-dir"] = dataDir;
  return parsed;
}

export function shouldRefreshProviderRoute(args: ParsedArgs): boolean {
  const subcommand = (args.positionals[0] || "").toLowerCase();
  return subcommand === "set" || subcommand === "unset" || subcommand === "clear" || subcommand === "reset";
}

export function shouldShowProviderSetUsage(args: ParsedArgs, interactive = false): boolean {
  const subcommand = (args.positionals[0] || "").toLowerCase();
  if (subcommand !== "set") return false;
  if (interactive) return false;
  return !(
    getStringFlag(args.flags, "provider")
    || getStringFlag(args.flags, "preset")
    || getStringFlag(args.flags, "base-url", "api-base")
    || getStringFlag(args.flags, "api-key")
    || getStringFlag(args.flags, "model")
  );
}

export function renderOfflineChatHint(_mode: ChatMode, _brainUrl = "http://127.0.0.1:8790", provider?: { provider: string; model: string } | null): string {
  // The startup banner already shows brain URL + mode; keep this hint concise and
  // non-redundant — just the localized next steps.
  if (provider) return t("offline.body.byok", { provider: provider.provider, model: provider.model });
  return t("offline.body");
}

export function applyModeCommand(mode: ChatMode, raw: string): string {
  const value = raw.toLowerCase();
  if (value === "yolo") {
    mode.approval = "yolo";
    mode.sandbox = "danger-full-access";
    return t("mode.yolo.enabled");
  }
  if (value === "ask" || value === "guarded") {
    mode.approval = "ask";
    mode.sandbox = "workspace-write";
    return t("mode.ask.enabled");
  }
  if (value === "read-only" || value === "readonly") {
    mode.approval = "ask";
    mode.sandbox = "read-only";
    return t("mode.readonly.enabled");
  }
  if (value === "workspace" || value === "workspace-write") {
    mode.approval = "ask";
    mode.sandbox = "workspace-write";
    return t("mode.workspace.enabled");
  }
  if (value === "danger" || value === "danger-full-access") {
    mode.approval = "yolo";
    mode.sandbox = "danger-full-access";
    return t("mode.danger.enabled");
  }
  return t("mode.unknown", { raw: raw || "(empty)" });
}

export function isModeToggleKeypress(key: KeypressLike | undefined): boolean {
  return !!key && (key.sequence === "\u001b[Z" || (key.name === "tab" && key.shift === true));
}

export function toggleMode(mode: ChatMode): string {
  if (mode.approval === "yolo" || mode.sandbox === "danger-full-access") {
    return applyModeCommand(mode, "ask");
  }
  return applyModeCommand(mode, "yolo");
}

function renderInteractiveModeChange(message: string, mode: ChatMode, color: boolean): string {
  const dangerous = mode.approval === "yolo" || mode.sandbox === "danger-full-access";
  const label = dangerous ? red(renderMode(mode), color) : renderMode(mode);
  const warning = dangerous ? `\n${dangerLine(t("mode.danger.warning"), color)}` : "";
  return `✓ ${message}\nmode: ${label}${warning}\n\n`;
}

export function applyReasoningCommand(current: ReturnType<typeof parseReasoningOptions>, raw: string): { reasoning: ReturnType<typeof parseReasoningOptions>; message: string } {
  const value = raw.toLowerCase();
  if (value === "off" || value === "auto" || value === "low" || value === "medium" || value === "high" || value === "xhigh") {
    return { reasoning: { ...current, effort: value }, message: t("reasoning.effortSet", { value }) };
  }
  if (value === "show" || value === "always") {
    return { reasoning: { ...current, display: "always" }, message: t("reasoning.displayAlways") };
  }
  if (value === "hide" || value === "never") {
    return { reasoning: { ...current, display: "never" }, message: t("reasoning.displayNever") };
  }
  return { reasoning: current, message: t("reasoning.unknown", { raw: raw || "(empty)" }) };
}

export function installModeHotkey({ input, output, readlineInterface, mode }: ModeHotkeyStreams): () => void {
  emitKeypressEvents(input, readlineInterface as Parameters<typeof emitKeypressEvents>[1]);
  const onKeypress = (_chunk: string, key: KeypressLike) => {
    if (!isModeToggleKeypress(key)) return;
    const message = toggleMode(mode);
    output.write(`\n${renderInteractiveModeChange(message, mode, supportsColor(output))}`);
  };
  input.on("keypress", onKeypress);
  return () => {
    input.off("keypress", onKeypress);
  };
}

export function formatChatError(error: unknown): string {
  if (error instanceof BrainConnectionError) {
    return t("chat.error.brainOffline", { brainUrl: error.brainUrl });
  }
  const message = error instanceof Error ? error.message : String(error);
  return `Lynn error: ${message}`;
}

function renderChatEvent(event: BrainStreamEvent, renderReasoning: boolean, renderState: HumanBrainRenderState, startedAt = Date.now()): event is { type: "assistant.delta"; text: string } {
  if (event.type === "assistant.delta") {
    output.write(event.text);
    return true;
  }
  if (event.type === "reasoning.delta" && renderReasoning) {
    process.stderr.write(dim(event.text, supportsColor(process.stderr)));
  } else if (event.type === "usage") {
    const summary = summarizeUsage(event.usage, { durationMs: Date.now() - startedAt });
    if (summary) process.stderr.write(`\nusage: ${summary}\n`);
  } else {
    renderBrainEventForHuman(event, renderState, process.stderr);
  }
  return false;
}
