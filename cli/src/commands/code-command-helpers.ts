import { stdout as output } from "node:process";
import { getStringFlag, type ParsedArgs } from "../args.js";
import { resolveDefaultBrainUrl } from "../brain-url.js";
import {
codeCwd as cwd
} from "../code-command-options.js";
import {
codeRouteLabel,
renderAssistantBlock,
renderCodeFooter
} from "../code-output.js";
import { HistoryNavigator } from "../history.js";
import { t } from "../i18n.js";
import { readInteractiveLine } from "../interactive-line.js";
import { nowIso, writeJsonLine } from "../jsonl.js";
import { resolveEffectivePermissions } from "../permissions.js";
import { resolveCliProviderProfile, type CliProviderProfile } from "../provider-profile.js";
import { parseReasoningOptions } from "../reasoning.js";
import { localeForText, renderLocalRuntimeAnswer } from "../runtime-answer.js";
import { dangerLine, orange, supportsColor } from "../terminal-style.js";
import { renderMode, toggleMode, type ChatMode } from "./chat.js";


export function codeTaskPrompt(args: ParsedArgs): string {
  return [
    getStringFlag(args.flags, "p", "print", "prompt", "task"),
    args.positionals.join(" ").trim(),
  ].filter((part): part is string => !!part && !!part.trim()).join("\n\n").trim();
}

export async function runCodeLocalRuntimeAnswer(args: ParsedArgs, task: string, json: boolean): Promise<number> {
  const mode = await resolveCodeMode(args);
  const reasoning = parseReasoningOptions(args);
  const cliProvider = await resolveCliProviderProfile(args);
  const text = await renderCodeLocalRuntimeAnswer(args, task, mode, reasoning, cliProvider?.profile);
  if (json) {
    writeJsonLine({ type: "code.task.started", ts: nowIso(), task, local: true });
    writeJsonLine({ type: "assistant.delta", ts: nowIso(), text });
    writeJsonLine({ type: "code.task.finished", ts: nowIso(), ok: true, local: true, contentReturned: true });
  } else {
    process.stdout.write(renderAssistantBlock(text, renderCodeFooter({
      context: { cwd: cwd(args), gitStatus: "unknown", gitDiffStat: "", topFiles: [], packageScripts: {} },
      mode,
      mockBrain: false,
      reasoning,
      fallbackProvider: cliProvider?.profile,
    })));
  }
  return 0;
}


export async function renderCodeLocalRuntimeAnswer(
  args: ParsedArgs,
  text: string,
  mode: ChatMode,
  reasoning: ReturnType<typeof parseReasoningOptions>,
  fallbackProvider?: CliProviderProfile,
): Promise<string> {
  return renderLocalRuntimeAnswer({
    routeLabel: codeRouteLabel(false, fallbackProvider),
    brainUrl: await resolveDefaultBrainUrl(args),
    cwd: cwd(args),
    mode: renderMode(mode),
    reasoning: reasoning.effort,
    question: text,
  }, localeForText(text));
}



export async function readCodeLine(prompt: string, mode: ChatMode, options: { placeholder?: string; history?: HistoryNavigator; completions?: string[] } = {}): Promise<string | null> {
  return readInteractiveLine(prompt, mode, {
    ...options,
    onShiftTab: () => renderModeChange(toggleMode(mode), mode, supportsColor(output)),
  });
}

export function renderModeChange(message: string, mode: ChatMode, color: boolean): string {
  const dangerous = mode.approval === "yolo" || mode.sandbox === "danger-full-access";
  const modeLabel = dangerous ? orange(renderMode(mode), color) : renderMode(mode);
  const warning = dangerous
    ? `\n${dangerLine(t("mode.danger.warning"), color)}`
    : "";
  return `✓ ${message}\nmode: ${modeLabel}${warning}\n\n`;
}


export async function resolveCodeMode(args: ParsedArgs): Promise<ChatMode> {
  const permissions = await resolveEffectivePermissions(args);
  return {
    approval: permissions.approval,
    sandbox: permissions.sandbox,
  };
}
