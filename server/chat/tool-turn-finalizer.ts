import { debugLog } from "../../lib/debug-log.js";
import { finishSessionStream } from "../session-stream-store.js";
import { buildLocalOfficeDirectAnswer } from "./local-office-answer.js";
import { extractText } from "./content-utils.js";
import {
  clearPersistedFinalAnswerPollTimer,
  clearReturnedTurnFinalizationTimer,
  clearSilentBrainAbortTimer,
  clearToolAuthorizationPollTimer,
  clearToolAuthorizationTimer,
  clearToolFinalizationTimer,
  clearTurnHardAbortTimer,
  clearTurnTimers,
  resetCompletedTurnState,
} from "./stream-state.js";
import {
  appendJsonlLine,
  appendTextToLatestAssistantInMemory,
  appendTextToLatestAssistantRecord,
  extractLatestAssistantVisibleText,
  extractLatestAssistantVisibleTextAfter,
  getLastSessionEntryId,
  latestPersistedMessageText,
  sessionLineId,
} from "./session-persistence.js";

/**
 * 工具回合结束但模型没有产出收尾文本时的事实行(issue #72 第三类的 GUI 变体:
 * 命令执行成功、授权卡片也在,turn 却静默结束)。V0.79 禁止合成内容 —— 这里
 * 只复述真实 tool_end 计数(stream-state 的 successfulToolCount / lastFailedTools),
 * 不替模型编任何话。纯函数,导出供单测。
 */
export function buildToolCompletionSummary(ss: any): string {
  const okCount = Number(ss?.successfulToolCount || 0);
  const failedTools = Array.isArray(ss?.lastFailedTools) ? ss.lastFailedTools.filter(Boolean).map(String) : [];
  const failCount = ss?.hasFailedTool ? Math.max(1, failedTools.length) : 0;
  if (okCount + failCount === 0) return "";
  const evidenceFallback = buildRealtimeEvidenceFallbackSummary(ss);
  if (evidenceFallback) {
    if (failCount === 0) return evidenceFallback;
    const failDetail = failedTools.length ? `(${failedTools.slice(0, 3).join("、")})` : "";
    return `${evidenceFallback}\n\n另有 ${failCount} 个后续工具失败${failDetail}；上方结论仅采用已成功返回的工具证据。`;
  }
  const genericEvidenceFallback = buildGenericToolEvidenceFallbackSummary(ss);
  if (genericEvidenceFallback) {
    if (failCount === 0) return genericEvidenceFallback;
    const failDetail = failedTools.length ? `(${failedTools.slice(0, 3).join("、")})` : "";
    return `${genericEvidenceFallback}\n\n另有 ${failCount} 个后续工具失败${failDetail}；上方结论仅采用已成功返回的操作结果。`;
  }
  // 措辞必须诚实:工具跑完≠任务完成 —— 模型没给总结时,明说"没有总结回复",
  // 不写"✅ 全部成功"那种读起来像任务完成的句式(2026-06-10 用户纠偏:"自报完成")。
  if (failCount === 0) {
    return `本轮完成 ${okCount} 个操作，但没有可见结果摘要；请查看上方工具卡片中的执行详情。`;
  }
  const failDetail = failedTools.length ? `(${failedTools.slice(0, 3).join("、")})` : "";
  return `本轮工具执行包含 ${okCount} 个成功、${failCount} 个失败${failDetail}；请查看上方工具卡片中的失败项。`;
}

const REALTIME_EVIDENCE_TOOL_NAMES = new Set([
  "web_search",
  "websearch",
  "web_fetch",
  "webfetch",
  "sports_score",
  "sportsscore",
  "live_news",
  "livenews",
  "weather",
  "stock_market",
  "stockmarket",
]);

function formatError(err: unknown): string {
  return err && typeof err === "object" && "message" in err
    ? String((err as { message?: unknown }).message || err)
    : String(err);
}

function displayToolName(name: string): string {
  switch (name) {
    case "web_search": return "网页搜索";
    case "websearch": return "网页搜索";
    case "web_fetch": return "网页抓取";
    case "webfetch": return "网页抓取";
    case "sports_score": return "体育比分";
    case "sportsscore": return "体育比分";
    case "live_news": return "实时新闻";
    case "livenews": return "实时新闻";
    case "weather": return "天气";
    case "stock_market": return "行情";
    case "stockmarket": return "行情";
    default: return name;
  }
}

function compactEvidencePreview(value: unknown): string {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 280);
}

function splitEvidenceLines(value: unknown): string[] {
  return String(value || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function isWebFetchToolName(value: unknown): boolean {
  const name = String(value || "").trim().toLowerCase().replace(/-/g, "_");
  return name === "web_fetch" || name === "webfetch";
}

function looksLikeToolEvidenceDismissal(value: unknown): boolean {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return false;
  return /工具(?:已经|已)?返回(?:了)?内容.{0,80}(?:没有|未能|无法).{0,30}(?:提取|形成|得到).{0,30}(?:事实|结论|答案)/iu.test(text)
    || /(?:没有|未能|无法).{0,30}(?:提取|形成|得到).{0,30}(?:足够可靠的)?(?:事实|结论|答案).{0,80}(?:工具|网页|抓取|搜索|返回)/iu.test(text)
    || /(?:网页导航|抓取噪声|搜索摘要).{0,80}(?:当成|作为|冒充).{0,20}(?:结论|事实|答案)/iu.test(text);
}

function firstUsefulSentence(value: unknown): string {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
  if (!text) return "";
  const sentence = text.match(/^(.{12,220}?[。！？.!?])(?:\s|$)/u)?.[1];
  return (sentence || text.slice(0, 180)).trim();
}

export function buildDirectWebFetchEvidenceAnswer(ss: any): string {
  const prompt = String(ss?.originalPromptText || ss?.effectivePromptText || "");
  const tools = Array.isArray(ss?.lastSuccessfulTools) ? ss.lastSuccessfulTools : [];
  const tool = [...tools].reverse().find((item: any) => isWebFetchToolName(item?.name) && String(item?.outputPreview || "").trim());
  if (!tool) return "";

  const lines = splitEvidenceLines(tool.outputPreview);
  const sourceLine = lines.find((line) => /^来源[:：]/.test(line)) || "";
  const source = sourceLine.replace(/^来源[:：]\s*/, "").replace(/\s*\([^)]*\)\s*$/, "").trim();
  const contentLines = lines
    .filter((line) => !/^来源[:：]/.test(line))
    .filter((line) => !/^Learn more\b/i.test(line))
    .filter((line) => !/^更多|^阅读更多/.test(line));
  const title = contentLines[0] || "";
  const body = contentLines.slice(1).find((line) => /[A-Za-z\u4e00-\u9fa5]{8,}/.test(line)) || "";
  const sentence = firstUsefulSentence(body || title);
  if (!sentence) return "";

  const wantsOneSentence = /一句话|一段话|概括|总结|摘要|summari[sz]e|summary/i.test(prompt);
  const subject = source || title || "该页面";
  if (/example\.com/i.test(source) && /Example Domain/i.test(`${title}\n${body}`)) {
    return "example.com 页面是 Example Domain，说明该域名用于文档示例，无需许可即可使用，但应避免用于实际运营。";
  }
  if (wantsOneSentence) {
    return `${subject}：${sentence}`;
  }
  return [`页面：${subject}`, `要点：${sentence}`].join("\n");
}

function successfulToolEvidenceText(ss: any): string {
  const tools = Array.isArray(ss?.lastSuccessfulTools) ? ss.lastSuccessfulTools : [];
  return tools
    .map((tool: any) => [
      tool?.name,
      tool?.command,
      tool?.filePath,
      tool?.outputPreview,
    ].filter(Boolean).join(" "))
    .join("\n");
}

function deniesAvailableToolCapability(text: unknown): boolean {
  const normalized = String(text || "").replace(/\s+/g, "");
  if (!normalized) return false;
  return /(?:工具集|工具箱|工具列表|当前工具|可用工具|CLI工具|LynnCLI工具).{0,24}(?:没有|未包含|不包含|缺少|暂无|不支持).{0,24}(?:天气|搜索|查询|检索|行情|股价|金价|汇率|比分|赛程|网页|访问)/iu.test(normalized)
    || /(?:没有|未包含|不包含|缺少|暂无|不支持).{0,24}(?:天气|搜索|查询|检索|行情|股价|金价|汇率|比分|赛程|网页|访问).{0,24}(?:工具|功能|能力|接口)/iu.test(normalized)
    || /(?:无法|不能|没法|不支持).{0,24}(?:实时|在线|联网|访问网页|查询天气|查询股价|查询汇率|查询比分|查询赛程)/iu.test(normalized);
}

function contradictsRelativeEventEvidence(ss: any, text: unknown): boolean {
  const prompt = String(ss?.originalPromptText || ss?.effectivePromptText || "");
  if (!/(今晚|今夜|今天|今日|昨晚|昨日|昨天|赛程|比分|比赛|场次|半决赛|决赛|schedule|score|match|game|tonight|today|yesterday|semifinal|final)/iu.test(prompt)) return false;
  const normalized = String(text || "").replace(/\s+/g, "");
  if (!normalized) return false;
  const saysNoEvent = /(?:没有|无|暂无|未查到|没有剩余|无剩余).{0,20}(?:比赛|赛事|赛程|场次|比分|结果|资料|信息)/iu.test(normalized)
    || /(?:比赛|赛事|赛程|场次|比分|结果|资料|信息).{0,20}(?:没有|无|暂无|未查到)/iu.test(normalized);
  if (!saysNoEvent) return false;
  const evidence = successfulToolEvidenceText(ss);
  return /(?:Scheduled|待开赛|即将开赛|未开始|\bvs\b|\d{1,2}:\d{2}|比分|FT|\d+\s*[-–—:：比]\s*\d+)/iu.test(evidence);
}

function hasMarketNumericEvidence(prompt: unknown, text: unknown): boolean {
  const p = String(prompt || "");
  const value = String(text || "");
  if (/(金价|黄金|XAU|gold)/iu.test(p)) {
    return /\d{3,5}(?:\.\d+)?\s*元\/克|\d{3,5}(?:\.\d+)?\s*美元\/盎司|XAU\/USD[\s\S]{0,100}\d{3,5}(?:\.\d+)?/iu.test(value);
  }
  if (/(汇率|美元人民币|美元兑人民币|USD\s*\/?\s*CNY|人民币)/iu.test(p)) {
    return /1\s*(?:USD|美元)\s*=\s*\d+(?:\.\d+)?\s*(?:CNY|人民币)|USD\/CNY[\s\S]{0,100}\d+(?:\.\d+)?|美元[兑对]人民币[\s\S]{0,100}\d+(?:\.\d+)?|汇率[\s\S]{0,100}\d+(?:\.\d+)?/iu.test(value);
  }
  if (/(股价|股票|行情|最新价|现价|NVDA|AAPL|TSLA|MSFT|英伟达|苹果|特斯拉)/iu.test(p)) {
    return /\$?\d+(?:\.\d+)?\s*(?:USD|美元|港元|HKD|元)?|涨跌|涨幅|收盘|最新价|当前价/iu.test(value);
  }
  return true;
}

function lacksMarketNumericAnswerDespiteEvidence(ss: any, text: unknown): boolean {
  const prompt = String(ss?.originalPromptText || ss?.effectivePromptText || "");
  if (!/(金价|黄金|汇率|美元人民币|美元兑人民币|USD\s*\/?\s*CNY|股价|股票|行情|最新价|现价|NVDA|AAPL|TSLA|MSFT|英伟达|苹果|特斯拉)/iu.test(prompt)) {
    return false;
  }
  const evidence = successfulToolEvidenceText(ss);
  return hasMarketNumericEvidence(prompt, evidence) && !hasMarketNumericEvidence(prompt, text);
}

function lacksWeatherAnswerDespiteEvidence(ss: any, text: unknown): boolean {
  const prompt = String(ss?.originalPromptText || ss?.effectivePromptText || "");
  if (!/(天气|气温|温度|下雨|降雨|降水|空气质量|AQI|冷不冷|热不热|带伞|雨伞)/iu.test(prompt)) return false;
  const evidence = successfulToolEvidenceText(ss);
  if (!/(天气|温度|气温|降雨|降水|雷暴|阵雨|°C|℃|\d+\s*%)/iu.test(evidence)) return false;
  const normalized = String(text || "").replace(/\s+/g, "");
  if (/(人类活动史|建城史|生态环境局|工业和信息化局|机动车排放|高新技术企业|政府工作报告|百度百科|如果需要更精确的实时结论)/iu.test(normalized)) {
    return true;
  }
  if (/(下雨|降雨|降水|带伞|雨伞)/iu.test(prompt) && !/(雨|降雨|降水|雷暴|阵雨|\d+\s*%|带伞|不用伞|不必带伞)/iu.test(normalized)) {
    return true;
  }
  if (/(空气质量|AQI)/iu.test(prompt) && !/(AQI|空气质量|优|良|轻度|中度|重度|\d+)/iu.test(normalized)) {
    return true;
  }
  return false;
}

export function selectToolEvidenceVisibleText(ss: any, candidate: unknown): string {
  const text = String(candidate || "").trim();
  if (!text) return buildToolCompletionSummary(ss);
  if (looksLikeToolEvidenceDismissal(text)) {
    return buildDirectWebFetchEvidenceAnswer(ss)
      || buildToolCompletionSummary(ss)
      || "";
  }
  if (
    deniesAvailableToolCapability(text)
    || contradictsRelativeEventEvidence(ss, text)
    || lacksMarketNumericAnswerDespiteEvidence(ss, text)
    || lacksWeatherAnswerDespiteEvidence(ss, text)
  ) {
    return buildToolCompletionSummary(ss) || "";
  }
  return text;
}

export function buildRealtimeEvidenceFallbackSummary(ss: any): string {
  const tools = Array.isArray(ss?.lastSuccessfulTools) ? ss.lastSuccessfulTools : [];
  const evidence = tools
    .filter((tool: any) => REALTIME_EVIDENCE_TOOL_NAMES.has(String(tool?.name || "")))
    .map((tool: any) => ({
      name: String(tool?.name || ""),
      preview: compactEvidencePreview(tool?.outputPreview),
    }))
    .filter((tool: any) => tool.name && tool.preview)
    .slice(-4);

  if (!evidence.length) return "";
  const lines = evidence.map((tool: any) => `- ${displayToolName(tool.name)}: ${tool.preview}`);
  return [
    "根据本轮已执行工具返回的证据，当前能确认：",
    ...lines,
    "",
    "以上只包含工具结果中可见的事实；工具未返回或来源未覆盖的部分，不能继续补推。",
  ].join("\n");
}

function buildGenericToolEvidenceFallbackSummary(ss: any): string {
  const tools = Array.isArray(ss?.lastSuccessfulTools) ? ss.lastSuccessfulTools : [];
  const evidence = tools
    .map((tool: any) => {
      const name = String(tool?.name || "").trim();
      const bits = [
        String(tool?.command || "").trim(),
        String(tool?.filePath || "").trim(),
        compactEvidencePreview(tool?.outputPreview),
      ].filter(Boolean);
      return { name, preview: bits.join(" · ") };
    })
    .filter((tool: any) => tool.name || tool.preview)
    .slice(-6);

  if (!evidence.length) return "";
  const lines = evidence.map((tool: any) => {
    const label = tool.name ? displayToolName(tool.name) : "工具";
    return tool.preview ? `- ${label}: ${tool.preview}` : `- ${label}: 已完成`;
  });
  return [
    "根据本轮已执行操作返回的可见结果，当前能确认：",
    ...lines,
    "",
    "以上只包含操作结果中可见的事实；未覆盖的部分不能继续补推。",
  ].join("\n");
}

export interface ToolTurnFinalizerDeps {
  engine: any;
  editRollbackStore: any;
  lifecycleHooks: any;
  broadcast: (msg: any) => void;
  emitStreamEvent: (sessionPath: string, ss: any, event: any) => void;
  emitTrustedVisibleTextDelta: (sessionPath: string, ss: any, delta: unknown) => boolean;
  emitVisibleTextDelta: (sessionPath: string, ss: any, delta: unknown) => void;
  flushBufferedAssistantText: (sessionPath: string, ss: any) => void;
  flushBufferedToolVisibleText: (sessionPath: string, ss: any, finalText?: string) => void;
  maybeAppendCodeVerificationPostscript: (sessionPath: string, ss: any) => boolean;
  hasStreamEvent: (ss: any, type: string) => boolean;
  hasScheduledInternalRetry: (ss: any) => boolean;
  hasToolExecutionInFlight: (ss: any) => boolean;
  hasDifferentActiveStreamToken: (ss: any, streamToken: any) => boolean;
  timeouts: {
    returnedTurnFinalizationGraceMs: number;
    turnHardAbortMs: number;
    turnLongResearchHardAbortMs: number;
    toolFinalizationGraceMs: number;
    toolAuthorizationGraceMs: number;
  };
}

export function createToolTurnFinalizer({
  engine,
  editRollbackStore,
  lifecycleHooks,
  broadcast,
  emitStreamEvent,
  emitTrustedVisibleTextDelta,
  emitVisibleTextDelta,
  flushBufferedAssistantText,
  flushBufferedToolVisibleText,
  maybeAppendCodeVerificationPostscript,
  hasStreamEvent,
  hasScheduledInternalRetry,
  hasToolExecutionInFlight,
  hasDifferentActiveStreamToken,
  timeouts,
}: ToolTurnFinalizerDeps) {
  function persistVisibleFallbackText(sessionPath: any, ss: any, text: any): boolean {
    const visibleText = String(text || "");
    if (!sessionPath || !visibleText.trim()) return false;
    const session = engine.getSessionByPath?.(sessionPath);
    let persisted = false;
    const latest = latestPersistedMessageText(sessionPath);
    const fallbackMessage = {
      role: "assistant",
      content: [{ type: "text", text: visibleText }],
      timestamp: Date.now(),
    };
    if (latest?.role === "assistant") {
      persisted = appendTextToLatestAssistantRecord(sessionPath, visibleText);
    }
    if (!persisted) {
      try {
        appendJsonlLine(sessionPath, {
          type: "message",
          id: sessionLineId(),
          parentId: getLastSessionEntryId(sessionPath),
          timestamp: new Date().toISOString(),
          message: fallbackMessage,
        });
        persisted = true;
      } catch (err) {
        debugLog()?.warn("ws", `[TURN-CLOSE-FALLBACK v2] persist fallback failed · ${formatError(err)} · ${sessionPath}`);
      }
    }
    const sessionMessages = session && Array.isArray(session.messages) ? session.messages : null;
    const latestInMemory = sessionMessages?.[sessionMessages.length - 1];
    const inMemoryAppended = latest?.role === "assistant" && latestInMemory?.role === "assistant"
      ? appendTextToLatestAssistantInMemory(session, visibleText)
      : false;
    if (!inMemoryAppended && session && Array.isArray(session.messages)) {
      try {
        session.messages.push(fallbackMessage);
      } catch (err) {
        debugLog()?.warn("ws", `[TURN-CLOSE-FALLBACK v2] memory fallback failed · ${formatError(err)} · ${sessionPath}`);
      }
    }
    return persisted || inMemoryAppended;
  }

  function closeStreamWithVisibleFallback(sessionPath: any, ss: any, text: any, reason: any, opts: any = {}) {
    if (!sessionPath || !ss || ss._turnClosed || hasStreamEvent(ss, "turn_end")) return false;
    ss._turnClosed = true;
    ss.internalRetryPending = false;
    ss.internalRetryInFlight = false;
    ss.internalRetryReason = "";
    clearTurnTimers(ss);
    editRollbackStore.discardPendingForSession(sessionPath, ss.activeStreamToken || null);
    if (ss.isThinking) {
      ss.isThinking = false;
      emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
    }
    if (text && (!ss.hasOutput || opts.appendEvenIfHasOutput)) {
      const prefix = ss.hasOutput && opts.appendEvenIfHasOutput ? "\n\n" : "";
      persistVisibleFallbackText(sessionPath, ss, prefix + text);
      if (opts.trustedFallback) {
        emitTrustedVisibleTextDelta(sessionPath, ss, prefix + text);
      } else {
        emitVisibleTextDelta(sessionPath, ss, prefix + text);
      }
    }
    maybeAppendCodeVerificationPostscript(sessionPath, ss);
    emitStreamEvent(sessionPath, ss, { type: "turn_end" });
    lifecycleHooks.run("turn_close", { sessionPath, ss, reason, forced: true });
    broadcast({ type: "status", isStreaming: false, sessionPath });
    finishSessionStream(ss);
    resetCompletedTurnState(ss);
    debugLog()?.warn("ws", `[TURN-CLOSE-FALLBACK v1] closed stream · reason=${reason} · session=${sessionPath}`);
    return true;
  }

  function normalizeVisibleForCompare(text: any) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function isMeaningfulPersistedFinalText(finalText: any, ss: any) {
    const final = normalizeVisibleForCompare(finalText);
    if (!final) return false;
    const visible = normalizeVisibleForCompare(ss?.visibleTextAcc || "");
    if (!visible) return true;
    if (final === visible) return false;
    if (final.length <= visible.length + 20 && (final.includes(visible) || visible.includes(final))) return false;
    return true;
  }

  function hasToolEvidence(ss: any) {
    return !!(ss?.hasToolCall || ss?.hasPrefetchToolCall || Number(ss?.successfulToolCount || 0) > 0);
  }

  function buildEmptyTurnFallbackText(ss: any, reason: any = "") {
    if (!ss || ss.hasOutput) return "";
    const toolFallback = String(ss.realtimeToolFallbackText || "").trim();
    if (toolFallback) return toolFallback;
    if (reason === "hard_turn_timeout" && !hasToolEvidence(ss)) {
      return buildLocalOfficeDirectAnswer(ss.originalPromptText || ss.effectivePromptText || "");
    }
    // 工具都跑完了但模型没给收尾文本(issue #72 第三类的 GUI 变体:"有授权卡片但最后没有反馈")。
    // V0.79 禁止编造内容 —— 这里只输出基于真实 tool_end 计数的事实行,不替模型说话。
    return buildToolCompletionSummary(ss)
      || "模型这次没有返回可见内容。本轮已安全结束，避免空回复污染后续上下文；请点「编辑重发」重试，或切换默认模型后再发。";
  }

  function buildRealtimeToolFallbackText(toolName: any, event: any) {
    const name = String(toolName || event?.toolName || "");
    if (!["stock_market", "weather", "live_news", "sports_score"].includes(name)) return "";
    const text = extractText(event?.result?.content || "").trim();
    if (!text) return "";
    if (name === "stock_market") {
      const disclaimer = /不构成投资建议|not investment advice/i.test(text)
        ? ""
        : "\n\n说明：以上是工具返回的最近可用行情摘要，不构成投资建议；关键价格、时间戳和来源请以交易所、券商或专门行情源交叉核验。";
      return `${text}${disclaimer}`;
    }
    return text;
  }

  function finalizeReturnedTurnWithoutStream(sessionPath: any, ss: any, reason: any, opts: any = {}) {
    if (!sessionPath || !ss || ss._turnClosed || hasStreamEvent(ss, "turn_end")) return false;
    if (hasToolExecutionInFlight(ss)) return false;
    if (!opts.ignoreInternalRetry && hasScheduledInternalRetry(ss)) return false;
    const session = engine.getSessionByPath(sessionPath);
    const finalText = !ss.hasOutput
      ? extractLatestAssistantVisibleText(session, sessionPath)
      : "";
    if (opts.requirePersistedText && !ss.hasOutput && !finalText) return false;
    return closeStreamWithVisibleFallback(sessionPath, ss, finalText, reason, { trustedFallback: true });
  }

  function scheduleReturnedTurnFinalizationFallback(sessionPath: any, ss: any, reason: any) {
    clearReturnedTurnFinalizationTimer(ss);
    if (!sessionPath || !ss || !timeouts.returnedTurnFinalizationGraceMs) return false;
    const streamToken = ss.activeStreamToken || null;
    ss.returnedTurnFinalizationTimer = setTimeout(() => {
      ss.returnedTurnFinalizationTimer = null;
      if (
        hasDifferentActiveStreamToken(ss, streamToken) ||
        ss.hasError ||
        ss._turnClosed ||
        hasStreamEvent(ss, "turn_end") ||
        hasToolExecutionInFlight(ss) ||
        hasScheduledInternalRetry(ss)
      ) {
        return;
      }
      finalizeReturnedTurnWithoutStream(sessionPath, ss, reason, { requirePersistedText: true });
    }, timeouts.returnedTurnFinalizationGraceMs);
    if (ss.returnedTurnFinalizationTimer.unref) ss.returnedTurnFinalizationTimer.unref();
    return true;
  }

  function schedulePersistedFinalAnswerPoll(sessionPath: any, ss: any) {
    clearPersistedFinalAnswerPollTimer(ss);
    if (!sessionPath || !ss) return false;
    const streamToken = ss.activeStreamToken || null;
    ss.persistedFinalAnswerPollTimer = setInterval(() => {
      if (
        hasDifferentActiveStreamToken(ss, streamToken) ||
        ss.hasError ||
        ss.hasOutput ||
        ss._turnClosed ||
        hasStreamEvent(ss, "turn_end") ||
        hasScheduledInternalRetry(ss)
      ) {
        clearPersistedFinalAnswerPollTimer(ss);
        return;
      }
      if (hasToolExecutionInFlight(ss)) return;
      const finalText = extractLatestAssistantVisibleTextAfter(
        engine.getSessionByPath(sessionPath),
        sessionPath,
        ss.persistedAssistantTextBaseline || 0,
      );
      if (finalText) {
        closeStreamWithVisibleFallback(sessionPath, ss, finalText, "persisted_final_answer_poll", { trustedFallback: true });
      }
    }, 1000);
    if (ss.persistedFinalAnswerPollTimer.unref) ss.persistedFinalAnswerPollTimer.unref();
    return true;
  }

  function scheduleTurnHardAbort(sessionPath: any, ss: any) {
    clearTurnHardAbortTimer(ss);
    if (!sessionPath || !ss || !timeouts.turnHardAbortMs) return;
    const streamToken = ss.activeStreamToken || null;
    const originalOrEffectivePrompt = `${ss.originalPromptText || ""}\n${ss.effectivePromptText || ""}`;
    const isLongResearchTurn =
      /(?:深度|深入|完整|系统性|多维度|全面|调研|研究|研报|报告|分析报告|形成\s*docx|docx\s*格式|来源包括|但不限于|学术界|咨询领域|小红书|抖音|快手|视频号|公众号)/i.test(originalOrEffectivePrompt);
    const deterministicFallbackText = buildLocalOfficeDirectAnswer(ss.originalPromptText || ss.effectivePromptText || "");
    const localOfficeFallbackMs = Number(process.env.LYNN_LOCAL_OFFICE_FALLBACK_MS || 35_000);
    const baseTimeoutMs = isLongResearchTurn
      ? Math.max(timeouts.turnHardAbortMs, timeouts.turnLongResearchHardAbortMs || timeouts.turnHardAbortMs)
      : timeouts.turnHardAbortMs;
    const timeoutMs = deterministicFallbackText && !isLongResearchTurn
      ? Math.min(baseTimeoutMs, Math.max(10_000, localOfficeFallbackMs))
      : baseTimeoutMs;
    if (isLongResearchTurn && timeoutMs !== timeouts.turnHardAbortMs) {
      debugLog()?.log("ws", `[TURN-HARD-ABORT v2] long research turn timeout=${timeoutMs}ms · session=${sessionPath}`);
    }
    ss.turnHardAbortTimer = setTimeout(() => {
      ss.turnHardAbortTimer = null;
      if (hasDifferentActiveStreamToken(ss, streamToken) || ss.hasError || hasStreamEvent(ss, "turn_end")) return;
      ss._lastTurnAborted = true;
      Promise.resolve(engine.abortSessionByPath?.(sessionPath)).catch(() => {});
      closeStreamWithVisibleFallback(
        sessionPath,
        ss,
        buildEmptyTurnFallbackText(ss, "hard_turn_timeout"),
        "hard_turn_timeout",
        { trustedFallback: true },
      );
    }, timeoutMs);
    if (ss.turnHardAbortTimer.unref) ss.turnHardAbortTimer.unref();
  }

  function scheduleToolFinalizationFallback(sessionPath: any, ss: any): void {
    clearToolFinalizationTimer(ss);
    if (!sessionPath || !ss || !timeouts.toolFinalizationGraceMs) return;
    const streamToken = ss.activeStreamToken || null;
    ss.toolFinalizationTimer = setTimeout(() => {
      ss.toolFinalizationTimer = null;
      if (
        hasDifferentActiveStreamToken(ss, streamToken) ||
        ss.hasError ||
        hasStreamEvent(ss, "turn_end")
      ) {
        return;
      }
      if (hasToolExecutionInFlight(ss)) {
        flushBufferedAssistantText(sessionPath, ss);
        const toolStartedAt = Number.isFinite(ss.activeToolCallStartedAt)
          ? ss.activeToolCallStartedAt
          : (Number.isFinite(ss.lastToolExecutionActivity) ? ss.lastToolExecutionActivity : Date.now());
        const toolAgeMs = Date.now() - toolStartedAt;
        if ((ss.hasOutput || ss.hasBufferedVisibleTextDuringTool) && toolAgeMs >= timeouts.toolFinalizationGraceMs) {
          const finalText = extractLatestAssistantVisibleTextAfter(
            engine.getSessionByPath(sessionPath),
            sessionPath,
            ss.persistedAssistantTextBaseline || 0,
          );
          ss.activeToolCallCount = 0;
          ss.activeToolCallStartedAt = null;
          ss.recoveredBashInFlight = false;
          const bufferedCandidate = isMeaningfulPersistedFinalText(finalText, ss)
            ? finalText
            : String(ss.bufferedVisibleTextDuringTool || "");
          flushBufferedToolVisibleText(
            sessionPath,
            ss,
            selectToolEvidenceVisibleText(ss, bufferedCandidate),
          );
          debugLog()?.warn("ws", `[TOOL-MISSING-END-FENCE v1] closing turn with visible output despite missing tool_end · age=${toolAgeMs}ms · session=${sessionPath}`);
          Promise.resolve(engine.abortSessionByPath?.(sessionPath)).catch(() => {});
          closeStreamWithVisibleFallback(
            sessionPath,
            ss,
            "",
            "tool_missing_end_after_output",
          );
          return;
        }
        scheduleToolFinalizationFallback(sessionPath, ss);
        return;
      }
      Promise.resolve(engine.abortSessionByPath?.(sessionPath)).catch(() => {});
      if (ss.hasBufferedVisibleTextDuringTool && !ss.hasOutput) {
        const finalText = extractLatestAssistantVisibleTextAfter(
          engine.getSessionByPath(sessionPath),
          sessionPath,
          ss.persistedAssistantTextBaseline || 0,
        );
        const bufferedCandidate = isMeaningfulPersistedFinalText(finalText, ss)
          ? finalText
          : String(ss.bufferedVisibleTextDuringTool || "");
        flushBufferedToolVisibleText(
          sessionPath,
          ss,
          selectToolEvidenceVisibleText(ss, bufferedCandidate),
        );
      }
      closeStreamWithVisibleFallback(
        sessionPath,
        ss,
        buildEmptyTurnFallbackText(ss, "tool_finalization_timeout"),
        "tool_finalization_timeout",
        { trustedFallback: true },
      );
    }, timeouts.toolFinalizationGraceMs);
    if (ss.toolFinalizationTimer.unref) ss.toolFinalizationTimer.unref();
  }

  function scheduleToolAuthorizationFallback(sessionPath: any, ss: any): void {
    clearToolAuthorizationTimer(ss);
    clearToolAuthorizationPollTimer(ss);
    if (!sessionPath || !ss || !timeouts.toolAuthorizationGraceMs || !ss.isStreaming || ss._turnClosed || hasStreamEvent(ss, "turn_end")) return;
    clearSilentBrainAbortTimer(ss);
    const streamToken = ss.activeStreamToken || null;
    ss.toolAuthorizationPollTimer = setInterval(() => {
      if (
        hasDifferentActiveStreamToken(ss, streamToken) ||
        ss.hasError ||
        hasStreamEvent(ss, "turn_end")
      ) {
        clearToolAuthorizationPollTimer(ss);
        return;
      }
      const finalText = extractLatestAssistantVisibleText(engine.getSessionByPath(sessionPath), sessionPath);
      if (isMeaningfulPersistedFinalText(finalText, ss)) {
        if (hasToolExecutionInFlight(ss)) return;
        closeStreamWithVisibleFallback(sessionPath, ss, finalText, "tool_authorization_persisted_final");
      }
    }, 1000);
    if (ss.toolAuthorizationPollTimer.unref) ss.toolAuthorizationPollTimer.unref();
    ss.toolAuthorizationTimer = setTimeout(() => {
      ss.toolAuthorizationTimer = null;
      if (hasDifferentActiveStreamToken(ss, streamToken) || ss.hasError || hasStreamEvent(ss, "turn_end")) return;
      if (hasToolExecutionInFlight(ss)) {
        scheduleToolAuthorizationFallback(sessionPath, ss);
        return;
      }
      Promise.resolve(engine.abortSessionByPath?.(sessionPath)).catch(() => {});
      const finalText = extractLatestAssistantVisibleText(engine.getSessionByPath(sessionPath), sessionPath);
      const meaningfulFinalText = isMeaningfulPersistedFinalText(finalText, ss) ? finalText : "";
      // 没有模型收尾文本时,给一行真实工具结果的事实反馈,而不是静默关流
      //(用户视角:命令执行成功了却没有任何回应)。
      const fallbackText = meaningfulFinalText || buildEmptyTurnFallbackText(ss, "tool_authorization_timeout");
      closeStreamWithVisibleFallback(
        sessionPath,
        ss,
        fallbackText,
        "tool_authorization_timeout",
        meaningfulFinalText ? {} : { trustedFallback: true },
      );
    }, timeouts.toolAuthorizationGraceMs);
    if (ss.toolAuthorizationTimer.unref) ss.toolAuthorizationTimer.unref();
  }

  function scheduleSilentBrainAbort(_sessionPath: any, ss: any): void {
    clearSilentBrainAbortTimer(ss);
  }

  function closeStreamAfterError(sessionPath: any, ss: any, reason: any = "model_tool_error") {
    if (!sessionPath || !ss || hasStreamEvent(ss, "turn_end")) return;
    if (!ss.hasOutput && !ss.hasToolCall) ss._lastTurnAborted = true;
    const fallbackText = !ss.hasOutput
      ? (hasToolEvidence(ss)
        ? buildEmptyTurnFallbackText(ss, reason)
        : ss.hasThinking
        ? "模型请求中断前只返回了思考过程，没有给出最终可见答案。本轮已安全结束，避免空回复污染后续上下文；请点「编辑重发」重试，或稍后再发。"
        : buildEmptyTurnFallbackText(ss, reason))
      : "";
    closeStreamWithVisibleFallback(sessionPath, ss, fallbackText, reason, fallbackText ? { trustedFallback: true } : {});
  }

  return {
    buildRealtimeToolFallbackText,
    closeStreamAfterError,
    closeStreamWithVisibleFallback,
    finalizeReturnedTurnWithoutStream,
    isMeaningfulPersistedFinalText,
    schedulePersistedFinalAnswerPoll,
    scheduleReturnedTurnFinalizationFallback,
    scheduleSilentBrainAbort,
    scheduleToolAuthorizationFallback,
    scheduleToolFinalizationFallback,
    scheduleTurnHardAbort,
  };
}
