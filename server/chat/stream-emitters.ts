import { debugLog } from "../../lib/debug-log.js";
import {
  emitSessionStreamEvent as defaultEmitSessionStreamEvent,
} from "./stream-event-emitter.js";
import type {
  SessionStreamBroadcast,
  SessionStreamEntry,
  StreamEventPayload,
} from "./stream-event-emitter.js";
import type { SessionStreamState } from "../session-stream-store.js";
import {
  flushStreamingPseudoToolBlocks,
  stripStreamingPseudoToolBlocks,
} from "./stream-sanitizer.js";
import {
  containsPseudoToolSimulation,
  stripPseudoToolCallMarkup,
} from "../../shared/pseudo-tool-call.js";

type ThinkTagEvent =
  | { type: "think_start" }
  | { type: "think_text"; data: string }
  | { type: "think_end" }
  | { type: "text"; data: string };

type ProgressEvent =
  | { type: "tool_progress" }
  | { type: "text"; data: string };

type MoodEvent =
  | { type: "text"; data: string }
  | { type: "mood_start" }
  | { type: "mood_text"; data: string }
  | { type: "mood_end" };

type XingEvent =
  | { type: "text"; data: string }
  | { type: "xing_start"; title?: string }
  | { type: "xing_text"; data: string }
  | { type: "xing_end" };

interface FeedFlushParser<TEvent> {
  feed(delta: string, emit: (event: TEvent) => void): void;
  flush(emit: (event: TEvent) => void): void;
}

export interface ChatStreamEmitterState extends SessionStreamState {
  thinkTagParser: FeedFlushParser<ThinkTagEvent>;
  progressParser: FeedFlushParser<ProgressEvent>;
  moodParser: FeedFlushParser<MoodEvent>;
  xingParser: FeedFlushParser<XingEvent>;
  isThinking: boolean;
  hasThinking: boolean;
  hasOutput: boolean;
  hasToolCall: boolean;
  hasError: boolean;
  titlePreview: string;
  visibleTextAcc: string;
  rawTextAcc: string;
  bufferedVisibleTextDuringTool: string;
  hasBufferedVisibleTextDuringTool: boolean;
  progressMarkerCount: number;
  // Cross-chunk carry buffer for the streaming pseudo-tool sanitizer. Undefined until first used;
  // the sanitizer reads it defensively (see server/chat/stream-sanitizer.ts).
  sanitizerCarry?: string;
  [key: string]: unknown;
}

export interface CreateStreamEmittersDeps {
  broadcast: SessionStreamBroadcast;
  emitSessionStreamEvent?: (
    sessionPath: string,
    ss: SessionStreamState,
    event: StreamEventPayload,
    broadcast: SessionStreamBroadcast,
  ) => SessionStreamEntry;
  hasStreamEvent: (ss: ChatStreamEmitterState | null | undefined, type: string) => boolean;
  hasToolExecutionInFlight: (ss: ChatStreamEmitterState | null | undefined) => boolean;
  scheduleToolFinalizationFallback: (sessionPath: string, ss: ChatStreamEmitterState) => void;
  clearToolFinalizationTimer: (ss: ChatStreamEmitterState) => void;
  maybeGenerateFirstTurnTitle: (sessionPath: string, ss: ChatStreamEmitterState) => void;
}

export function createStreamEmitters({
  broadcast,
  emitSessionStreamEvent = defaultEmitSessionStreamEvent,
  hasStreamEvent,
  hasToolExecutionInFlight,
  scheduleToolFinalizationFallback,
  clearToolFinalizationTimer,
  maybeGenerateFirstTurnTitle,
}: CreateStreamEmittersDeps) {
  function sanitizeVisibleDelta(
    sessionPath: string,
    ss: ChatStreamEmitterState,
    delta: unknown,
  ): string {
    const result = stripStreamingPseudoToolBlocks(ss, delta);
    if (result.suppressed) {
      debugLog()?.warn("ws", `suppressed pseudo tool-call text delta · session=${sessionPath}`);
    }
    return result.text;
  }

  function sanitizeTrustedVisibleDelta(sessionPath: string, delta: unknown): string {
    const text = String(delta || "");
    if (!text) return "";
    if (!containsPseudoToolSimulation(text)) return text;
    const stripped = stripPseudoToolCallMarkup(text);
    if (stripped !== text) {
      debugLog()?.warn("ws", `stripped pseudo tool-call markup from trusted visible text · session=${sessionPath}`);
    }
    return stripped;
  }

  function emitStreamEvent(
    sessionPath: string,
    ss: ChatStreamEmitterState,
    event: StreamEventPayload,
  ): SessionStreamEntry {
    return emitSessionStreamEvent(sessionPath, ss, event, broadcast);
  }

  function emitTrustedVisibleTextDelta(
    sessionPath: string,
    ss: ChatStreamEmitterState,
    delta: unknown,
  ): boolean {
    const next = sanitizeTrustedVisibleDelta(sessionPath, delta);
    if (!next) return false;
    ss.hasOutput = true;
    ss.titlePreview += next;
    ss.visibleTextAcc += next;
    emitStreamEvent(sessionPath, ss, { type: "text_delta", delta: next });
    maybeGenerateFirstTurnTitle(sessionPath, ss);
    return true;
  }

  function emitVisibleTextDelta(
    sessionPath: string,
    ss: ChatStreamEmitterState,
    delta: unknown,
  ): void {
    const next = sanitizeVisibleDelta(sessionPath, ss, delta);
    if (!next) return;
    if (hasToolExecutionInFlight(ss)) {
      ss.bufferedVisibleTextDuringTool = `${ss.bufferedVisibleTextDuringTool || ""}${next}`;
      if (next.trim()) {
        ss.hasBufferedVisibleTextDuringTool = true;
        scheduleToolFinalizationFallback(sessionPath, ss);
      }
      return;
    }
    if (next.trim()) {
      ss.hasOutput = true;
      if (ss.hasToolCall && !ss.hasError && !hasStreamEvent(ss, "turn_end")) {
        scheduleToolFinalizationFallback(sessionPath, ss);
      } else {
        clearToolFinalizationTimer(ss);
      }
    }
    ss.titlePreview += next;
    ss.visibleTextAcc += next;
    emitStreamEvent(sessionPath, ss, { type: "text_delta", delta: next });
    maybeGenerateFirstTurnTitle(sessionPath, ss);
  }

  function flushBufferedToolVisibleText(
    sessionPath: string,
    ss: ChatStreamEmitterState | null | undefined,
    preferredText: unknown = "",
  ): boolean {
    if (!sessionPath || !ss || ss.hasOutput) return false;
    const persisted = String(preferredText || "").trim();
    const buffered = String(ss.bufferedVisibleTextDuringTool || "").trim();
    const text = persisted || buffered;
    ss.bufferedVisibleTextDuringTool = "";
    ss.hasBufferedVisibleTextDuringTool = false;
    if (!text) return false;
    emitTrustedVisibleTextDelta(sessionPath, ss, text);
    return true;
  }

  function feedAssistantVisibleText(
    sessionPath: string,
    ss: ChatStreamEmitterState,
    delta: string,
  ): void {
    if (!delta) return;
    ss.rawTextAcc += delta || "";
    ss.thinkTagParser.feed(delta, (tEvt) => {
      switch (tEvt.type) {
        case "think_start":
          if (!ss.isThinking) {
            ss.isThinking = true;
            ss.hasThinking = true;
            emitStreamEvent(sessionPath, ss, { type: "thinking_start" });
          }
          break;
        case "think_text":
          ss.hasThinking = true;
          emitStreamEvent(sessionPath, ss, { type: "thinking_delta", delta: tEvt.data });
          break;
        case "think_end":
          if (ss.isThinking) {
            ss.isThinking = false;
            emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
          }
          break;
        case "text":
          ss.progressParser.feed(tEvt.data, (pEvt) => {
            if (pEvt.type === "tool_progress") {
              ss.progressMarkerCount++;
              return;
            }
            ss.moodParser.feed(pEvt.data, (evt) => {
              if (evt.type === "text") {
                ss.xingParser.feed(evt.data, (xEvt) => {
                  emitXingEvent(sessionPath, ss, xEvt);
                });
              } else {
                emitMoodEvent(sessionPath, ss, evt);
              }
            });
          });
          break;
      }
    });
  }

  function flushBufferedAssistantText(
    sessionPath: string,
    ss: ChatStreamEmitterState | null | undefined,
  ): void {
    if (!sessionPath || !ss) return;
    // flush 顺序：ThinkTag → LynnProgress → Mood → Xing。即使 tool_end 丢失,
    // 已经到达的可见文本也要先释放出来,避免用户面对空白等待到硬超时。
    const feedMoodOnly = (text: string) => {
      ss.moodParser.feed(text, (evt) => {
        if (evt.type === "text") {
          ss.xingParser.feed(evt.data, (xEvt) => {
            emitXingEvent(sessionPath, ss, xEvt);
          });
        } else {
          emitMoodEvent(sessionPath, ss, evt);
        }
      });
    };
    const feedMoodPipeline = (text: string) => {
      ss.progressParser.feed(text, (pEvt) => {
        if (pEvt.type === "tool_progress") {
          ss.progressMarkerCount++;
          debugLog()?.warn("ws", `suppressed hallucinated <lynn_tool_progress> during flush · ${sessionPath}`);
          return;
        }
        feedMoodOnly(pEvt.data);
      });
    };
    ss.thinkTagParser.flush((tEvt) => {
      if (tEvt.type === "think_text") {
        emitStreamEvent(sessionPath, ss, { type: "thinking_delta", delta: tEvt.data });
      } else if (tEvt.type === "think_end") {
        emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
      } else if (tEvt.type === "text") {
        feedMoodPipeline(tEvt.data);
      }
    });
    ss.progressParser.flush((pEvt) => {
      if (pEvt.type === "text") {
        feedMoodOnly(pEvt.data);
      } else if (pEvt.type === "tool_progress") {
        ss.progressMarkerCount++;
        debugLog()?.warn("ws", `suppressed hallucinated <lynn_tool_progress> during progress flush · ${sessionPath}`);
      }
    });
    ss.moodParser.flush((evt) => {
      if (evt.type === "text") {
        ss.xingParser.feed(evt.data, (xEvt) => {
          emitXingEvent(sessionPath, ss, xEvt);
        });
      } else if (evt.type === "mood_text") {
        emitStreamEvent(sessionPath, ss, { type: "mood_text", delta: evt.data });
      }
    });
    ss.xingParser.flush((xEvt) => {
      if (xEvt.type === "text") {
        emitVisibleTextDelta(sessionPath, ss, xEvt.data);
      } else if (xEvt.type === "xing_text") {
        emitStreamEvent(sessionPath, ss, { type: "xing_text", delta: xEvt.data });
      }
    });
    // Drain the streaming sanitizer's cross-chunk carry last: any trailing fragment withheld
    // during the deltas gets resolved here (emitted if it's normal prose, dropped if it's still
    // an unmatched pseudo-tool prefix). This is the turn-end close for the carry buffer.
    const residual = flushStreamingPseudoToolBlocks(ss);
    if (residual.text) {
      emitTrustedVisibleTextDelta(sessionPath, ss, residual.text);
    }
  }

  function emitMoodEvent(sessionPath: string, ss: ChatStreamEmitterState, evt: MoodEvent): void {
    if (evt.type === "mood_start") {
      emitStreamEvent(sessionPath, ss, { type: "mood_start" });
    } else if (evt.type === "mood_text") {
      emitStreamEvent(sessionPath, ss, { type: "mood_text", delta: evt.data });
    } else if (evt.type === "mood_end") {
      emitStreamEvent(sessionPath, ss, { type: "mood_end" });
    }
  }

  function emitXingEvent(sessionPath: string, ss: ChatStreamEmitterState, xEvt: XingEvent): void {
    switch (xEvt.type) {
      case "text":
        emitVisibleTextDelta(sessionPath, ss, xEvt.data);
        break;
      case "xing_start":
        emitStreamEvent(sessionPath, ss, { type: "xing_start", title: xEvt.title });
        break;
      case "xing_text":
        emitStreamEvent(sessionPath, ss, { type: "xing_text", delta: xEvt.data });
        break;
      case "xing_end":
        emitStreamEvent(sessionPath, ss, { type: "xing_end" });
        break;
    }
  }

  return {
    emitStreamEvent,
    emitTrustedVisibleTextDelta,
    emitVisibleTextDelta,
    flushBufferedToolVisibleText,
    feedAssistantVisibleText,
    flushBufferedAssistantText,
  };
}
