export type ReviewVerdict = "pass" | "concerns" | "blocker";
export type ReviewSeverity = "high" | "medium" | "low";
export type ReviewWorkflowGate = "clear" | "follow_up" | "hold";

export interface ReviewFinding {
  severity: ReviewSeverity;
  title: string;
  detail?: string;
  suggestion?: string;
  filePath?: string;
}

export interface StructuredReview {
  summary: string;
  verdict: ReviewVerdict;
  findings: ReviewFinding[];
  workflowGate: ReviewWorkflowGate;
  nextStep?: string;
}

const VALID_VERDICTS = new Set<ReviewVerdict>(["pass", "concerns", "blocker"]);
const VALID_SEVERITIES = new Set<ReviewSeverity>(["high", "medium", "low"]);

function cleanText(value: unknown, maxLength: number = 0): string {
  if (typeof value !== "string") return "";
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (!maxLength || normalized.length <= maxLength) return normalized;
  return normalized.slice(0, maxLength).trim();
}

function parseJsonCandidate(text: string): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function extractStructuredCandidate(rawText: unknown): Record<string, unknown> | null {
  const trimmed = cleanText(rawText);
  if (!trimmed) return null;

  const candidates = [trimmed];
  const fenceMatches = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)];
  for (const match of fenceMatches) {
    if (match[1]) candidates.push(match[1].trim());
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    const parsed = parseJsonCandidate(candidate);
    if (parsed) return parsed;
  }

  return null;
}

function normalizeSeverity(value: unknown): ReviewSeverity {
  return typeof value === "string" && VALID_SEVERITIES.has(value as ReviewSeverity) ? value as ReviewSeverity : "medium";
}

function normalizeFinding(finding: unknown): ReviewFinding | null {
  if (!finding || typeof finding !== "object") return null;
  const data = finding as Record<string, unknown>;

  const title = cleanText(data.title || data.name, 160);
  const detail = cleanText(data.detail || data.description, 800);
  const suggestion = cleanText(data.suggestion || data.fix || data.nextStep, 400);
  const filePath = cleanText(data.filePath || data.path, 260);

  if (!title && !detail && !suggestion) return null;

  return {
    severity: normalizeSeverity(data.severity),
    title: title || detail || suggestion,
    detail,
    suggestion,
    ...(filePath ? { filePath } : {}),
  };
}

function isReviewFinding(finding: ReviewFinding | null): finding is ReviewFinding {
  return !!finding;
}

export function computeReviewWorkflowGate(structuredReview: Partial<StructuredReview> | null | undefined): ReviewWorkflowGate {
  const findings = Array.isArray(structuredReview?.findings) ? structuredReview.findings : [];
  const hasHigh = findings.some((finding) => finding?.severity === "high");

  if (structuredReview?.verdict === "blocker" || hasHigh) return "hold";
  if (structuredReview?.verdict === "concerns" || findings.length > 0) return "follow_up";
  return "clear";
}

export function buildReviewFollowUp(structuredReview: StructuredReview | null | undefined): string | null {
  if (!structuredReview) return null;
  const findings = Array.isArray(structuredReview.findings) ? structuredReview.findings : [];
  if (findings.length === 0 && structuredReview.workflowGate === "clear") return null;

  const topFindings = findings.slice(0, 3)
    .map((finding, index) => `${index + 1}. [${finding.severity}] ${finding.title}${finding.filePath ? ` (${finding.filePath})` : ""}`)
    .join("\n");

  const summary = cleanText(structuredReview.summary, 320);
  const nextStep = cleanText(structuredReview.nextStep, 240);
  const lines = [
    `Review verdict: ${structuredReview.verdict}`,
    summary ? `Summary: ${summary}` : null,
    topFindings ? `Findings:\n${topFindings}` : null,
    nextStep ? `Next step: ${nextStep}` : null,
    "Address the review findings before continuing.",
  ].filter(Boolean);

  return lines.join("\n\n");
}

export function normalizeStructuredReview(candidate: unknown, rawText: string = ""): StructuredReview | null {
  if (!candidate || typeof candidate !== "object") return null;
  const data = candidate as Record<string, unknown>;

  const findings = Array.isArray(data.findings)
    ? data.findings.map(normalizeFinding).filter(isReviewFinding)
    : [];

  let verdict: ReviewVerdict | "" = typeof data.verdict === "string" && VALID_VERDICTS.has(data.verdict as ReviewVerdict)
    ? data.verdict as ReviewVerdict
    : "";
  if (!verdict) {
    verdict = findings.some((finding) => finding.severity === "high")
      ? "blocker"
      : findings.length > 0
        ? "concerns"
        : "pass";
  }

  const summary = cleanText(data.summary, 600)
    || cleanText(rawText, 600)
    || (verdict === "pass" ? "No material issues found." : `${findings.length} finding${findings.length === 1 ? "" : "s"}.`);

  const nextStep = cleanText(data.nextStep, 400);
  const structuredReview: StructuredReview = {
    summary,
    verdict,
    findings,
    workflowGate: "clear",
    ...(nextStep ? { nextStep } : {}),
  };

  structuredReview.workflowGate = computeReviewWorkflowGate(structuredReview);
  return structuredReview;
}

export function parseStructuredReview(rawText: string): StructuredReview | null {
  const candidate = extractStructuredCandidate(rawText);
  if (!candidate) return null;
  return normalizeStructuredReview(candidate, rawText);
}
