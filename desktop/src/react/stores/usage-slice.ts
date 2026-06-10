/**
 * usage-slice — 会话级云 token/成本累计(StepFun 一条龙:全 token 云计费,成本必须可见)。
 *
 * 数据源:server 在 context_usage 回包里附带的 turnUsage(最后一条 assistant 消息的
 * Pi-SDK Usage:input/output/cacheRead/cacheWrite/totalTokens/cost.total + timestamp)。
 * renderer 在每次 turn_end 后请求一次 context_usage,这里按 timestamp 去重累计 ——
 * 同一条 assistant 消息(会话切换/重连重复回包)绝不重复计数。
 */

export interface TurnUsagePayload {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costTotal: number | null;
  model: string | null;
  timestamp: number | null;
}

export interface SessionUsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  totalTokens: number;
  costTotal: number;
  turns: number;
  /** 最后一次已计入的 assistant 消息 timestamp(去重锚点)。 */
  lastCountedTs: number | null;
}

export interface UsageSlice {
  sessionUsage: Record<string, SessionUsageTotals>;
  recordTurnUsage: (sessionPath: string, payload: TurnUsagePayload) => void;
  clearSessionUsage: (sessionPath: string) => void;
}

function emptyTotals(): SessionUsageTotals {
  return { input: 0, output: 0, cacheRead: 0, totalTokens: 0, costTotal: 0, turns: 0, lastCountedTs: null };
}

/** 纯累计逻辑,导出供单测(timestamp 相同 = 同一条消息,跳过)。 */
export function accumulateTurnUsage(
  prev: SessionUsageTotals | undefined,
  payload: TurnUsagePayload,
): SessionUsageTotals | null {
  const base = prev ?? emptyTotals();
  if (payload.timestamp != null && base.lastCountedTs === payload.timestamp) return null;
  return {
    input: base.input + (payload.input || 0),
    output: base.output + (payload.output || 0),
    cacheRead: base.cacheRead + (payload.cacheRead || 0),
    totalTokens: base.totalTokens + (payload.totalTokens || 0),
    costTotal: base.costTotal + (payload.costTotal || 0),
    turns: base.turns + 1,
    lastCountedTs: payload.timestamp ?? base.lastCountedTs,
  };
}

type SetState = (partial: object | ((state: { sessionUsage: Record<string, SessionUsageTotals> }) => object)) => void;

export function createUsageSlice(set: SetState): UsageSlice {
  return {
    sessionUsage: {},
    recordTurnUsage: (sessionPath, payload) =>
      set((s) => {
        const next = accumulateTurnUsage(s.sessionUsage[sessionPath], payload);
        if (!next) return {};
        return { sessionUsage: { ...s.sessionUsage, [sessionPath]: next } };
      }),
    clearSessionUsage: (sessionPath) =>
      set((s) => {
        if (!s.sessionUsage[sessionPath]) return {};
        const { [sessionPath]: _drop, ...rest } = s.sessionUsage;
        return { sessionUsage: rest };
      }),
  };
}
