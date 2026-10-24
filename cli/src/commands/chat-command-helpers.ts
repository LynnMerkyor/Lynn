import { stdout as output } from "node:process";
import { getStringFlag, parseArgs, type ParsedArgs } from "../args.js";
import { BrainConnectionError, type BrainStreamEvent } from "../brain-client.js";
import { formatBrainErrorForHuman, renderBrainEventForHuman, type HumanBrainRenderState } from "../brain-render.js";
import { t } from "../i18n.js";
import { resolveEffectivePermissions } from "../permissions.js";
import { modelLabelWithId } from "../provider-presets.js";
import { applyFastReasoning, parseReasoningOptions } from "../reasoning.js";
import { DEFAULT_ROUTE_CHAIN_AUTO } from "../route-labels.js";
import { bold, dim, green, orange, supportsColor } from "../terminal-style.js";

export function parsePendingRewindInput(text: string, pending: { phase: "list" | "preview"; ordinal: number | null }): { ordinal: number; apply: boolean } | null {
  if (/^\d+$/.test(text)) return { ordinal: Number(text), apply: false };
  if (pending.phase === "preview" && pending.ordinal !== null && /^(?:y|yes|apply|确认|应用)$/i.test(text)) {
    return { ordinal: pending.ordinal, apply: true };
  }
  return null;
}


export function eventWritesHumanOutput(event: BrainStreamEvent, renderReasoning: boolean): boolean {
  return event.type === "assistant.delta"
    || event.type === "provider"
    || event.type === "tool_progress"
    || event.type === "brain.error"
    || (event.type === "reasoning.delta" && renderReasoning);
}


export function shouldResumeWaitingSpinner(event: BrainStreamEvent): boolean {
  return event.type === "provider" || event.type === "tool_progress";
}


export function compactToolResultBody(body: string, max = 16_000): string {
  if (body.length <= max) return body;
  return `${body.slice(0, max)}\n[Lynn chat truncated this local tool result from ${body.length} chars. Ask for a narrower read/search if more detail is needed.]`;
}



export interface ChatMode {
  approval: "ask" | "on-failure" | "never" | "yolo";
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
}

export interface KeypressLike {
  name?: string;
  shift?: boolean;
  sequence?: string;
}



export async function resolveChatMode(args: ParsedArgs): Promise<ChatMode> {
  const permissions = await resolveEffectivePermissions(args);
  return {
    approval: permissions.approval,
    sandbox: permissions.sandbox,
  };
}


export function renderMode(mode: ChatMode): string {
  const sandbox = mode.sandbox === "danger-full-access" ? "full-access" : mode.sandbox;
  return `${mode.approval} / ${sandbox}`;
}

export function buildPromptFrameStatus(
  profile: { provider: string; model: string } | null | undefined,
  mode: ChatMode,
  effort: string,
): string {
  const model = profile ? modelLabelWithId(profile.model) : "Step 5 Preview";
  const think = effort === "off" ? "fast" : `think ${effort}`;
  return `Lynn · ${model} · ${renderMode(mode)} · ${think}`;
}



export function chatRouteLabel(provider?: { provider: string; model: string } | null): string {
  if (provider) return `CLI BYOK: ${modelLabelWithId(provider.model)}`;
  return DEFAULT_ROUTE_CHAIN_AUTO;
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
  if (head !== "/providers" && head !== "/byok" && head !== "/setup" && head !== "/model") return null;
  if (head === "/model") {
    const rest = tokens.slice(1);
    if (!rest.length) return null;
    const subcommand = (rest[0] || "").toLowerCase();
    const parsed = ["set", "unset", "clear", "reset", "test", "presets"].includes(subcommand)
      ? parseArgs(["providers", ...rest])
      : parseArgs(["providers", "set", ...rest.slice(rest[0]?.startsWith("-") ? 0 : 1)]);
    if (subcommand && !["set", "unset", "clear", "reset", "test", "presets"].includes(subcommand) && !rest[0]?.startsWith("-")) {
      if (getStringFlag(parsed.flags, "base-url", "api-base")) {
        if (!getStringFlag(parsed.flags, "model")) parsed.flags.model = rest[0];
      } else if (!getStringFlag(parsed.flags, "preset")) {
        parsed.flags.preset = rest[0];
      }
    }
    const dataDir = getStringFlag(baseArgs.flags, "data-dir");
    if (dataDir && !getStringFlag(parsed.flags, "data-dir")) parsed.flags["data-dir"] = dataDir;
    return parsed;
  }
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

export function renderInteractiveModeChange(message: string, mode: ChatMode, color: boolean): string {
  const dangerous = mode.approval === "yolo" || mode.sandbox === "danger-full-access";
  if (dangerous) {
    const head = "⚠  YOLO / full-access  ⚠";
    return [
      "",
      orange(bold(head, color), color),
      orange(message, color),
      `mode: ${orange(bold(renderMode(mode), color), color)}`,
      orange(t("mode.danger.warning"), color),
      "",
      "",
    ].join("\n");
  }
  return `${green("✓", color)} ${message}\nmode: ${dim(renderMode(mode), color)}\n\n`;
}



export function applyReasoningCommand(current: ReturnType<typeof parseReasoningOptions>, raw: string): { reasoning: ReturnType<typeof parseReasoningOptions>; message: string } {
  const value = raw.toLowerCase();
  if (value === "off" || value === "auto" || value === "low" || value === "medium" || value === "high" || value === "xhigh") {
    // Explicit effort selection clears any /fast output-budget cap.
    return { reasoning: { ...current, effort: value, maxTokens: undefined }, message: t("reasoning.effortSet", { value }) };
  }
  if (value === "show" || value === "always") {
    return { reasoning: { ...current, display: "always" }, message: t("reasoning.displayAlways") };
  }
  if (value === "hide" || value === "never") {
    return { reasoning: { ...current, display: "never" }, message: t("reasoning.displayNever") };
  }
  return { reasoning: current, message: t("reasoning.unknown", { raw: raw || "(empty)" }) };
}


export function applyThinkCommand(current: ReturnType<typeof parseReasoningOptions>, raw: string, scope: "chat" | "code"): { reasoning: ReturnType<typeof parseReasoningOptions>; message: string } {
  const value = raw.toLowerCase();
  if (value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "auto") {
    // Explicit effort selection clears any /fast output-budget cap.
    return {
      reasoning: { ...current, effort: value, maxTokens: undefined },
      message: t(scope === "chat" ? "chat.think.set" : "code.think.set", { value }),
    };
  }
  if (value === "fast") {
    // Real fast profile: low reasoning + 8K output cap (StepFun is reasoning-always, no true off).
    return { reasoning: applyFastReasoning(current), message: t(scope === "chat" ? "chat.fast" : "code.fast") };
  }
  if (value === "off") {
    // Thinking-off (local Spark honors enable_thinking=false); no output cap.
    return { reasoning: { ...current, effort: "off", maxTokens: undefined }, message: t(scope === "chat" ? "chat.fast" : "code.fast") };
  }
  return { reasoning: current, message: t("reasoning.unknown", { raw: raw || "(empty)" }) };
}


export function formatChatError(error: unknown): string {
  if (error instanceof BrainConnectionError) {
    return t("chat.error.brainOffline", { brainUrl: error.brainUrl });
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/all providers failed/i.test(message)) return formatBrainErrorForHuman(message);
  return `Lynn error: ${message}`;
}

export function renderChatEvent(event: BrainStreamEvent, renderReasoning: boolean, renderState: HumanBrainRenderState, startedAt = Date.now()): event is { type: "assistant.delta"; text: string } {
  if (event.type === "assistant.delta") {
    output.write(event.text);
    return true;
  }
  if (event.type === "reasoning.delta" && renderReasoning) {
    process.stderr.write(dim(event.text, supportsColor(process.stderr)));
  } else if (event.type === "usage") {
    // Tracked in the turn loop (latestUsage + spinner label); printed once in the end-of-turn
    // status bar instead of one scrolling line per streaming usage frame.
  } else {
    renderBrainEventForHuman(event, renderState, process.stderr);
  }
  return false;
}
