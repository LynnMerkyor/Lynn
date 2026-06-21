type ToolArgs = Record<string, unknown>;

export interface ToolStormGuardState {
  originalPromptText?: unknown;
  effectivePromptText?: unknown;
  hasOutput?: unknown;
  toolStormClosed?: boolean;
  toolStormGuard?: {
    total?: number;
    evidenceTotal?: number;
    byName?: Record<string, number>;
    bySignature?: Record<string, number>;
    lastDecisionReason?: string;
  };
}

export interface ToolStormDecision {
  exceeded: boolean;
  reason: string;
  canonicalName: string;
  signature: string;
  count: number;
  limit: number;
  evidenceTotal: number;
  total: number;
}

const EVIDENCE_TOOL_NAMES = new Set([
  "web_search",
  "web_fetch",
  "sports_score",
  "live_news",
  "weather",
  "stock_market",
  "search",
  "fetch",
]);

const SEARCH_TOOL_NAMES = new Set(["web_search", "search"]);
const FETCH_TOOL_NAMES = new Set(["web_fetch", "fetch"]);

const LONG_RESEARCH_RE = /(?:深度|完整|全面|系统(?:性)?|调研|研究|报告|对比|比较|列表|主要|收费|人数|价格|预测|分析|梳理|汇总|来源|引用|benchmark|review|audit|investigate|research|report|compare|analysis)/i;

export function canonicalToolName(toolName: unknown): string {
  return String(toolName || "").trim().toLowerCase().replace(/-/g, "_");
}

function normalizeSignatureValue(value: unknown): string {
  const compact = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  return /[\u3400-\u9fff]/.test(compact)
    ? compact.replace(/\s+/g, "").slice(0, 320)
    : compact.slice(0, 320);
}

function pickSignatureValue(name: string, args: ToolArgs): string {
  if (SEARCH_TOOL_NAMES.has(name)) {
    return normalizeSignatureValue(args.query || args.q || args.prompt || args.keywords);
  }
  if (FETCH_TOOL_NAMES.has(name)) {
    return normalizeSignatureValue(args.url || args.href || args.link);
  }
  if (name === "sports_score") {
    return normalizeSignatureValue([
      args.query,
      args.team,
      args.opponent,
      args.league,
      args.date,
    ].filter(Boolean).join(" "));
  }
  if (name === "weather") {
    return normalizeSignatureValue([args.location, args.city, args.date].filter(Boolean).join(" "));
  }
  if (name === "stock_market") {
    return normalizeSignatureValue([args.query, args.symbol, args.ticker, args.market].filter(Boolean).join(" "));
  }
  if (name === "live_news") {
    return normalizeSignatureValue(args.query || args.topic || args.keyword);
  }
  if (name === "bash") {
    return normalizeSignatureValue(args.command || args.cmd || args.shell || args.script);
  }
  return normalizeSignatureValue(
    args.query
      || args.url
      || args.path
      || args.file_path
      || args.command
      || JSON.stringify(args || {}).slice(0, 320),
  );
}

function toolSignature(name: string, args: ToolArgs): string {
  const picked = pickSignatureValue(name, args);
  return picked ? `${name}:${picked}` : `${name}:<empty>`;
}

function isLongResearchTurn(ss: ToolStormGuardState): boolean {
  const prompt = `${ss.effectivePromptText || ""}\n${ss.originalPromptText || ""}`;
  return LONG_RESEARCH_RE.test(prompt);
}

function ensureGuard(ss: ToolStormGuardState) {
  if (!ss.toolStormGuard) {
    ss.toolStormGuard = {
      total: 0,
      evidenceTotal: 0,
      byName: {},
      bySignature: {},
      lastDecisionReason: "",
    };
  }
  ss.toolStormGuard.byName = ss.toolStormGuard.byName || {};
  ss.toolStormGuard.bySignature = ss.toolStormGuard.bySignature || {};
  ss.toolStormGuard.total = Number(ss.toolStormGuard.total || 0);
  ss.toolStormGuard.evidenceTotal = Number(ss.toolStormGuard.evidenceTotal || 0);
  return ss.toolStormGuard;
}

function maxPerEvidenceTool(name: string, longResearch: boolean): number {
  if (SEARCH_TOOL_NAMES.has(name)) return longResearch ? 12 : 4;
  if (FETCH_TOOL_NAMES.has(name)) return longResearch ? 12 : 4;
  if (name === "sports_score") return 2;
  if (name === "weather") return 2;
  if (name === "stock_market") return longResearch ? 4 : 3;
  if (name === "live_news") return longResearch ? 4 : 3;
  return longResearch ? 8 : 4;
}

export function isEvidenceTool(toolName: unknown): boolean {
  return EVIDENCE_TOOL_NAMES.has(canonicalToolName(toolName));
}

export function updateToolStormGuard(
  ss: ToolStormGuardState,
  toolName: unknown,
  rawArgs: unknown,
): ToolStormDecision {
  const guard = ensureGuard(ss);
  const canonicalName = canonicalToolName(toolName);
  const args = (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) ? rawArgs as ToolArgs : {};
  const signature = toolSignature(canonicalName, args);
  const longResearch = isLongResearchTurn(ss);
  const isEvidence = EVIDENCE_TOOL_NAMES.has(canonicalName);

  guard.total = Number(guard.total || 0) + 1;
  guard.byName![canonicalName] = Number(guard.byName![canonicalName] || 0) + 1;
  guard.bySignature![signature] = Number(guard.bySignature![signature] || 0) + 1;
  if (isEvidence) {
    guard.evidenceTotal = Number(guard.evidenceTotal || 0) + 1;
  }

  const signatureLimit = longResearch ? 3 : 2;
  const evidenceTotalLimit = longResearch ? 16 : 8;
  const perNameLimit = isEvidence ? maxPerEvidenceTool(canonicalName, longResearch) : (longResearch ? 8 : 4);
  const signatureCount = guard.bySignature![signature];
  const nameCount = guard.byName![canonicalName];
  const evidenceTotal = Number(guard.evidenceTotal || 0);

  let exceeded = false;
  let reason = "";
  let limit = 0;
  let count = 0;

  if (isEvidence && signatureCount > signatureLimit) {
    exceeded = true;
    reason = "repeated_evidence_tool_signature";
    limit = signatureLimit;
    count = signatureCount;
  } else if (isEvidence && nameCount > perNameLimit) {
    exceeded = true;
    reason = "evidence_tool_name_budget_exceeded";
    limit = perNameLimit;
    count = nameCount;
  } else if (isEvidence && evidenceTotal > evidenceTotalLimit) {
    exceeded = true;
    reason = "evidence_tool_total_budget_exceeded";
    limit = evidenceTotalLimit;
    count = evidenceTotal;
  } else if (!isEvidence && signatureCount > 3) {
    exceeded = true;
    reason = "repeated_tool_signature";
    limit = 3;
    count = signatureCount;
  }

  guard.lastDecisionReason = reason;
  return {
    exceeded,
    reason,
    canonicalName,
    signature,
    count,
    limit,
    evidenceTotal,
    total: Number(guard.total || 0),
  };
}

export function buildToolStormFallbackText(decision: ToolStormDecision, summaryText: unknown): string {
  const summary = String(summaryText || "").trim();
  const reason = decision.reason === "repeated_evidence_tool_signature"
    ? "同一证据查询/抓取已重复多次"
    : decision.reason === "evidence_tool_name_budget_exceeded"
      ? "同类证据工具调用已达到本轮预算"
      : decision.reason === "evidence_tool_total_budget_exceeded"
        ? "本轮证据工具调用已达到预算"
        : "同一工具调用已重复多次";
  const preface = `工具链已自动停止：${reason}，避免继续重复搜索或抓取。`;
  return summary ? `${preface}\n\n${summary}` : `${preface}\n\n我已经拿到部分工具结果，但没有形成稳定总结。请缩小问题范围或让我基于现有证据继续整理。`;
}
