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
import { editInputBuffer, InkInputLine, stripBracketedPasteMarkers, type InputEditAction } from "./ink-input-line.js";
import { splitInkStaticHistory } from "./ink-static-history.js";
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
    }), { exitOnCtrlC: false });
    try {
      await instance.waitUntilExit();
    } finally {
      instance.unmount();
    }
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
  const [cursorIndex, setCursorIndex] = useState(0);
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
    if (!busy || !profile.animation) return;
    const timer = setInterval(() => setFrame((value) => value + 1), 100);
    return () => clearInterval(timer);
  }, [busy, profile.animation]);

  const replaceInput = (next: string) => {
    setInput(next);
    setCursorIndex(Array.from(next).length);
  };
  const editInput = (action: InputEditAction) => {
    const next = editInputBuffer(input, cursorIndex, action);
    setInput(next.value);
    setCursorIndex(next.cursor);
  };

  useInput((value, key) => {
    value = stripBracketedPasteMarkers(value);
    if ((key.ctrl && value === "c") || value === "\u0003") {
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
          setInput: replaceInput,
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
      const pasted = cursorIndex === Array.from(input).length
        ? appendPastedText(input, value).slice(input.length)
        : value.replace(/\r\n?/g, "\n");
      editInput({ type: "insert", text: pasted });
      return;
    }
    if (key.return && (key.shift || key.meta)) {
      const prefix = newlineIndex >= 0 ? value.slice(0, newlineIndex) : "";
      editInput({ type: "insert", text: `${prefix}\n` });
      return;
    }
    if (key.return && input.endsWith("\\")) {
      const prefix = newlineIndex >= 0 ? value.slice(0, newlineIndex) : "";
      const withoutSlash = editInputBuffer(input, cursorIndex, { type: "backspace" });
      const next = editInputBuffer(withoutSlash.value, withoutSlash.cursor, { type: "insert", text: `${prefix}\n` });
      setInput(next.value);
      setCursorIndex(next.cursor);
      return;
    }
    if (key.return) {
      const prefix = newlineIndex >= 0 ? value.slice(0, newlineIndex) : "";
      const submitted = `${input}${prefix}`;
      void emitThumbnails(submitted, effectiveCwd, setThumbs, profile.inlineImages);
      void submitInput({
        text: submitted,
        setInput: replaceInput,
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
    if (key.ctrl && value === "a") {
      editInput({ type: "home" });
      return;
    }
    if (key.ctrl && value === "e") {
      editInput({ type: "end" });
      return;
    }
    if (key.leftArrow) {
      editInput({ type: "left" });
      return;
    }
    if (key.rightArrow) {
      editInput({ type: "right" });
      return;
    }
    if (key.backspace) {
      editInput({ type: "backspace" });
      return;
    }
    if (key.delete) {
      editInput({ type: "delete" });
      return;
    }
    if (key.upArrow) {
      replaceInput(history.prev(input));
      return;
    }
    if (key.downArrow) {
      replaceInput(history.next());
      return;
    }
    if (key.tab) {
      const mentionCompletion = completeMentionInput(input, effectiveCwd);
      if (mentionCompletion) {
        const completion = mentionCompletion;
        if (completion.matches.length > 1) {
          setTurns((current) => [...current, { id: Date.now(), role: "system", text: completion.matches.slice(0, 12).join("  "), meta: "completions" }]);
        }
        replaceInput(completion.completed);
        return;
      }
      const completion = completeSlash(input, CHAT_SLASH_COMMANDS);
      if (completion.matches.length > 1) {
        setTurns((current) => [...current, { id: Date.now(), role: "system", text: completion.matches.join("  "), meta: "completions" }]);
      }
      replaceInput(completion.completed);
      return;
    }
    if (value) editInput({ type: "insert", text: value });
  });

  const { settledItems: settledTurns, activeItems: activeTurns } = splitInkStaticHistory(turns);
  return React.createElement(Box, { flexDirection: "column", paddingX: 1 },
    turns.length === 0 ? React.createElement(Box, { flexDirection: "column", marginBottom: 1 },
      React.createElement(Text, { bold: true }, `Lynn CLI · ${provider}`),
      React.createElement(Text, { color: "gray" }, `${renderMode(mode)} · ${displayCwd(effectiveCwd)} · ${t("chat.voice.hint")}`),
    ) : null,
    thumbs.map((thumb) => React.createElement(Box, { key: thumb.id, height: 8 }, React.createElement(Text, null, thumb.esc))),
    React.createElement(Static, {
      items: settledTurns,
      children: (item: unknown) => React.createElement(TurnView, {
        key: (item as Turn).id,
        turn: item as Turn,
      }),
    }),
    React.createElement(Box, { marginTop: 1, flexDirection: "column" },
      activeTurns.length
        ? activeTurns.map((turn) => React.createElement(TurnView, { key: turn.id, turn }))
        : settledTurns.length === 0
          ? React.createElement(Text, { color: "gray" }, t("chat.placeholder"))
          : null,
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
      cursorIndex,
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
  const abort = new AbortController();
  inputData.activeAbortRef.current = abort;

  if (inputData.props.mockBrain) {
    try {
      const mockDelay = Math.max(0, Number.parseInt(process.env.LYNN_CLI_MOCK_DELAY_MS || "0", 10) || 0);
      if (mockDelay) await waitForMockDelay(mockDelay, abort.signal);
      const answer = t("mock.response", { text: inputData.promptText });
      inputData.messages.push({ role: "assistant", content: answer });
      inputData.setTurns((current) => current.map((turn) => turn.id === assistantId ? { ...turn, text: answer, pending: false, meta: "mock Brain" } : turn));
    } catch {
      inputData.messages.pop();
      inputData.setTurns((current) => current.map((turn) => turn.id === assistantId
        ? { ...turn, text: t("chat.cancelled"), pending: false, error: true }
        : turn));
    } finally {
      if (inputData.activeAbortRef.current === abort) inputData.activeAbortRef.current = null;
      inputData.setBusy(false);
    }
    return;
  }

  let assistant = "";
  let renderedAssistant = "";
  let renderTimer: ReturnType<typeof setTimeout> | null = null;
  const flushAssistant = () => {
    if (renderTimer) clearTimeout(renderTimer);
    renderTimer = null;
    if (renderedAssistant === assistant) return;
    renderedAssistant = assistant;
    inputData.setTurns((current) => current.map((turn) => turn.id === assistantId
      ? { ...turn, text: renderedAssistant, pending: true }
      : turn));
  };
  const startedAt = Date.now();
  const decodeTracker = createDecodeSpeedTracker(startedAt);
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
        inputData.setTurns((current) => current.map((turn) => turn.id === assistantId ? { ...turn, pending: true, trace: updateToolTrace(turn.trace, event) } : turn));
        continue;
      }
      if (event.type !== "assistant.delta") continue;
      assistant += event.text;
      const nextDecodeTps = decodeTracker.add(event.text);
      if (nextDecodeTps) inputData.setDecodeTps(nextDecodeTps);
      if (!renderTimer) renderTimer = setTimeout(flushAssistant, 40);
    }
    flushAssistant();
    inputData.messages.push({ role: "assistant", content: assistant });
    inputData.setTurns((current) => current.map((turn) => turn.id === assistantId ? { ...turn, text: assistant, pending: false } : turn));
  } catch (error) {
    flushAssistant();
    inputData.messages.pop();
    const message = abort.signal.aborted
      ? t("chat.cancelled")
      : error instanceof Error ? error.message : String(error);
    inputData.setTurns((current) => current.map((turn) => turn.id === assistantId ? { ...turn, text: message, pending: false, error: true } : turn));
  } finally {
    if (renderTimer) clearTimeout(renderTimer);
    if (inputData.activeAbortRef.current === abort) inputData.activeAbortRef.current = null;
    inputData.setBusy(false);
  }
}

function waitForMockDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason || new Error('aborted'));
    }, { once: true });
  });
}
