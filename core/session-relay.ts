import { getLocale } from "../server/i18n.js";
import { resolveModelContextWindow } from "./compaction-settings.js";

type AnyRecord = Record<string, any>;

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
