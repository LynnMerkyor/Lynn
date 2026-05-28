import { getLocale } from "../server/i18n.js";
import { resolveModelContextWindow } from "./compaction-settings.js";

type AnyRecord = Record<string, any>;
type SessionRelayEntry = AnyRecord & {
  session?: AnyRecord;
  memoryEnabled?: boolean;
  planMode?: boolean;
  securityMode?: string;
  relayInProgress?: boolean;
  compactionCount?: number;
};

const SESSION_RELAY_SUMMARY_MAX_CHARS = 4000;

export const DEFAULT_SESSION_RELAY = {
  enabled: true,
  compactionThreshold: 3,
  summaryMaxTokens: 800,
};

export function resolveSessionRelayConfig(raw: AnyRecord = {}, model?: AnyRecord | null) {
  let defaultThreshold = DEFAULT_SESSION_RELAY.compactionThreshold;
  try {
    const cw = resolveModelContextWindow(model as any);
    if (cw && cw < 16_000) defaultThreshold = 1;
    else if (cw && cw < 32_000) defaultThreshold = 2;
  } catch {}

  return {
    enabled: raw.enabled !== false,
    compactionThreshold: Number(raw.compaction_threshold) > 0 ? Number(raw.compaction_threshold) : defaultThreshold,
    summaryMaxTokens: Number(raw.summary_max_tokens) > 0 ? Number(raw.summary_max_tokens) : DEFAULT_SESSION_RELAY.summaryMaxTokens,
  };
}

export function formatRelaySummaryContext(summaryText: string, locale = getLocale()) {
  const summary = String(summaryText || "").trim().slice(0, SESSION_RELAY_SUMMARY_MAX_CHARS);
  if (!summary) return "";
  const isZh = locale.startsWith("zh");
  return isZh
    ? `【上一个会话的自动接力摘要】\n以下是上一段长会话在压缩多次后的交接摘要。请把它当作继续工作的背景，不要逐字复述给用户，除非用户明确询问：\n${summary}`
    : `[Automatic Session Relay Summary]\nThe following is a handoff summary from the previous long-running session after repeated compactions. Use it as continuation context and do not quote it back unless the user asks for it:\n${summary}`;
}

export async function runSessionRelay(opts: {
  sessionPath: string;
  compactionCount: number;
  sessions: Map<string, SessionRelayEntry>;
  currentSessionPath?: string | null;
  getCurrentSessionPath: () => string | null | undefined;
  relayConfig: ReturnType<typeof resolveSessionRelayConfig>;
  defaultSecurityMode: string;
  summarize: (sessionPath: string, options: { maxTokens: number }) => Promise<string | null | undefined>;
  resolveModel: (entry: SessionRelayEntry) => unknown;
  resolveCwd: (entry: SessionRelayEntry) => string;
  createSession: (options: {
    entry: SessionRelayEntry;
    cwd: string;
    memoryEnabled: boolean;
    model: unknown;
  }) => Promise<AnyRecord | null | undefined>;
  formatSummaryContext: (summaryText: string) => string;
  applySessionToolRuntime: (sessionPath: string, modeOverride?: string | null) => void;
  emitEvent: (event: AnyRecord, sessionPath: string) => void;
  onError?: (err: unknown) => void;
}) {
  const entry = opts.sessions.get(opts.sessionPath);
  if (!entry || entry.relayInProgress) return false;
  if (!opts.relayConfig.enabled || opts.sessionPath !== opts.currentSessionPath) return false;

  entry.relayInProgress = true;
  try {
    const summary = await opts.summarize(opts.sessionPath, {
      maxTokens: opts.relayConfig.summaryMaxTokens,
    });
    if (!summary) return false;

    const model = opts.resolveModel(entry);
    const cwd = opts.resolveCwd(entry);
    const nextSession = await opts.createSession({
      entry,
      cwd,
      memoryEnabled: entry.memoryEnabled !== false,
      model,
    });
    const newSessionPath = nextSession?.sessionManager?.getSessionFile?.() || opts.getCurrentSessionPath();
    const newEntry = newSessionPath ? opts.sessions.get(newSessionPath) : null;
    if (!newEntry || !newSessionPath) return false;

    newEntry._relaySummaryContext = opts.formatSummaryContext(summary);
    newEntry.compactionCount = 0;
    newEntry.securityMode = entry.securityMode || opts.defaultSecurityMode;
    newEntry.planMode = !!entry.planMode;
    newEntry.memoryEnabled = entry.memoryEnabled !== false;
    opts.applySessionToolRuntime(newSessionPath, newEntry.securityMode);

    opts.emitEvent({
      type: "session_relay",
      oldSessionPath: opts.sessionPath,
      newSessionPath,
      summary,
      summaryTokens: summary.length,
      compactionCount: opts.compactionCount,
      reason: "auto_compaction_limit",
    }, newSessionPath);
    return true;
  } catch (err) {
    opts.onError?.(err);
    return false;
  } finally {
    const current = opts.sessions.get(opts.sessionPath);
    if (current) {
      current.relayInProgress = false;
      current.compactionCount = 0;
    }
  }
}
