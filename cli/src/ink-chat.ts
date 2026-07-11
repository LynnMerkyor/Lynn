import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Static, Text, render, useApp, useInput } from "ink";
import { detectImageProtocol, renderImageThumbnail } from "./terminal-image.js";
import { getStringFlag, hasFlag, type ParsedArgs } from "./args.js";
import { streamBrainChat, type BrainStreamEvent, type ChatMessage } from "./brain-client.js";
import { formatBrainErrorForHuman, summarizeUsage } from "./brain-render.js";
import { HistoryNavigator, appendHistory, historyPath, loadHistory } from "./history.js";
import { t } from "./i18n.js";
import { completeSlash } from "./completion.js";
import { normalizeSlashInput } from "./completion.js";
import { completeMentionInput } from "./mentions.js";
import { applyFastReasoning, parseReasoningOptions, shouldRenderReasoning, type ReasoningOptions } from "./reasoning.js";
import { resolveCliProviderProfile, type CliProviderProfile } from "./provider-profile.js";
import { resolveEffectivePermissions } from "./permissions.js";
import { displayCwd } from "./startup.js";
import { CHAT_SLASH_COMMANDS, applyModeCommand, applyReasoningCommand, chatRouteLabel, renderMode, type ChatMode } from "./commands/chat.js";
import { InkMarkdown } from "./ink-markdown.js";
import { handleInkProviderCommand } from "./ink-provider-commands.js";
import { InkInputLine } from "./ink-input-line.js";
import { refreshCliRuntimeSystemMessage, resetCliRuntimeMessages } from "./runtime-context.js";
import { isLocalRuntimeQuestion, localeForText, renderLocalRuntimeAnswer } from "./runtime-answer.js";
import { analyzePastedContext, appendPastedText, parseImagePromptCommand, summarizeImageRefs, summarizePastedContext } from "./pasted-context.js";
import { buildImagesContentParts } from "./media.js";
import { buildMemoryContextFrameSync, handleMemorySlashCommand } from "./session/memory.js";
import { resolveDataDir } from "./session/store.js";
import { rotatingPlaceholder } from "./ink-placeholders.js";
import { resolveDefaultBrainUrl } from "./brain-url.js";
import { runRealtimeVoice } from "./voice-realtime.js";
import { argsForChatVoiceLaunch, parseChatVoiceLaunchCommand, type ChatVoiceLaunch } from "./voice-command.js";
import { createDecodeSpeedTracker } from "./decode-speed.js";
import { terminalTuiProfile } from "./terminal-safety.js";

// Set by /voice or lynn voice; consumed by runInkChat's loop to hand off to realtime voice
// (ink must fully unmount before the voice session takes the terminal, then chat re-enters).
let pendingVoiceLaunch: ChatVoiceLaunch | null = null;
export { parseChatVoiceLaunchCommand as parseInkVoiceLaunchCommand } from "./voice-command.js";

type Turn = {
  id: number;
  role: "user" | "assistant" | "system";
  text: string;
  meta?: string;
  trace?: TraceLine[];
  pending?: boolean;
  error?: boolean;
};

export type TraceLine = {
  id: number;
  kind: "reasoning" | "tool";
  text: string;
  status?: "running" | "done" | "failed";
  ms?: number;
  ok?: boolean;
  toolName?: string;
  argsSummary?: string;
};

interface InkChatProps {
  args: ParsedArgs;
  brainUrl: string;
  mockBrain: boolean;
  initialReasoning: ReasoningOptions;
  initialMode: ChatMode;
  fallbackProvider?: CliProviderProfile | null;
}

export async function runInkChat(args: ParsedArgs): Promise<number> {
  const mockBrain = hasFlag(args.flags, "mock-brain", "mock");
  const brainUrl = await resolveDefaultBrainUrl(args);
  const initialReasoning = parseReasoningOptions(args);
  const permissions = await resolveEffectivePermissions(args);
  const initialMode: ChatMode = { approval: permissions.approval, sandbox: permissions.sandbox };
  const fallbackProvider = (await resolveCliProviderProfile(args))?.profile || null;
  // Loop so /voice can hand off to the realtime voice session and then re-enter chat.
  for (;;) {
    pendingVoiceLaunch = null;
    const instance = render(React.createElement(InkChatApp, {
      args,
      brainUrl,
      mockBrain,
      initialReasoning,
      initialMode,
      fallbackProvider,
    }));
    await instance.waitUntilExit();
    // cast: TS can't see that waitUntilExit() let the /voice handler mutate the module var.
    const pending = pendingVoiceLaunch as ChatVoiceLaunch | null;
    if (!pending) return 0;
    pendingVoiceLaunch = null;
    // ink has unmounted and restored the terminal; run the voice session inline, then re-render chat.
    const voiceArgs: ParsedArgs = argsForChatVoiceLaunch(args, pending);
    try { await runRealtimeVoice(voiceArgs, { embedded: true }); } catch { /* fall back to chat */ }
  }
}

type Thumb = { id: number; esc: string };

async function emitThumbnails(text: string, cwd: string, setThumbs: (updater: (prev: Thumb[]) => Thumb[]) => void, inlineImages = true): Promise<void> {
  if (!inlineImages) return;
  const protocol = detectImageProtocol();
  if (!protocol) return;
  const refs = analyzePastedContext(text, cwd).imageRefs;
  if (!refs.length) return;
  const next: Thumb[] = [];
  for (const ref of refs) {
    const esc = await renderImageThumbnail(ref.path, protocol, { widthCells: 28, heightCells: 8, maxBytes: 6_000_000 });
    if (esc) next.push({ id: Date.now() + next.length, esc });
  }
  if (next.length) setThumbs((prev) => [...prev, ...next]);
}

function InkChatApp(props: InkChatProps): React.ReactElement {
  const app = useApp();
  const profile = useMemo(() => terminalTuiProfile(), []);
  const [input, setInput] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [frame, setFrame] = useState(0);
  const [reasoning, setReasoning] = useState(props.initialReasoning);
  const [mode, setMode] = useState(props.initialMode);
  const [fallbackProvider, setFallbackProvider] = useState<CliProviderProfile | null>(props.fallbackProvider || null);
  const [provider, setProvider] = useState(chatRouteLabel(props.fallbackProvider));
  const [usage, setUsage] = useState<string | null>(null);
  const [decodeTps, setDecodeTps] = useState<string | null>(null);
  const [thumbs, setThumbs] = useState<Thumb[]>([]);
  const [history] = useState(() => new HistoryNavigator(loadHistory(historyPath())));
  const dataDir = useMemo(() => resolveDataDir(getStringFlag(props.args.flags, "data-dir")), [props.args.flags]);
  const effectiveCwd = getStringFlag(props.args.flags, "cwd") || process.cwd();
  const contextInfo = useMemo(() => analyzePastedContext(input, effectiveCwd), [input, effectiveCwd]);
  const [memoryFrame, setMemoryFrame] = useState(() => buildMemoryContextFrameSync(dataDir));
  const activeAbortRef = useRef<AbortController | null>(null);
  const messages = useMemo<ChatMessage[]>(() => resetCliRuntimeMessages(chatRouteLabel(props.fallbackProvider), memoryFrame), [props.fallbackProvider]);
  const placeholderFrame = Math.floor(frame / 43);

  useEffect(() => {
    // Always animate (not only while busy) so the top flowing-light banner keeps flowing. Gated by
    // profile.animation → safe/dumb terminals (and LYNN_CLI_NO_TUI_ANIMATION=1) get a static banner.
    if (!profile.animation) return;
    const timer = setInterval(() => setFrame((value) => value + 1), 140);
    return () => clearInterval(timer);
  }, [profile.animation]);

  useInput((value, key) => {
    if (key.ctrl && value === "c") {
      if (busy && activeAbortRef.current && !activeAbortRef.current.signal.aborted) {
        activeAbortRef.current.abort(new Error(t("chat.cancelled")));
        return;
      }
      app.exit();
      return;
    }
    if (busy) return;
    const newlineIndex = value.search(/[\r\n]/);
    if (!key.return && newlineIndex >= 0) {
      const lines = value.replace(/\r\n?/g, "\n").split("\n");
      if (!lines.slice(1).some((line) => line.length > 0)) {
        void submitInput({
          text: `${input}${lines[0] || ""}`,
          setInput,
          setTurns,
          setBusy,
          setProvider,
          setUsage,
          setDecodeTps,
          setReasoning,
          setMode,
          fallbackProvider,
          setFallbackProvider,
          appExit: app.exit,
          messages,
          props,
          reasoning,
          mode,
          dataDir,
          memoryFrame,
          setMemoryFrame,
          cwd: effectiveCwd,
          activeAbortRef,
        });
        return;
      }
      setInput((current) => appendPastedText(current, value));
      return;
    }
    if (key.return && (key.shift || key.meta)) {
      const prefix = newlineIndex >= 0 ? value.slice(0, newlineIndex) : "";
      setInput((current) => `${current}${prefix}\n`);
      return;
    }
    if (key.return && input.endsWith("\\")) {
      const prefix = newlineIndex >= 0 ? value.slice(0, newlineIndex) : "";
      setInput((current) => `${current.slice(0, -1)}${prefix}\n`);
      return;
    }
    if (key.return) {
      const prefix = newlineIndex >= 0 ? value.slice(0, newlineIndex) : "";
      const submitted = `${input}${prefix}`;
      void emitThumbnails(submitted, effectiveCwd, setThumbs, profile.inlineImages);
      void submitInput({
        text: submitted,
        setInput,
        setTurns,
        setBusy,
        setProvider,
        setUsage,
        setDecodeTps,
        setReasoning,
        setMode,
        fallbackProvider,
        setFallbackProvider,
        appExit: app.exit,
        messages,
        props,
        reasoning,
        mode,
        dataDir,
        memoryFrame,
        setMemoryFrame,
        cwd: effectiveCwd,
        activeAbortRef,
      });
      return;
    }
    if (key.backspace || key.delete) {
      setInput((current) => Array.from(current).slice(0, -1).join(""));
      return;
    }
    if (key.upArrow) {
      setInput((current) => history.prev(current));
      return;
    }
    if (key.downArrow) {
      setInput(history.next());
      return;
    }
    if (key.tab) {
      const mentionCompletion = completeMentionInput(input, effectiveCwd);
      if (mentionCompletion) {
        const completion = mentionCompletion;
        if (completion.matches.length > 1) {
          setTurns((current) => [...current, { id: Date.now(), role: "system", text: completion.matches.slice(0, 12).join("  "), meta: "completions" }]);
        }
        setInput(completion.completed);
        return;
      }
      const completion = completeSlash(input, CHAT_SLASH_COMMANDS);
      if (completion.matches.length > 1) {
        setTurns((current) => [...current, { id: Date.now(), role: "system", text: completion.matches.join("  "), meta: "completions" }]);
      }
      setInput(completion.completed);
      return;
    }
    if (value) setInput((current) => current + value);
  });

  const recentTurns = turns.slice(-8);
  return React.createElement(Box, { flexDirection: "column", paddingX: 1 },
    React.createElement(Static, {
      items: thumbs,
      children: (item: unknown) => {
        const thumb = item as Thumb;
        return React.createElement(Box, { key: thumb.id, height: 8 }, React.createElement(Text, null, thumb.esc));
      },
    }),
    React.createElement(InkTopBanner, { width: (process.stdout.columns || 80) - 4, frame, animated: profile.animation }),
    React.createElement(Box, { borderStyle: "round", borderColor: "gray", paddingX: 1, flexDirection: "column" },
      React.createElement(Text, { bold: true }, "Lynn CLI"),
      React.createElement(Text, null, `模型: ${provider}`),
      React.createElement(Text, null, `权限: ${renderMode(mode)}   Shift+Tab / /yolo / /ask`),
      React.createElement(Text, null, `Brain: ${props.brainUrl}`),
      React.createElement(Text, null, t("chat.voice.hint")),
      React.createElement(Text, null, `目录: ${displayCwd(effectiveCwd)}   cd / --cwd 切换`),
    ),
    React.createElement(Box, { marginTop: 1, flexDirection: "column" },
      recentTurns.length
        ? recentTurns.map((turn) => React.createElement(TurnView, { key: turn.id, turn }))
        : React.createElement(Text, { color: "gray" }, t("chat.placeholder")),
    ),
    busy
      ? profile.animation
        ? React.createElement(Box, { flexDirection: "row" },
          React.createElement(InkShimmerText, { text: t("spinner.thinking"), frame }),
          React.createElement(Text, null, " "),
          React.createElement(InkSweep, { width: 28, frame }),
        )
        : React.createElement(Text, { color: "cyan" }, t("spinner.thinking"))
      : null,
    React.createElement(Text, { color: "gray" }, `${provider} · ${displayCwd(effectiveCwd)} · ${renderMode(mode)} · think ${reasoning.effort}${decodeTps ? ` · decode ${decodeTps}` : ""}${usage ? ` · ${usage}` : ""}`),
    React.createElement(InkInputLine, {
      value: input,
      placeholder: profile.dynamicPlaceholders ? rotatingPlaceholder("chat", placeholderFrame) : t("chat.placeholder"),
      danger: mode.approval === "yolo" || mode.sandbox === "danger-full-access",
      commands: CHAT_SLASH_COMMANDS,
      contextSummary: contextInfo.hasContext ? summarizePastedContext(contextInfo) : "",
    }),
  );
}

function TurnView({ turn }: { turn: Turn }): React.ReactElement {
  if (turn.role === "user") {
    return React.createElement(Box, { marginTop: 1, flexDirection: "column" },
      React.createElement(Box, null,
        React.createElement(Text, { color: "gray" }, "› "),
        React.createElement(Text, null, turn.text),
      ),
      turn.meta ? React.createElement(Text, { color: "cyan" }, `  ${turn.meta}`) : null,
    );
  }
  if (turn.role === "system") {
    return React.createElement(Text, { color: turn.error ? "red" : "gray" }, turn.text);
  }
  return React.createElement(Box, { marginTop: 1, flexDirection: "column" },
    turn.meta ? React.createElement(Text, { color: "gray" }, turn.meta) : null,
    turn.trace?.length
      ? React.createElement(Box, { flexDirection: "column", marginBottom: turn.text ? 1 : 0 },
        ...turn.trace.map((trace) => React.createElement(TraceLineView, { key: trace.id, trace })),
      )
      : null,
    React.createElement(InkMarkdown, { text: turn.text, error: turn.error }),
  );
}

function TraceLineView({ trace }: { trace: TraceLine }): React.ReactElement {
  if (trace.kind === "reasoning") {
    return React.createElement(Text, { color: "gray" },
      "• ",
      React.createElement(Text, { dimColor: true }, trace.text),
    );
  }
  const color = trace.status === "failed" ? "red" : trace.status === "done" ? "green" : "cyan";
  const dot = trace.status === "failed" ? "✕" : trace.status === "done" ? "●" : "•";
  return React.createElement(Text, null,
    React.createElement(Text, { color }, dot),
    " ",
    React.createElement(Text, { color: trace.status === "running" ? "cyan" : undefined, bold: trace.status === "done" }, trace.text),
    trace.ms !== undefined ? React.createElement(Text, { color: "gray" }, ` ${formatTraceMs(trace.ms)}`) : null,
  );
}

function InkShimmerText({ text, frame }: { text: string; frame: number }): React.ReactElement {
  const chars = Array.from(text);
  const head = frame % (chars.length + 6);
  return React.createElement(Text, null,
    ...chars.map((char, index) => {
      const distance = Math.abs(index - head);
      if (distance === 0) return React.createElement(Text, { key: index, color: "cyan", bold: true }, char);
      if (distance <= 1) return React.createElement(Text, { key: index, color: "cyan" }, char);
      if (distance <= 3) return React.createElement(Text, { key: index, color: "gray" }, char);
      return React.createElement(Text, { key: index }, char);
    }),
  );
}

function InkSweep({ width, frame }: { width: number; frame: number }): React.ReactElement {
  const head = (frame % (width + 8)) - 4;
  return React.createElement(Text, null,
    ...Array.from({ length: width }, (_, index) => {
      const distance = Math.abs(index - head);
      if (distance === 0) return React.createElement(Text, { key: index, color: "cyan", bold: true }, "━");
      if (distance <= 1) return React.createElement(Text, { key: index, color: "cyan" }, "━");
      if (distance <= 3) return React.createElement(Text, { key: index, color: "gray" }, "─");
      return React.createElement(Text, { key: index }, " ");
    }),
  );
}

// kimi-code-style flowing-light header. Pure render, gated by profile.animation (static fallback
// on safe/dumb terminals). Reuses the shared `frame` counter — no extra timers.
const BANNER_GRADIENT = ["cyan", "cyanBright", "blueBright", "blue", "magentaBright", "magenta", "blueBright", "cyanBright"];

function InkTopBanner({ width, frame, animated }: { width: number; frame: number; animated: boolean }): React.ReactElement {
  const barWidth = Math.max(16, Math.min(Number.isFinite(width) ? width : 72, 72));
  const title = Array.from("◆ LYNN");
  const head = (frame % (barWidth + 10)) - 5;
  return React.createElement(Box, { flexDirection: "column", marginBottom: 1 },
    React.createElement(Text, null,
      ...title.map((ch, i) => React.createElement(Text, {
        key: i,
        color: animated ? BANNER_GRADIENT[(i + frame) % BANNER_GRADIENT.length] : "cyan",
        bold: true,
      }, ch)),
      React.createElement(Text, { color: "gray" }, "  实时语音 · 编码 · 调研"),
    ),
    React.createElement(Text, null,
      ...Array.from({ length: barWidth }, (_, i) => {
        if (!animated) return React.createElement(Text, { key: i, color: "gray" }, "─");
        const color = BANNER_GRADIENT[(i + frame) % BANNER_GRADIENT.length];
        const distance = Math.abs(i - head);
        const char = distance <= 1 ? "━" : "─";
        return React.createElement(Text, { key: i, color, bold: distance === 0 }, char);
      }),
    ),
  );
}

type ToolProgressEvent = Extract<BrainStreamEvent, { type: "tool_progress" }>;

export function friendlyToolName(name: string): string {
  const normalized = String(name || "").trim();
  const known: Record<string, string> = {
    web_search: "SearchWeb",
    web_fetch: "FetchWeb",
    live_news: "LiveNews",
    sports_score: "SportsScore",
    stock_market: "StockMarket",
    weather: "Weather",
    exchange_rate: "ExchangeRate",
    calendar: "Calendar",
    unit_convert: "UnitConvert",
    express_tracking: "ExpressTracking",
    parallel_research: "ParallelResearch",
    create_report: "CreateReport",
    create_artifact: "CreateArtifact",
    create_pptx: "CreatePPTX",
    create_pdf: "CreatePDF",
  };
  return known[normalized] || normalized.replace(/(^|[_.-])([a-z])/g, (_m, sep: string, ch: string) => `${sep === "." ? "." : ""}${ch.toUpperCase()}`);
}

export function formatToolTraceText(event: ToolProgressEvent): string {
  const verb = event.event === "end" ? (event.ok === false ? "Failed" : "Used") : "Using";
  const arg = event.argsSummary ? ` (${event.argsSummary})` : "";
  return `${verb} ${friendlyToolName(event.name)}${arg}`;
}

function formatTraceMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  return ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s` : `${Math.round(ms)}ms`;
}

function compactTraceText(text: string, max = 180): string {
  const single = String(text || "").replace(/\s+/g, " ").trim();
  if (single.length <= max) return single;
  return `${single.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

function appendReasoningTrace(trace: TraceLine[] | undefined, delta: string): TraceLine[] {
  const traces = [...(trace || [])];
  const text = compactTraceText(`${traces.at(-1)?.kind === "reasoning" ? traces.at(-1)?.text || "" : ""}${delta}`);
  if (traces.at(-1)?.kind === "reasoning") {
    traces[traces.length - 1] = { ...traces[traces.length - 1], text };
  } else {
    traces.push({ id: Date.now() + traces.length, kind: "reasoning", text });
  }
  return traces.slice(-8);
}

function updateToolTrace(trace: TraceLine[] | undefined, event: ToolProgressEvent): TraceLine[] {
  const traces = [...(trace || [])];
  const status = event.event === "end" ? (event.ok === false ? "failed" : "done") : "running";
  const next: TraceLine = {
    id: Date.now() + traces.length,
    kind: "tool",
    status,
    ok: event.ok,
    toolName: event.name,
    argsSummary: event.argsSummary,
    ms: event.ms,
    text: formatToolTraceText(event),
  };
  if (event.event === "end") {
    const index = findLastToolTrace(traces, event.name, event.argsSummary);
    if (index >= 0) {
      traces[index] = { ...next, id: traces[index].id };
      return traces.slice(-8);
    }
  }
  traces.push(next);
  return traces.slice(-8);
}

function findLastToolTrace(traces: TraceLine[], name: string, argsSummary?: string): number {
  for (let i = traces.length - 1; i >= 0; i -= 1) {
    const trace = traces[i];
    if (trace.kind !== "tool" || trace.toolName !== name) continue;
    if (argsSummary && trace.argsSummary && trace.argsSummary !== argsSummary) continue;
    if (trace.status === "running") return i;
  }
  return -1;
}

async function submitInput(inputData: {
  text: string;
  setInput: (value: string) => void;
  setTurns: React.Dispatch<React.SetStateAction<Turn[]>>;
  setBusy: (value: boolean) => void;
  setProvider: (value: string) => void;
  setUsage: (value: string | null) => void;
  setDecodeTps: (value: string | null) => void;
  setReasoning: (value: ReasoningOptions) => void;
  setMode: (value: ChatMode) => void;
  fallbackProvider: CliProviderProfile | null;
  setFallbackProvider: (value: CliProviderProfile | null) => void;
  appExit: () => void;
  messages: ChatMessage[];
  props: InkChatProps;
  reasoning: ReasoningOptions;
  mode: ChatMode;
  dataDir: string;
  memoryFrame: string;
  setMemoryFrame: (value: string) => void;
  cwd: string;
  activeAbortRef: React.MutableRefObject<AbortController | null>;
}): Promise<void> {
  const text = normalizeSlashInput(inputData.text.trim());
  if (!text) return;
  inputData.setInput("");
  appendHistory(text, historyPath());

  if (text === "/exit" || text === "/quit") {
    inputData.appExit();
    return;
  }
  if (text === "/fast") {
    const next = applyFastReasoning(inputData.reasoning);
    inputData.setReasoning(next);
    inputData.setTurns((current) => [...current, { id: Date.now(), role: "system", text: t("chat.fast") }]);
    return;
  }
  if (text === "/think") {
    const next = { ...inputData.reasoning, effort: "high" as const, maxTokens: undefined };
    inputData.setReasoning(next);
    inputData.setTurns((current) => [...current, { id: Date.now(), role: "system", text: t("chat.think") }]);
    return;
  }
  const voiceLaunch = parseChatVoiceLaunchCommand(text);
  if (voiceLaunch) {
    // Hand off to realtime voice: exit ink, runInkChat runs runRealtimeVoice, then re-enters chat.
    pendingVoiceLaunch = voiceLaunch;
    inputData.setTurns((current) => [...current, { id: Date.now(), role: "system", text: "进入实时语音对话…(Ctrl+C 返回聊天)" }]);
    inputData.appExit();
    return;
  }
  if (text.startsWith("/reasoning ")) {
    const result = applyReasoningCommand(inputData.reasoning, text.slice(11).trim());
    inputData.setReasoning(result.reasoning);
    inputData.setTurns((current) => [...current, { id: Date.now(), role: "system", text: result.message }]);
    return;
  }
  if (text === "/yolo" || text === "/ask") {
    const next = { ...inputData.mode };
    const message = applyModeCommand(next, text.slice(1));
    inputData.setMode(next);
    const danger = next.approval === "yolo" || next.sandbox === "danger-full-access";
    const body = danger ? `${message}\n${t("mode.yolo.factory")}` : message;
    inputData.setTurns((current) => [...current, { id: Date.now(), role: "system", text: body, error: danger }]);
    return;
  }
  if (text.startsWith("/mode ")) {
    const next = { ...inputData.mode };
    const message = applyModeCommand(next, text.slice(6).trim());
    inputData.setMode(next);
    const danger = next.approval === "yolo" || next.sandbox === "danger-full-access";
    const body = danger ? `${message}\n${t("mode.yolo.factory")}` : message;
    inputData.setTurns((current) => [...current, { id: Date.now(), role: "system", text: body, error: danger }]);
    return;
  }
  if (text === "/help") {
    inputData.setTurns((current) => [...current, { id: Date.now(), role: "system", text: t("chat.help") }]);
    return;
  }
  if (isLocalRuntimeQuestion(text)) {
    const answer = renderLocalRuntimeAnswer({
      routeLabel: chatRouteLabel(inputData.fallbackProvider),
      brainUrl: inputData.props.brainUrl,
      cwd: inputData.cwd,
      mode: renderMode(inputData.mode),
      reasoning: inputData.reasoning.effort,
      question: text,
    }, localeForText(text));
    if (text.startsWith("/")) {
      inputData.setTurns((current) => [...current, { id: Date.now(), role: "system", text: answer }]);
      return;
    }
    inputData.messages.push({ role: "user", content: text }, { role: "assistant", content: answer });
    const userId = Date.now();
    inputData.setTurns((current) => [
      ...current,
      { id: userId, role: "user", text },
      { id: userId + 1, role: "assistant", text: answer },
    ]);
    return;
  }
  if (text === "/clear") {
      inputData.messages.splice(0, inputData.messages.length, ...resetCliRuntimeMessages(chatRouteLabel(inputData.fallbackProvider), inputData.memoryFrame));
      inputData.setTurns([]);
      return;
    }
  if (text === "/cwd" || text === "/pwd") {
    inputData.setTurns((current) => [...current, { id: Date.now(), role: "system", text: t("cwd.info", { cwd: inputData.cwd }) }]);
    return;
  }
  const memoryCommand = await handleMemorySlashCommand(text, inputData.dataDir);
  if (memoryCommand?.handled) {
    if (memoryCommand.changed) {
      const nextMemoryFrame = buildMemoryContextFrameSync(inputData.dataDir);
      inputData.setMemoryFrame(nextMemoryFrame);
      refreshCliRuntimeSystemMessage(inputData.messages, chatRouteLabel(inputData.fallbackProvider), nextMemoryFrame);
    }
    inputData.setTurns((current) => [...current, { id: Date.now(), role: "system", text: memoryCommand.message }]);
    return;
  }
  const providerCommand = await handleInkProviderCommand(text, inputData.props.args);
  if (providerCommand.handled) {
    if (providerCommand.refreshedProvider !== undefined) {
      inputData.setFallbackProvider(providerCommand.refreshedProvider);
      const nextRoute = chatRouteLabel(providerCommand.refreshedProvider);
      refreshCliRuntimeSystemMessage(inputData.messages, nextRoute, inputData.memoryFrame);
      inputData.setProvider(nextRoute);
    }
    inputData.setTurns((current) => [...current, { id: Date.now(), role: "system", text: providerCommand.message }]);
    return;
  }
  const imageCommand = parseImagePromptCommand(text, inputData.cwd);
  if (imageCommand) {
    if (!imageCommand.imageRefs.length) {
      inputData.setTurns((current) => [...current, { id: Date.now(), role: "system", text: t("chat.image.usage") }]);
      return;
    }
    let userContent: ChatMessage["content"];
    try {
      userContent = await buildImagesContentParts(imageCommand.imageRefs.map((ref) => ref.path), imageCommand.prompt);
    } catch (error) {
      inputData.setTurns((current) => [...current, {
        id: Date.now(),
        role: "system",
        text: t("chat.image.readError", { error: error instanceof Error ? error.message : String(error) }),
        error: true,
      }]);
      return;
    }
    await submitChatTurn({
      ...inputData,
      promptText: imageCommand.prompt,
      userContent,
      contextSummary: summarizeImageRefs(imageCommand.imageRefs),
    });
    return;
  }
  if (text.startsWith("/")) {
    inputData.setTurns((current) => [...current, { id: Date.now(), role: "system", text: t("slash.unknown") }]);
    return;
  }

  const context = analyzePastedContext(text, inputData.cwd);
  const promptText = context.text || (context.imageRefs.length ? t("chat.image.defaultPrompt") : text);
  let userContent: ChatMessage["content"] = promptText;
  const contextSummary = context.hasContext ? summarizePastedContext(context) : "";
  if (context.imageRefs.length) {
    try {
      userContent = await buildImagesContentParts(context.imageRefs.map((ref) => ref.path), promptText);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      inputData.setTurns((current) => [...current, { id: Date.now(), role: "system", text: `图片上下文无法读取:${message}`, error: true }]);
      return;
    }
  }

  await submitChatTurn({
    ...inputData,
    promptText,
    userContent,
    contextSummary,
  });
}

async function submitChatTurn(inputData: {
  setTurns: React.Dispatch<React.SetStateAction<Turn[]>>;
  setBusy: (value: boolean) => void;
  setProvider: (value: string) => void;
  setUsage: (value: string | null) => void;
  setDecodeTps: (value: string | null) => void;
  messages: ChatMessage[];
  props: InkChatProps;
  reasoning: ReasoningOptions;
  fallbackProvider: CliProviderProfile | null;
  promptText: string;
  userContent: ChatMessage["content"];
  contextSummary: string;
  activeAbortRef: React.MutableRefObject<AbortController | null>;
}): Promise<void> {
  const userTurn: Turn = { id: Date.now(), role: "user", text: inputData.promptText, meta: inputData.contextSummary };
  const assistantId = userTurn.id + 1;
  inputData.setTurns((current) => [...current, userTurn, { id: assistantId, role: "assistant", text: "", pending: true }]);
  inputData.messages.push({ role: "user", content: inputData.userContent });
  inputData.setBusy(true);
  inputData.setDecodeTps(null);

  if (inputData.props.mockBrain) {
    const answer = t("mock.response", { text: inputData.promptText });
    inputData.messages.push({ role: "assistant", content: answer });
    inputData.setTurns((current) => current.map((turn) => turn.id === assistantId ? { ...turn, text: answer, pending: false, meta: "mock Brain" } : turn));
    inputData.setBusy(false);
    return;
  }

  let assistant = "";
  const startedAt = Date.now();
  const decodeTracker = createDecodeSpeedTracker(startedAt);
  const abort = new AbortController();
  inputData.activeAbortRef.current = abort;
  try {
    for await (const event of streamBrainChat({
      brainUrl: inputData.props.brainUrl,
      messages: inputData.messages,
      reasoning: inputData.reasoning,
      fallbackProvider: inputData.fallbackProvider,
      signal: abort.signal,
    })) {
      if (event.type === "provider") inputData.setProvider(event.activeProvider);
      if (event.type === "usage") inputData.setUsage(summarizeUsage(event.usage, { durationMs: Date.now() - startedAt }));
      if (event.type === "brain.error") throw new Error(formatBrainErrorForHuman(event.error, event.code));
      if (event.type === "reasoning.delta" && shouldRenderReasoning(inputData.reasoning.display, false)) {
        inputData.setTurns((current) => current.map((turn) => turn.id === assistantId ? { ...turn, trace: appendReasoningTrace(turn.trace, event.text) } : turn));
      }
      if (event.type === "tool_progress") {
        inputData.setTurns((current) => current.map((turn) => turn.id === assistantId ? { ...turn, pending: false, trace: updateToolTrace(turn.trace, event) } : turn));
        continue;
      }
      if (event.type !== "assistant.delta") continue;
      assistant += event.text;
      const nextDecodeTps = decodeTracker.add(event.text);
      if (nextDecodeTps) inputData.setDecodeTps(nextDecodeTps);
      inputData.setTurns((current) => current.map((turn) => turn.id === assistantId ? { ...turn, text: assistant, pending: false } : turn));
    }
    inputData.messages.push({ role: "assistant", content: assistant });
  } catch (error) {
    inputData.messages.pop();
    const message = abort.signal.aborted
      ? t("chat.cancelled")
      : error instanceof Error ? error.message : String(error);
    inputData.setTurns((current) => current.map((turn) => turn.id === assistantId ? { ...turn, text: message, pending: false, error: true } : turn));
  } finally {
    if (inputData.activeAbortRef.current === abort) inputData.activeAbortRef.current = null;
    inputData.setBusy(false);
  }
}
