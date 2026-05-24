export const DEEP_RESEARCH_TIMEOUT_MS = 180_000;
export const DEEP_RESEARCH_FETCH_TIMEOUT_MS = DEEP_RESEARCH_TIMEOUT_MS + 10_000;

export interface DeepResearchArtifact {
  artifactId?: unknown;
  id?: unknown;
  artifactType?: unknown;
  type?: unknown;
  title?: unknown;
  content?: unknown;
  language?: unknown;
}

export interface NormalizedDeepResearchArtifact {
  artifactId: string;
  artifactType: string;
  title: string;
  content: string;
  language?: string;
}

export interface DeepResearchResponse {
  text?: unknown;
  winnerProviderId?: unknown;
  winnerModelId?: unknown;
  sourceLabel?: unknown;
  ok?: unknown;
  artifact?: DeepResearchArtifact | null;
}

export function normalizeDeepResearchArtifact(raw: DeepResearchArtifact | null | undefined): NormalizedDeepResearchArtifact | null {
  if (!raw || typeof raw !== 'object') return null;
  const content = String(raw.content || '').trim();
  if (!content) return null;
  const artifactType = String(raw.artifactType || raw.type || 'html').trim() || 'html';
  const artifactId = String(raw.artifactId || raw.id || `deep-research-${Date.now().toString(36)}`);
  const title = String(raw.title || '深度调研报告').trim() || '深度调研报告';
  const language = raw.language == null ? (artifactType === 'html' ? 'html' : undefined) : String(raw.language);
  return { artifactId, artifactType, title, content, language };
}

export function normalizeDeepResearchErrorMessage(raw: unknown): string {
  const rawMessage = raw instanceof Error ? raw.message : String(raw || "深度调研失败");
  if (/aborted without reason|AbortError|请求超时/iu.test(rawMessage)) {
    return "深度调研超过等待时间，已停止本轮。你可以稍后重试，或把问题拆成更具体的子问题。";
  }
  return rawMessage;
}

export function formatDeepResearchAssistantText(data: DeepResearchResponse): string {
  const text = String(data?.text || "").trim();
  const label = String(data?.sourceLabel || data?.winnerModelId || data?.winnerProviderId || "").trim();
  const source = label ? ` · 输出来源：${label}` : "";
  const status = "完成";
  const footer = [
    "",
    "---",
    `**深度调研**：${status}${source}`,
  ].filter(Boolean).join("\n");
  return [text, footer].filter(Boolean).join("\n");
}
