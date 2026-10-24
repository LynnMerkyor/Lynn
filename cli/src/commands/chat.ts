import { stdin as input, stdout as output } from "node:process";
import { getStringFlag, hasFlag, type ParsedArgs } from "../args.js";
import { streamBrainChat, type ChatMessage } from "../brain-client.js";
import { renderToolDetail, renderToolDetailsList, summarizeUsage, thinkingStatusLabel, type HumanBrainRenderState } from "../brain-render.js";
import { resolveDefaultBrainUrl } from "../brain-url.js";
import { compactChatMessages } from "../chat-compaction.js";
import { applyChatRewind, beginChatRewindTurn, createChatRewindState, finishChatRewindTurn, maybeRecordChatRewindSnapshot, parseChatRewindCommand, renderChatRewind } from "../chat-rewind.js";
import { readClipboardImage } from "../clipboard-image.js";
import { assistantToolCallsForMessages, codeToolDefinitions, createStreamingToolCallAccumulator, parseCodeToolRequests, toolRequestsFromCollectedCalls, type CodeToolRequest } from "../code-tool-protocol.js";
import { formatDangerousToolPreview, renderClientToolResult, renderClientToolStart, resolveToolApproval } from "../code-tool-render.js";
import { completeSlash, looksLikeSlashCommand, normalizeSlashInput } from "../completion.js";
import { createDecodeSpeedTracker } from "../decode-speed.js";
import { HistoryNavigator, appendHistory, historyPath, loadHistory } from "../history.js";
import { t } from "../i18n.js";
import { readInteractiveLine } from "../interactive-line.js";
import { isLocalExitText, parseLocalReadOnlyCommand, renderLocalReadOnlyBlocked, renderLocalReadOnlyResult, runLocalReadOnlyCommand } from "../local-command.js";
import { MarkdownStream } from "../markdown.js";
import { buildImagesContentParts } from "../media.js";
import { analyzePastedContext, parseImagePromptCommand, summarizeImageRefs, summarizePastedContext } from "../pasted-context.js";
import { modelDisplayName } from "../provider-presets.js";
import { resolveCliProviderProfile } from "../provider-profile.js";
import { applyFastReasoning, lowerReasoningEffort, parseReasoningOptions, shouldRenderReasoning } from "../reasoning.js";
import { isLocalRuntimeQuestion, localeForText, renderLocalRuntimeAnswer } from "../runtime-answer.js";
import { refreshCliRuntimeSystemMessage, resetCliRuntimeMessages } from "../runtime-context.js";
import { createRuntimeMetrics, recordDecodeTps, recordUsageMetrics, renderRuntimeMetrics } from "../runtime-metrics.js";
import { buildMemoryContextFrameSync, handleMemorySlashCommand } from "../session/memory.js";
import { resolveDataDir } from "../session/store.js";
import { renderStartupBanner } from "../startup.js";
import { renderStatusBar } from "../status-bar.js";
import { shouldUseInkTui } from "../terminal-safety.js";
import { TerminalSpinner, renderCard } from "../terminal-spinner.js";
import { dim, red, supportsColor } from "../terminal-style.js";
import { runClientTool } from "../tools/registry.js";
import type { ClientToolResult } from "../tools/types.js";
import { argsForChatVoiceLaunch, parseChatVoiceLaunchCommand } from "../voice-command.js";
import { runRealtimeVoice } from "../voice-realtime.js";
import { applyModeCommand, applyReasoningCommand, applyThinkCommand, buildChatProviderArgs, buildPromptFrameStatus, chatRouteLabel, compactToolResultBody, eventWritesHumanOutput, formatChatError, parsePendingRewindInput, renderChatEvent, renderInteractiveModeChange, renderMode, renderOfflineChatHint, resolveChatMode, shouldRefreshProviderRoute, shouldResumeWaitingSpinner, shouldShowProviderSetUsage, toggleMode } from "./chat-command-helpers.js";
import { renderLocalToolList } from "./chat-tool-list.js";
import { renderBrainModelChoices, renderProvidersInfo, resolveProvidersInfo, runProviders } from "./providers.js";
export { applyModeCommand, applyReasoningCommand, applyThinkCommand, buildChatProviderArgs, chatRouteLabel, formatChatError, isModeToggleKeypress, renderMode, renderOfflineChatHint, resolveChatMode, shouldRefreshProviderRoute, shouldShowProviderSetUsage, splitChatCommandLine, toggleMode } from "./chat-command-helpers.js";


export const CHAT_SLASH_COMMANDS = [
  "/yolo",
  "/ask",
  "/model",
  "/mode",
  "/think",
  "/think high",
  "/think medium",
  "/think low",
  "/fast",
  "/voice",
  "/ptt",
  "/tools",
  "/providers",
  "/help",
  "/exit",
  "/quit",
  "/tool",
  "/version",
  "/about",
  "/reasoning",
  "/model stepfun",
  "/model spark",
  "/memory",
  "/memory add",
  "/memory forget",
  "/cwd",
  "/image",
  "/images",
  "/attach",
  "/setup",
  "/byok",
  "/providers set",
  "/providers unset",
  "/providers test",
  "/providers presets",
  "/byok set",
  "/byok unset",
  "/clear",
  "/rewind",
];


const CHAT_MAX_TOOL_STEPS = 20;


export function completeChatInput(line: string): [string[], string] {
  const result = completeSlash(line, CHAT_SLASH_COMMANDS);
  return [result.matches, line];
}


export async function runChat(args: ParsedArgs, options: { intro?: boolean; brainReachable?: boolean } = {}): Promise<number> {
  if (input.isTTY && output.isTTY && shouldUseInkTui(args)) {
    const { runInkChat } = await import("../ink-chat.js");
    return runInkChat(args);
  }
  const mockBrain = hasFlag(args.flags, "mock-brain", "mock");
  const brainUrl = await resolveDefaultBrainUrl(args);
  const chatCwd = getStringFlag(args.flags, "cwd") || process.cwd();
  let reasoning = parseReasoningOptions(args);
  const mode = await resolveChatMode(args);
  const approvalSession = { approveAll: false };
  let cliProvider = await resolveCliProviderProfile(args);
  const dataDir = resolveDataDir(getStringFlag(args.flags, "data-dir"));
  let memoryFrame = buildMemoryContextFrameSync(dataDir);
  const messages: ChatMessage[] = resetCliRuntimeMessages(chatRouteLabel(cliProvider?.profile), memoryFrame);
  const rewindState = createChatRewindState();
  let pendingRewind: { phase: "list" | "preview"; ordinal: number | null } | null = null;
  const brainRenderState: HumanBrainRenderState = {};
  const runtimeMetrics = createRuntimeMetrics();
  const histFile = historyPath();
  const history = loadHistory(histFile);
  const rl = !input.isTTY
    ? (await import("node:readline/promises")).createInterface({ input, output, terminal: false })
    : null;
  if (options.intro !== false) {
    output.write(`${renderStartupBanner({
      cwd: chatCwd,
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
    let text = normalizeSlashInput(raw.trim());
    if (!text) {
      const clipboard = await readClipboardImage().catch(() => null);
      if (!clipboard) return "continue";
      text = "/image";
    }
    if (isLocalExitText(text)) return "break";
    appendHistory(text, histFile);
    if (pendingRewind) {
      const selected = parsePendingRewindInput(text, pendingRewind);
      if (selected) {
        try {
          const body = selected.apply
            ? applyChatRewind(rewindState, selected.ordinal, messages, chatCwd, supportsColor(output))
            : renderChatRewind(rewindState, { ordinal: selected.ordinal, apply: false }, supportsColor(output));
          pendingRewind = selected.apply ? null : { phase: "preview", ordinal: selected.ordinal };
          output.write(`${body}\n\n`);
        } catch (error) {
          pendingRewind = null;
          output.write(`${red(error instanceof Error ? error.message : String(error), supportsColor(output))}\n\n`);
        }
        return "continue";
      }
      pendingRewind = null;
    }
    const voiceLaunch = parseChatVoiceLaunchCommand(text);
    if (voiceLaunch) {
      try { await runRealtimeVoice(argsForChatVoiceLaunch(args, voiceLaunch), { embedded: true }); }
      catch (error) { output.write(`${formatChatError(error)}\n\n`); }
      return "continue";
    }
    if (text === "/help") {
      output.write(`${t("chat.help")}\n\n`);
      return "continue";
    }
    if (text === "/tool") {
      output.write(`${renderToolDetailsList(brainRenderState, supportsColor(output))}\n\n`);
      return "continue";
    }
    if (text === "/tools") {
      output.write(`${renderLocalToolList(supportsColor(output))}\n\n`);
      return "continue";
    }
    const toolDetailMatch = text.match(/^\/tool\s+(\d+)$/);
    if (toolDetailMatch) {
      output.write(`${renderToolDetail(brainRenderState, Number(toolDetailMatch[1]), supportsColor(output))}\n\n`);
      return "continue";
    }
    if (isLocalRuntimeQuestion(text)) {
      output.write(`${renderLocalRuntimeAnswer({
        routeLabel: chatRouteLabel(cliProvider?.profile),
        brainUrl,
        cwd: chatCwd,
        mode: renderMode(mode),
        reasoning: reasoning.effort,
        question: text,
      }, localeForText(text))}\n\n`);
      return "continue";
    }
    if (text === "/fast") {
      reasoning = applyFastReasoning(reasoning);
      output.write(`${t("chat.fast")}\n\n`);
      return "continue";
    }
    if (text === "/think") {
      reasoning = { ...reasoning, effort: "high", maxTokens: undefined };
      output.write(`${t("chat.think")}\n\n`);
      return "continue";
    }
    if (text.startsWith("/think ")) {
      const result = applyThinkCommand(reasoning, text.slice(7).trim(), "chat");
      reasoning = result.reasoning;
      output.write(`${result.message}\n${t("reasoning.state", { effort: reasoning.effort, display: reasoning.display })}\n\n`);
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
    if (text === "/yolo" || text === "/ask") {
      const result = applyModeCommand(mode, text.slice(1));
      output.write(renderInteractiveModeChange(result, mode, supportsColor(output)));
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
    if (text === "/model") {
      output.write(`${renderBrainModelChoices(await resolveProvidersInfo(args))}\n\n`);
      return "continue";
    }
    const imageCommand = parseImagePromptCommand(text, chatCwd);
    if (imageCommand) {
      if (!imageCommand.imageRefs.length) {
        const clipboard = await readClipboardImage().catch(() => null);
        if (clipboard) {
          try {
            const userContent = await buildImagesContentParts([clipboard.path], imageCommand.prompt);
            output.write(`${t("chat.image.attached", { summary: summarizeImageRefs([{ raw: clipboard.path, path: clipboard.path }]) })}\n\n`);
            return sendUserMessage(imageCommand.prompt, userContent);
          } catch (error) {
            output.write(`${t("chat.image.readError", { error: error instanceof Error ? error.message : String(error) })}\n\n`);
            return "continue";
          }
        }
        output.write(`${t("chat.image.usage")}\n\n`);
        return "continue";
      }
      let userContent: ChatMessage["content"];
      try {
        userContent = await buildImagesContentParts(imageCommand.imageRefs.map((ref) => ref.path), imageCommand.prompt);
      } catch (error) {
        output.write(`${t("chat.image.readError", { error: error instanceof Error ? error.message : String(error) })}\n\n`);
        return "continue";
      }
      output.write(`${t("chat.image.attached", { summary: summarizeImageRefs(imageCommand.imageRefs) })}\n\n`);
      return sendUserMessage(imageCommand.prompt, userContent);
    }
    if (text === "/providers" || text === "/byok") {
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
          refreshCliRuntimeSystemMessage(messages, nextRoute, memoryFrame);
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
      messages.splice(0, messages.length, ...resetCliRuntimeMessages(chatRouteLabel(cliProvider?.profile), memoryFrame));
      rewindState.checkpoints = [];
      rewindState.active = null;
      pendingRewind = null;
      output.write(`${t("chat.cleared")}\n\n`);
      return "continue";
    }
    const rewindCommand = parseChatRewindCommand(text);
    if (rewindCommand) {
      try {
        const body = rewindCommand.apply && rewindCommand.ordinal !== null
          ? applyChatRewind(rewindState, rewindCommand.ordinal, messages, chatCwd, supportsColor(output))
          : renderChatRewind(rewindState, rewindCommand, supportsColor(output));
        pendingRewind = !rewindCommand.apply
          ? { phase: rewindCommand.ordinal === null ? "list" : "preview", ordinal: rewindCommand.ordinal }
          : null;
        output.write(`${body}\n\n`);
      } catch (error) {
        pendingRewind = null;
        output.write(`${red(error instanceof Error ? error.message : String(error), supportsColor(output))}\n\n`);
      }
      return "continue";
    }
    if (text === "/cwd" || text === "/pwd") {
      output.write(`${t("cwd.info", { cwd: chatCwd })}\n\n`);
      return "continue";
    }
    const localReadOnly = parseLocalReadOnlyCommand(text, chatCwd);
    if (localReadOnly?.kind === "blocked") {
      output.write(`${renderLocalReadOnlyBlocked(localReadOnly, output)}\n\n`);
      return "continue";
    }
    if (localReadOnly?.kind === "command") {
      const result = await runLocalReadOnlyCommand(localReadOnly.command);
      output.write(`${renderLocalReadOnlyResult(localReadOnly.command, result, output)}\n\n`);
      return "continue";
    }
    const memoryCommand = await handleMemorySlashCommand(text, dataDir);
    if (memoryCommand?.handled) {
      if (memoryCommand.changed) {
        memoryFrame = buildMemoryContextFrameSync(dataDir);
        refreshCliRuntimeSystemMessage(messages, chatRouteLabel(cliProvider?.profile), memoryFrame);
      }
      output.write(`${memoryCommand.message}\n\n`);
      return "continue";
    }
    if (looksLikeSlashCommand(text)) {
      output.write(`${t("slash.unknown")}\n\n`);
      return "continue";
    }

    const pasted = analyzePastedContext(text, chatCwd);
    if (pasted.imageRefs.length) {
      const promptText = pasted.text || t("chat.image.defaultPrompt");
      try {
        const userContent = await buildImagesContentParts(pasted.imageRefs.map((ref) => ref.path), promptText);
        output.write(`${t("chat.image.attached", { summary: summarizePastedContext(pasted) })}\n\n`);
        return sendUserMessage(promptText, userContent);
      } catch (error) {
        output.write(`${t("chat.image.readError", { error: error instanceof Error ? error.message : String(error) })}\n\n`);
        return "continue";
      }
    }

    return sendUserMessage(text, text);
  }

  async function sendUserMessage(displayText: string, content: ChatMessage["content"]): Promise<"continue"> {
    const checkpoint = beginChatRewindTurn(rewindState, displayText, messages.length);
    const turnAbort = new AbortController();
    const onSigint = () => turnAbort.abort(new Error(t("chat.cancelled")));
    process.once("SIGINT", onSigint);
    messages.push({ role: "user", content });
    try {
      renderChatCompaction(compactChatMessages(messages));
      if (mockBrain) {
        const answer = t("mock.response", { text: displayText });
        messages.push({ role: "assistant", content: answer });
        renderChatCompaction(compactChatMessages(messages));
        output.write(`${answer}\n\n`);
        return "continue";
      }

      let latestUsage: string | null = null;
      const spinner = new TerminalSpinner(process.stderr, t("spinner.thinking"), {
        danger: mode.approval === "yolo" || mode.sandbox === "danger-full-access",
      });
      const renderReasoning = shouldRenderReasoning(reasoning.display, false);
      const color = supportsColor(output);
      const maxEmptyAttempts = 3;
      let decodeTps: string | null = null;
      let finalAssistant = "";
      for (let attempt = 1; attempt <= maxEmptyAttempts; attempt += 1) {
        latestUsage = null;
        decodeTps = null;
        let toolSteps = 0;
        let attemptHadToolCalls = false;
        // On an empty-answer retry, step reasoning down so an overflowing think leaves room
        // for the answer (mirrors the Brain-side length-retry).
        const attemptReasoning = attempt > 1
          ? { ...reasoning, effort: lowerReasoningEffort(reasoning.effort) }
          : reasoning;
        try {
          for (;;) {
            const round = await streamChatModelRound({
              brainUrl,
              messages,
              reasoning: attemptReasoning,
              cliProvider,
              renderReasoning,
              brainRenderState,
              runtimeMetrics,
              spinner,
              color,
              signal: turnAbort.signal,
            });
            latestUsage = round.latestUsage || latestUsage;
            // One record per ROUND (final frame only) — session totals + cache-hit sampling.
            if (round.lastUsageRaw) recordUsageMetrics(runtimeMetrics, round.lastUsageRaw);
            decodeTps = round.decodeTps || decodeTps;
            const requests = round.toolRequests;
            if (!requests.length) {
              finalAssistant = round.assistant;
              break;
            }
            attemptHadToolCalls = true;
            if (round.structuredToolCalls) {
              messages.push({
                role: "assistant",
                content: round.assistant,
                tool_calls: assistantToolCallsForMessages(requests),
              });
            } else {
              messages.push({ role: "assistant", content: round.assistant });
            }
            const fallbackSections: string[] = [];
            for (const request of requests) {
              toolSteps += 1;
              if (toolSteps > CHAT_MAX_TOOL_STEPS) {
                const message = `Lynn chat stopped after ${CHAT_MAX_TOOL_STEPS} local tool steps. Try narrowing the request or use Lynn code for a long-running task.`;
                messages.push({ role: "user", content: message });
                output.write(`\n${red(message, color)}\n\n`);
                return "continue";
              }
              const result = await runChatClientTool(request);
              const section = formatChatClientToolSection(request, result);
              if (round.structuredToolCalls) {
                messages.push({
                  role: "tool",
                  tool_call_id: request.toolCallId,
                  name: request.tool,
                  content: section,
                });
              } else {
                fallbackSections.push(section);
              }
            }
            if (!round.structuredToolCalls && fallbackSections.length) {
              messages.push({ role: "user", content: `<lynn_local_tool_observations>\n${fallbackSections.join("\n\n")}\n</lynn_local_tool_observations>` });
            }
          }
        } catch (error) {
          spinner.stop();
          messages.pop();
          output.write(`\n${turnAbort.signal.aborted ? t("chat.cancelled") : formatChatError(error)}\n\n`);
          return "continue";
        } finally {
          spinner.stop();
        }
        if (finalAssistant.trim()) break;
        if (attemptHadToolCalls) break;
        if (attempt < maxEmptyAttempts) output.write(`\n${dim(t("prompt.empty.retry"), color)}\n\n`);
      }
      if (!finalAssistant.trim()) {
        messages.pop();
        output.write(`${red(t("prompt.empty"), color)}\n\n`);
        return "continue";
      }
      messages.push({ role: "assistant", content: finalAssistant });
      renderChatCompaction(compactChatMessages(messages));
      recordDecodeTps(runtimeMetrics, decodeTps);
      output.write(`\n${renderStatusBar({
        model: brainRenderState.provider ? modelDisplayName(brainRenderState.provider) : t("status.chat.prefix"),
        cwd: chatCwd,
        mode: renderMode(mode),
        reasoning: reasoning.effort,
        usage: latestUsage,
        decodeTps,
        metrics: renderRuntimeMetrics(runtimeMetrics),
        color,
      })}\n\n`);
      return "continue";
    } finally {
      process.removeListener("SIGINT", onSigint);
      finishChatRewindTurn(rewindState, checkpoint);
    }
  }

  async function streamChatModelRound(inputData: {
    brainUrl: string;
    messages: ChatMessage[];
    reasoning: typeof reasoning;
    cliProvider: typeof cliProvider;
    renderReasoning: boolean;
    brainRenderState: HumanBrainRenderState;
    runtimeMetrics: ReturnType<typeof createRuntimeMetrics>;
    spinner: TerminalSpinner;
    color: boolean;
    signal: AbortSignal;
  }): Promise<{ assistant: string; toolRequests: CodeToolRequest[]; structuredToolCalls: boolean; latestUsage: string | null; lastUsageRaw: unknown; decodeTps: string | null }> {
    let assistant = "";
    let latestUsage: string | null = null;
    let lastUsageRaw: unknown = null;
    let decodeTps: string | null = null;
    const md = new MarkdownStream((s) => output.write(s), inputData.color);
    const turnStarted = Date.now();
    const decodeTracker = createDecodeSpeedTracker(turnStarted);
    const toolAccumulator = createStreamingToolCallAccumulator();
    try {
      inputData.spinner.start();
      for await (const event of streamBrainChat({
        brainUrl: inputData.brainUrl,
        messages: inputData.messages,
        reasoning: inputData.reasoning,
        fallbackProvider: inputData.cliProvider?.profile,
        tools: codeToolDefinitions(),
        signal: inputData.signal,
      })) {
        if (event.type === "tool_call.delta") {
          toolAccumulator.append(event);
          continue;
        }
        if (eventWritesHumanOutput(event, inputData.renderReasoning)) {
          inputData.spinner.stop();
        }
        if (event.type === "brain.error") {
          throw new Error(event.code ? `${event.error} (${event.code})` : event.error);
        }
        if (event.type === "assistant.delta") {
          md.push(event.text);
          decodeTps = decodeTracker.add(event.text) || decodeTps;
          assistant += event.text;
        } else {
          if (event.type === "usage") {
            latestUsage = summarizeUsage(event.usage, { durationMs: Date.now() - turnStarted });
            // Last frame wins: only the FINAL streaming usage frame carries real totals (and the
            // real prefix-cache value); the caller records it once per round for session totals.
            lastUsageRaw = event.usage;
            // Streaming usage feeds the waiting spinner (thinking progress) instead of printing
            // per-frame "usage:" lines; the end-of-turn status bar shows the final usage.
            if (!assistant) {
              const label = thinkingStatusLabel(event.usage, turnStarted);
              if (label) inputData.spinner.setLabel(label);
            }
            continue;
          }
          renderChatEvent(event, inputData.renderReasoning, inputData.brainRenderState, turnStarted);
          if (shouldResumeWaitingSpinner(event)) inputData.spinner.start();
        }
      }
    } finally {
      inputData.spinner.stop();
      md.end();
    }
    const structuredRequests = toolRequestsFromCollectedCalls(toolAccumulator.toToolCalls(), 0);
    if (structuredRequests.length) {
      return { assistant, toolRequests: structuredRequests, structuredToolCalls: true, latestUsage, lastUsageRaw, decodeTps };
    }
    return { assistant, toolRequests: parseCodeToolRequests(assistant), structuredToolCalls: false, latestUsage, lastUsageRaw, decodeTps };
  }

  async function runChatClientTool(request: CodeToolRequest): Promise<ClientToolResult> {
    const preview = formatDangerousToolPreview(request.tool, request.args, supportsColor(output));
    renderClientToolStart(request, process.stderr);
    try {
      const effectiveApproval = await resolveToolApproval({
        tool: request.tool,
        approval: mode.approval,
        cwd: chatCwd,
        json: false,
        input,
        output,
        preview,
        args: request.args,
        session: approvalSession,
      });
      const effectiveSandbox = request.tool === "bash"
        && mode.approval === "ask"
        && effectiveApproval === "yolo"
        ? "danger-full-access"
        : mode.sandbox;
      maybeRecordChatRewindSnapshot(rewindState, chatCwd, request);
      const result = await runClientTool({ cwd: chatCwd, approval: effectiveApproval, sandbox: effectiveSandbox }, {
        name: request.tool,
        ...request.args,
      });
      renderClientToolResult(result, process.stderr, request);
      return result;
    } catch (error) {
      const result: ClientToolResult = {
        ok: false,
        tool: request.tool,
        error: error instanceof Error ? error.message : String(error),
      };
      renderClientToolResult(result, process.stderr, request);
      return result;
    }
  }

  function formatChatClientToolSection(request: CodeToolRequest, result: ClientToolResult): string {
    const body = result.ok
      ? JSON.stringify(result.output ?? {}, null, 2)
      : `ERROR: ${result.error || "tool failed"}`;
    return [
      `Tool result for ${request.tool}:`,
      compactToolResultBody(body),
    ].join("\n");
  }

  function renderChatCompaction(result: ReturnType<typeof compactChatMessages>): void {
    if (!result.compactedMessages) return;
    const color = supportsColor(process.stderr);
    process.stderr.write(`${renderCard({
      kind: "info",
      title: `context compacted · ${result.compactedMessages} old messages`,
      body: ["kept the first request, recent turns, links, and runtime notes"],
    }, color)}\n`);
  }

  try {
    if (!input.isTTY) {
      if (!rl) return 0;
      for await (const line of rl) {
        if (await handleText(line) === "break") break;
      }
    } else {
      const prompt = "› ";
      for (;;) {
        const text = await readInteractiveLine(prompt, mode, {
          placeholder: t("chat.placeholder"),
          history: new HistoryNavigator(history),
          completions: CHAT_SLASH_COMMANDS,
          frameStatus: buildPromptFrameStatus(cliProvider?.profile, mode, reasoning.effort),
          onShiftTab: () => renderInteractiveModeChange(toggleMode(mode), mode, supportsColor(output)),
        });
        if (text === null) break;
        if (await handleText(text) === "break") break;
      }
    }
  } finally {
    rl?.close();
  }
  return 0;
}
export type { ChatMode } from "./chat-command-helpers.js";
