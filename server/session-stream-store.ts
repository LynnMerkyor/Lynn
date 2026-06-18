/**
 * session-stream-store.js
 *
 * 维护单个 session 的流式事件状态。
 * 每轮回复对应一个 streamId，流内每条事件按 seq 递增。
 */

const DEFAULT_MAX_EVENTS = 1_000;

export interface SessionStreamEvent {
  [key: string]: unknown;
}

export interface SessionStreamEntry {
  streamId: string | null;
  seq: number;
  event: SessionStreamEvent;
  ts: number;
}

export interface SessionStreamState {
  streamId: string | null;
  nextSeq: number;
  isStreaming: boolean;
  startedAt: number;
  endedAt: number;
  events: SessionStreamEntry[];
  maxEvents: number;
}

export interface CreateSessionStreamStateOptions {
  maxEvents?: number;
}

export interface ResumeSessionStreamOptions {
  streamId?: string | null;
  sinceSeq?: number;
}

export interface PublicSessionStreamEvent {
  seq: number;
  event: SessionStreamEvent;
  ts: number;
}

export interface ResumeSessionStreamResult {
  streamId: string | null;
  sinceSeq: number;
  nextSeq: number;
  isStreaming: boolean;
  reset: boolean;
  truncated: boolean;
  events: PublicSessionStreamEvent[];
}

/** 创建初始流状态 */
export function createSessionStreamState(opts: CreateSessionStreamStateOptions = {}): SessionStreamState {
  const envMax = Number(process.env.LYNN_STREAM_REPLAY_MAX_EVENTS || "");
  const configuredMax = opts.maxEvents || (Number.isFinite(envMax) && envMax > 0 ? envMax : DEFAULT_MAX_EVENTS);
  return {
    streamId: null,
    nextSeq: 1,
    isStreaming: false,
    startedAt: 0,
    endedAt: 0,
    events: [],
    maxEvents: Math.max(1, configuredMax),
  };
}

/** 开始新一轮流式回复 */
export function beginSessionStream(state: SessionStreamState, streamId: string | null = null): string {
  state.streamId = streamId || createStreamId();
  state.nextSeq = 1;
  state.isStreaming = true;
  state.startedAt = Date.now();
  state.endedAt = 0;
  state.events = [];
  return state.streamId;
}

/** 写入一条流式事件，返回带 seq 的事件条目 */
export function appendSessionStreamEvent(state: SessionStreamState, event: SessionStreamEvent): SessionStreamEntry {
  if (!state.streamId) beginSessionStream(state);

  const entry = {
    streamId: state.streamId,
    seq: state.nextSeq++,
    event,
    ts: Date.now(),
  };

  state.events.push(entry);
  trimEvents(state);
  return entry;
}

/** 结束当前流 */
export function finishSessionStream(state: SessionStreamState): void {
  state.isStreaming = false;
  state.endedAt = Date.now();
}

/**
 * 读取按 seq 恢复所需的数据
 * @param {object} state
 * @param {{ streamId?: string|null, sinceSeq?: number }} [opts]
 */
export function resumeSessionStream(
  state: SessionStreamState,
  opts: ResumeSessionStreamOptions = {},
): ResumeSessionStreamResult {
  const requestedStreamId = opts.streamId ?? state.streamId ?? null;
  const currentStreamId = state.streamId ?? null;
  const requestedSinceSeq = normalizeSeq(opts.sinceSeq);

  if (!currentStreamId) {
    return {
      streamId: null,
      sinceSeq: requestedSinceSeq,
      nextSeq: 1,
      isStreaming: false,
      reset: false,
      truncated: false,
      events: [],
    };
  }

  // 请求的是旧 stream，说明客户端需要丢弃本地状态并用当前流重建
  if (requestedStreamId && requestedStreamId !== currentStreamId) {
    return {
      streamId: currentStreamId,
      sinceSeq: 0,
      nextSeq: state.nextSeq,
      isStreaming: state.isStreaming,
      reset: true,
      truncated: false,
      events: state.events.map(toPublicEvent),
    };
  }

  const firstSeq = state.events[0]?.seq || state.nextSeq;
  const minSinceSeq = Math.max(0, firstSeq - 1);
  const truncated = requestedSinceSeq < minSinceSeq;
  const effectiveSinceSeq = truncated ? minSinceSeq : requestedSinceSeq;

  return {
    streamId: currentStreamId,
    sinceSeq: effectiveSinceSeq,
    nextSeq: state.nextSeq,
    isStreaming: state.isStreaming,
    reset: false,
    truncated,
    events: state.events
      .filter(entry => entry.seq > effectiveSinceSeq)
      .map(toPublicEvent),
  };
}

function trimEvents(state: SessionStreamState): void {
  const overflow = state.events.length - state.maxEvents;
  if (overflow <= 0) return;
  state.events.splice(0, overflow);
}

function toPublicEvent(entry: SessionStreamEntry): PublicSessionStreamEvent {
  return {
    seq: entry.seq,
    event: entry.event,
    ts: entry.ts,
  };
}

function normalizeSeq(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return n < 0 ? 0 : Math.floor(n);
}

function createStreamId(): string {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
