export const DEEP_RESEARCH_TIMEOUT_MS = 180_000;
export const DEEP_RESEARCH_FETCH_TIMEOUT_MS = DEEP_RESEARCH_TIMEOUT_MS + 10_000;

export type DeepResearchScoreRow = Record<string, unknown>;

export interface DeepResearchResponse {
  text?: unknown;
  winnerProviderId?: unknown;
  qualityRejected?: unknown;
  ok?: unknown;
  rankedScores?: unknown;
}

export function normalizeDeepResearchErrorMessage(raw: unknown): string {
  const rawMessage = raw instanceof Error ? raw.message : String(raw || "深度调研失败");
  if (/aborted without reason|AbortError|请求超时/iu.test(rawMessage)) {
    return "深度调研超过等待时间，已停止本轮。你可以稍后重试，或把问题拆成更具体的子问题。";
  }
  return rawMessage;
}

export function formatDeepResearchAssistantText(data: DeepResearchResponse): string {
  const text = String(data?.text || "").trim()
    || "深度调研没有返回可见答案，请稍后重试或把问题拆得更具体。";
  const source = data?.winnerProviderId ? ` · 推荐来源：${data.winnerProviderId}` : "";
  const status = data?.qualityRejected
    ? "未通过质量复核"
    : data?.ok === false
      ? "未通过质量复核"
      : "已通过质量复核";
  const scoreLines = Array.isArray(data?.rankedScores)
    ? data.rankedScores.slice(0, 3).map((row: DeepResearchScoreRow, index: number) => {
      const provider = String(row.providerId || row.provider || `候选 ${index + 1}`);
      const avg = Number(row.avg ?? row.average ?? NaN);
      return Number.isFinite(avg) ? `- ${provider}: ${avg.toFixed(2)}` : `- ${provider}`;
    })
    : [];
  const footer = [
    "",
    "---",
    `**深度调研**：${status}${source}`,
    scoreLines.length ? `\n${scoreLines.join("\n")}` : "",
  ].filter(Boolean).join("\n");
  return `${text}\n${footer}`;
}
