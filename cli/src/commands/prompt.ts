import { getStringFlag, hasFlag, type ParsedArgs } from "../args.js";
import { streamBrainChat, type BrainStreamEvent, type ChatMessage } from "../brain-client.js";
import { formatBrainErrorForHuman, renderBrainEventForHuman, summarizeUsage, thinkingStatusLabel, type HumanBrainRenderState } from "../brain-render.js";
import { nowIso, writeJsonLine } from "../jsonl.js";
import { lowerReasoningEffort, parseReasoningOptions, shouldRenderReasoning } from "../reasoning.js";
import { appendSessionTurn, resolveDataDir } from "../session/store.js";
import { TerminalSpinner } from "../terminal-spinner.js";
import { resolveCliProviderProfile } from "../provider-profile.js";
import { t } from "../i18n.js";
import { buildImagesContentParts, parseImageList } from "../media.js";
import { resetCliRuntimeMessages } from "../runtime-context.js";
import { isLocalRuntimeQuestion, localeForText, renderLocalRuntimeAnswer } from "../runtime-answer.js";
import { chatRouteLabel } from "./chat.js";
import { resolveDefaultBrainUrl } from "../brain-url.js";
import { completeJsonBoundary } from "../json-boundary.js";
import { mergePromptAndVoice, transcribeVoiceInput } from "../voice-client.js";
import { classifyRouteIntent } from "../../../shared/task-route-intent.js";
import {
  buildLocalWorkspaceDirectReply,
  buildLocalWorkspaceContext,
  shouldAttachLocalWorkspaceContext,
  shouldUseLocalWorkspaceDirectReply,
} from "../../../server/chat/local-workspace-context.js";
import { buildLocalOfficeDirectAnswer } from "../../../server/chat/local-office-answer.js";
import {
  buildDirectResearchAnswer,
  buildReportResearchContext,
  inferReportResearchKind,
} from "../../../server/chat/report-research-context.js";
import {
  buildNoToolTurnPrompt,
  shouldDisableToolsForTurn,
} from "../../../server/chat/tool-use-behavior.js";

export interface PromptOptions {
  json?: boolean;
  mockBrain?: boolean;
  onAssistantComplete?: (text: string) => void | Promise<void>;
}

export function resolvePrompt(args: ParsedArgs): string {
  return getStringFlag(args.flags, "p", "print", "prompt") || args.positionals.join(" ").trim();
}

export function mergePromptAndStdin(prompt: string, stdinText: string): string {
  const cleanPrompt = prompt.trim();
  const cleanStdin = stdinText.trim();
  if (cleanPrompt === "-") return cleanStdin;
  if (!cleanStdin) return cleanPrompt;
  if (!cleanPrompt) return cleanStdin;
  return `${cleanPrompt}\n\n--- stdin ---\n${cleanStdin}`;
}

export function buildCliLocalWorkspacePrompt(prompt: string, cwd = process.cwd(), imagesCount = 0): {
  prompt: string;
  attached: boolean;
  routeIntent: string;
} {
  const routeIntent = classifyRouteIntent(prompt, { imagesCount });
  if (imagesCount > 0 || !shouldAttachLocalWorkspaceContext(prompt, routeIntent)) {
    return { prompt, attached: false, routeIntent };
  }
  const workspaceContext = buildLocalWorkspaceContext({
    promptText: prompt,
    cwd,
    maxEntries: 120,
    maxDocs: 8,
    maxDocChars: 3200,
  });
  return {
    prompt: [
      workspaceContext,
      "",
      "【Lynn CLI 本地文件任务要求】上方快照来自 Lynn CLI 在本机真实读取，不是模型猜测。请基于这些事实回答；如果还需要更精确的文件、目录或内容检索，请明确说明需要用户切到 `Lynn code`/执行模式，而不要把本地路径当网页或回答“我没有本地文件系统权限”。",
      "",
      prompt,
    ].join("\n"),
    attached: true,
    routeIntent,
  };
}

const CLI_DIRECT_RESEARCH_KINDS = new Set(["market", "weather", "sports", "news", "public_data"]);

function toolNameForReportKind(kind: string): string {
  switch (kind) {
    case "market": return "stock_market";
    case "weather": return "weather";
    case "sports": return "sports_score";
    case "news": return "live_news";
    case "public_data": return "web_search";
    default: return "research_prefetch";
  }
}

function shouldUseCliDirectResearchAnswer(kind: string, promptText: string, directAnswer: string): boolean {
  if (!CLI_DIRECT_RESEARCH_KINDS.has(kind)) return false;
  const answer = directAnswer.trim();
  if (!answer) return false;
  if (kind === "public_data"
    && /(?:DGX\s*Spark|RTX\s*Spark|download\.merkyorlynn\.com|Lynn\s+v?0\.85\.1|Gitee.*Lynn|CUDA\s*Toolkit\s*13|Python\s*3\.13|Node\.?js|Kimi\s*K2\.7\s*Code|GLM\s*5\.0\s*Turbo|Responses\s*API|Anthropic\s+docs?.{0,24}Claude\s+Code|Claude\s+Code.{0,24}Anthropic\s+docs?|Microsoft\s+Windows\s+on\s+Arm|Windows\s+on\s+Arm)/i.test(promptText)) {
    return true;
  }
  if (/(?:深度|完整|全面|系统(?:性)?|报告|调研|研究|分析|对比|比较|引用|来源列表|research|report|analysis|compare)/i.test(promptText)) {
    return false;
  }
  if (kind === "sports" && /预测|预估|猜|看好|可能比分|比分预测|predict|prediction|forecast/i.test(promptText) && /专用体育比分源返回失败|暂未形成可核验/.test(answer)) {
    return false;
  }
  if (kind !== "sports" && /(?:列出|表格|小表格|table)/i.test(promptText)) return false;
  return true;
}

async function tryBuildCliDirectResearchAnswer(promptText: string): Promise<{ answer: string; kind: string; toolName: string } | null> {
  const kind = inferReportResearchKind(promptText);
  if (!CLI_DIRECT_RESEARCH_KINDS.has(kind)) return null;
  const context = await buildReportResearchContext(promptText, { userPrompt: promptText });
  const answer = buildDirectResearchAnswer(kind, context, promptText);
  if (!shouldUseCliDirectResearchAnswer(kind, promptText, answer)) return null;
  return {
    answer,
    kind,
    toolName: toolNameForReportKind(kind),
  };
}

async function emitLocalPromptAnswer(args: {
  text: string;
  prompt: string;
  saveSession: boolean;
  dataDir: string;
  sessionPath: string;
  cwd: string;
  title: string;
  json: boolean;
  meta: Record<string, unknown>;
  modelProvider: string;
  modelId: string;
  onAssistantComplete?: (text: string) => void | Promise<void>;
}): Promise<number> {
  if (args.json) {
    writeJsonLine({ type: "assistant.delta", ts: nowIso(), text: args.text });
    writeJsonLine({ type: "run.finished", ts: nowIso(), ok: true, ...args.meta });
  } else {
    process.stdout.write(`${args.text}\n`);
  }
  if (args.saveSession) {
    const savedPath = await appendSessionTurn({
      dataDir: args.dataDir,
      sessionPath: args.sessionPath,
      cwd: args.cwd,
      title: args.title,
      prompt: args.prompt,
      assistant: args.text,
      modelProvider: args.modelProvider,
      modelId: args.modelId,
    });
    if (args.json) writeJsonLine({ type: "session.saved", ts: nowIso(), path: savedPath });
  }
  await args.onAssistantComplete?.(args.text);
  return 0;
}

export async function runPrompt(args: ParsedArgs, options: PromptOptions = {}): Promise<number> {
  const rawPrompt = resolvePrompt(args);
  const voice = await transcribeVoiceInput(args);
  const promptSeed = voice ? mergePromptAndVoice(rawPrompt, voice.text) : rawPrompt;
  const stdinText = await readPromptStdin(rawPrompt.trim() === "-" ? rawPrompt : promptSeed);
  const prompt = mergePromptAndStdin(promptSeed, stdinText);
  if (!prompt) {
    throw new Error("prompt is required");
  }
  const reasoning = parseReasoningOptions(args);
  const brainUrl = await resolveDefaultBrainUrl(args);
  const saveSession = hasFlag(args.flags, "save-session", "session") || !!process.env.LYNN_CLI_SAVE_SESSION;
  const sessionPath = getStringFlag(args.flags, "session");
  const dataDir = resolveDataDir(getStringFlag(args.flags, "data-dir"));
  const title = getStringFlag(args.flags, "title");
  const cliProvider = await resolveCliProviderProfile(args);
  const imagePaths = promptImagePaths(args);
  const stopAtJson = !!options.json && hasFlag(args.flags, "stop-at-json", "json-boundary-stop");
  const effectiveCwd = getStringFlag(args.flags, "cwd") || process.cwd();
  const localWorkspace = buildCliLocalWorkspacePrompt(prompt, effectiveCwd, imagePaths.length);
  const modelPrompt = localWorkspace.prompt;
  const disableBrainToolsForPrompt = !imagePaths.length && !voice && shouldDisableToolsForTurn(prompt);

  if (options.json) {
    if (voice) {
      writeJsonLine({
        type: "voice.transcript",
        ts: nowIso(),
        text: voice.text,
        provider: voice.provider,
      });
    }
    writeJsonLine({ type: "run.started", ts: nowIso(), prompt, reasoning, ...(imagePaths.length ? { images: imagePaths } : {}) });
  }

  if (!imagePaths.length && isLocalRuntimeQuestion(prompt)) {
    const text = renderLocalRuntimeAnswer({
      routeLabel: chatRouteLabel(cliProvider?.profile),
      brainUrl,
      cwd: effectiveCwd,
      reasoning: reasoning.effort,
      question: prompt,
    }, localeForText(prompt));
    return emitLocalPromptAnswer({
      text,
      prompt,
      saveSession,
      dataDir,
      sessionPath,
      cwd: effectiveCwd,
      title,
      json: !!options.json,
      meta: { local: true },
      modelProvider: "lynn-cli",
      modelId: "local-runtime",
      onAssistantComplete: options.onAssistantComplete,
    });
  }

  if (!imagePaths.length) {
    const deterministic = buildLocalOfficeDirectAnswer(prompt);
    if (deterministic.trim()) {
      const text = deterministic;
      return emitLocalPromptAnswer({
        text,
        prompt,
        saveSession,
        dataDir,
        sessionPath,
        cwd: effectiveCwd,
        title,
        json: !!options.json,
        meta: { local: true, deterministic: true },
        modelProvider: "lynn-cli",
        modelId: "local-deterministic",
        onAssistantComplete: options.onAssistantComplete,
      });
    }
  }

  if (!imagePaths.length && !voice && !disableBrainToolsForPrompt) {
    const directResearch = await tryBuildCliDirectResearchAnswer(prompt).catch(() => null);
    if (directResearch?.answer?.trim()) {
      if (options.json) {
        writeJsonLine({
          type: "tool_progress",
          ts: nowIso(),
          event: "start",
          name: directResearch.toolName,
          argsSummary: prompt,
        });
        writeJsonLine({
          type: "tool_progress",
          ts: nowIso(),
          event: "end",
          name: directResearch.toolName,
          ok: true,
          summary: { kind: directResearch.kind },
        });
      }
      return emitLocalPromptAnswer({
        text: directResearch.answer,
        prompt,
        saveSession,
        dataDir,
        sessionPath,
        cwd: effectiveCwd,
        title,
        json: !!options.json,
        meta: { local: true, researchPrefetch: true, kind: directResearch.kind },
        modelProvider: "lynn-cli",
        modelId: "local-research-prefetch",
        onAssistantComplete: options.onAssistantComplete,
      });
    }
  }

  if (options.mockBrain) {
    const text = t("mock.response", { text: prompt });
    if (options.json) {
      writeJsonLine({ type: "assistant.delta", ts: nowIso(), text });
      writeJsonLine({ type: "run.finished", ts: nowIso(), ok: true });
    } else {
      process.stdout.write(`${text}\n`);
    }
    if (saveSession) {
      const savedPath = await appendSessionTurn({ dataDir, sessionPath, cwd: effectiveCwd, title, prompt, assistant: text, modelProvider: "mock", modelId: "mock-brain" });
      if (options.json) writeJsonLine({ type: "session.saved", ts: nowIso(), path: savedPath });
    }
    await options.onAssistantComplete?.(text);
    return 0;
  }

  if (!imagePaths.length && shouldUseLocalWorkspaceDirectReply(prompt, localWorkspace.routeIntent)) {
    const directReply = buildLocalWorkspaceDirectReply({
      promptText: prompt,
      cwd: effectiveCwd,
      maxEntries: 120,
      maxDocs: 8,
      maxDocChars: 3200,
    });
    if (directReply.ok && directReply.text.trim()) {
      const text = directReply.text;
      return emitLocalPromptAnswer({
        text,
        prompt,
        saveSession,
        dataDir,
        sessionPath,
        cwd: effectiveCwd,
        title,
        json: !!options.json,
        meta: { local: true, localWorkspace: true },
        modelProvider: "lynn-cli",
        modelId: "local-workspace",
        onAssistantComplete: options.onAssistantComplete,
      });
    }
  }

  let assistant = "";
  let sawReasoning = false;
  let lastUsage: unknown = null;
  let modelProvider = "brain";
  let modelId = "lynn-brain-router";
  const renderState: HumanBrainRenderState = {};
  const spinner = new TerminalSpinner(process.stderr, t("spinner.thinking"), { quiet: true });
  const startedAt = Date.now();
  if (!options.json) spinner.start();
  try {
    const userContent = imagePaths.length ? await buildImagesContentParts(imagePaths, prompt) : modelPrompt;
    const maxVisibleAnswerAttempts = 3;
    for (let attempt = 0; attempt < maxVisibleAnswerAttempts; attempt += 1) {
      let attemptAssistant = "";
      let attemptSawReasoning = false;
      const retryVisibleAnswer = attempt > 0;
      const messages: ChatMessage[] = [
        ...resetCliRuntimeMessages(chatRouteLabel(cliProvider?.profile)),
        ...(disableBrainToolsForPrompt
          ? [{
              role: "system" as const,
              content: buildNoToolTurnPrompt(prompt),
            }]
          : []),
        ...(retryVisibleAnswer
          ? [{
              role: "system" as const,
              content: "The previous attempt returned hidden reasoning without a visible answer. Return a concise visible final answer in assistant content. Do not return reasoning only.",
            }]
          : []),
        {
          role: "user" as const,
          content: userContent,
        },
      ];
      // On a visible-answer retry, step reasoning down so a budget-overflowing think shrinks
      // and leaves room for the answer (mirrors the Brain-side length-retry).
      const attemptReasoning = retryVisibleAnswer
        ? { ...reasoning, effort: lowerReasoningEffort(reasoning.effort) }
        : reasoning;
      for await (const event of streamBrainChat({
        brainUrl,
        messages,
        reasoning: attemptReasoning,
        fallbackProvider: cliProvider?.profile,
      })) {
        const renderReasoning = shouldRenderReasoning(reasoning.display, !!options.json);
        // Streaming usage frames update the waiting spinner instead of printing one line per
        // frame (the old behavior scrolled dozens of "usage:" lines per turn). The final usage
        // line prints once after the loop.
        if (event.type === "usage" && !options.json) {
          lastUsage = event.usage;
          if (!attemptAssistant) {
            const label = thinkingStatusLabel(event.usage, startedAt);
            if (label) spinner.setLabel(label);
          }
          continue;
        }
        if (!options.json && eventWritesHumanOutput(event, renderReasoning)) {
          spinner.stop();
        }
        if (event.type === "brain.error") {
          if (options.json) {
            handleBrainEvent(event, {
              json: true,
              renderReasoning,
              renderState,
              startedAt,
            });
          }
          throw new Error(formatBrainErrorForHuman(event.error, event.code));
        }
        if (event.type === "assistant.delta" && stopAtJson) {
          const nextAssistant = attemptAssistant + event.text;
          const boundary = completeJsonBoundary(nextAssistant);
          if (boundary !== null) {
            const boundedAssistant = nextAssistant.slice(0, boundary);
            const boundedDelta = boundedAssistant.slice(attemptAssistant.length);
            if (boundedDelta) {
              handleBrainEvent({ ...event, text: boundedDelta }, {
                json: true,
                renderReasoning,
                renderState,
                startedAt,
              });
            }
            attemptAssistant = boundedAssistant;
            writeJsonLine({
              type: "run.boundary_stop",
              ts: nowIso(),
              boundary: "json",
              reason: "complete_json_visible",
            });
            break;
          }
        }
        handleBrainEvent(event, {
          json: !!options.json,
          renderReasoning,
          renderState,
          startedAt,
        });
        if (event.type === "provider") {
          if (event.activeProvider.startsWith("cli-byok:") && cliProvider) {
            modelProvider = cliProvider.profile.provider;
            modelId = cliProvider.profile.model;
          } else {
            modelProvider = event.activeProvider;
            modelId = "lynn-brain-router";
          }
        }
        if (event.type === "reasoning.delta") {
          sawReasoning = true;
          attemptSawReasoning = true;
        }
        if (event.type === "assistant.delta") attemptAssistant += event.text;
        // Waiting states between visible outputs (route card, tool progress) resume the spinner
        // so the thinking phase stays animated instead of leaving dead air.
        if (!options.json && !attemptAssistant && (event.type === "provider" || event.type === "tool_progress")) {
          spinner.start();
        }
      }
      if (attemptAssistant.trim()) {
        assistant = attemptAssistant;
        break;
      }
      if (attemptSawReasoning && attempt < maxVisibleAnswerAttempts - 1) {
        if (options.json) {
          writeJsonLine({
            type: "run.retry",
            ts: nowIso(),
            code: "empty_visible_answer",
            reason: "hidden_reasoning_only",
          });
        }
        continue;
      }
      assistant = attemptAssistant;
      break;
    }
  } finally {
    spinner.stop();
  }
  if (!assistant.trim()) {
    const message = sawReasoning ? t("prompt.emptyAfterReasoning") : t("prompt.empty");
    if (options.json) {
      writeJsonLine({
        type: "run.finished",
        ts: nowIso(),
        ok: false,
        code: "empty_visible_answer",
        error: message,
        reasoningReturned: sawReasoning,
      });
    } else {
      process.stderr.write(`${message}\n`);
    }
    return 2;
  }
  if (saveSession) {
    const savedPath = await appendSessionTurn({
      dataDir,
      sessionPath,
      cwd: effectiveCwd,
      title,
      prompt,
      assistant,
      modelProvider,
      modelId,
    });
    if (options.json) writeJsonLine({ type: "session.saved", ts: nowIso(), path: savedPath });
  }
  if (options.json) {
    writeJsonLine({ type: "run.finished", ts: nowIso(), ok: true, reasoningReturned: sawReasoning });
  } else {
    process.stdout.write("\n");
    const summary = lastUsage ? summarizeUsage(lastUsage, { durationMs: Date.now() - startedAt }) : null;
    if (summary) process.stderr.write(`usage: ${summary}\n`);
  }
  await options.onAssistantComplete?.(assistant);
  return 0;
}

function eventWritesHumanOutput(event: BrainStreamEvent, renderReasoning: boolean): boolean {
  return event.type === "assistant.delta"
    || event.type === "provider"
    || event.type === "tool_progress"
    || event.type === "brain.error"
    || (event.type === "reasoning.delta" && renderReasoning);
}

function promptImagePaths(args: ParsedArgs): string[] {
  return [
    ...parseImageList(getStringFlag(args.flags, "images")),
    ...parseImageList(getStringFlag(args.flags, "image", "shot")),
  ];
}

async function readPromptStdin(prompt: string): Promise<string> {
  if (prompt.trim() !== "-" && process.stdin.isTTY) return "";
  if (prompt.trim() !== "-") return readOptionalStdin(100);
  try {
    let text = "";
    for await (const chunk of process.stdin) {
      text += String(chunk);
    }
    return text;
  } catch {
    return "";
  }
}

function readOptionalStdin(firstChunkTimeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let text = "";
    let settled = false;
    let sawData = false;
    let timer: NodeJS.Timeout | null = setTimeout(() => finish(), firstChunkTimeoutMs);
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.off("error", onEnd);
      process.stdin.pause();
      resolve(text);
    };
    const onData = (chunk: Buffer | string) => {
      sawData = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      text += String(chunk);
    };
    const onEnd = () => finish();
    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
    process.stdin.once("error", onEnd);
    process.stdin.resume();
    if (sawData && timer) {
      clearTimeout(timer);
      timer = null;
    }
  });
}

function handleBrainEvent(event: BrainStreamEvent, opts: { json: boolean; renderReasoning: boolean; renderState: HumanBrainRenderState; startedAt?: number }): void {
  if (opts.json) {
    if (event.type === "assistant.delta" || event.type === "reasoning.delta") {
      writeJsonLine({ ...event, ts: nowIso() });
    } else if (event.type === "provider" || event.type === "tool_progress" || event.type === "brain.error") {
      writeJsonLine({ ...event, ts: nowIso() });
    } else if (event.type === "usage") {
      writeJsonLine({ type: "usage", ts: nowIso(), usage: event.usage, durationMs: opts.startedAt ? Date.now() - opts.startedAt : undefined });
    }
    return;
  }

  if (event.type === "assistant.delta") {
    process.stdout.write(event.text);
  } else if (event.type === "reasoning.delta" && opts.renderReasoning) {
    process.stderr.write(event.text);
  } else if (event.type === "usage") {
    // Human mode: streaming usage is consumed by the spinner label in the run loop; the final
    // usage line prints once after the turn. (JSON mode still emits every usage frame above.)
  } else {
    renderBrainEventForHuman(event, opts.renderState, process.stderr);
  }
}
