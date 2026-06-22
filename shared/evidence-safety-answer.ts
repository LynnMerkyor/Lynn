export type EvidenceMessage = {
  role?: string;
  content?: unknown;
  name?: string;
};

function dateSerial(year: number, month: number, day: number): number | null {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return year * 10_000 + month * 100 + day;
}

function beijingDateParts(now = new Date()): { year: number; month: number; day: number; serial: number } {
  const formatted = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const [year, month, day] = formatted.split("-").map((part) => Number(part));
  return { year, month, day, serial: dateSerial(year, month, day) ?? 0 };
}

function extractExplicitDateSerials(text: string): number[] {
  const current = beijingDateParts();
  const serials: number[] = [];
  const push = (year: number, month: number, day: number) => {
    const serial = dateSerial(year, month, day);
    if (serial != null) serials.push(serial);
  };
  for (const match of text.matchAll(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g)) {
    push(Number(match[1]), Number(match[2]), Number(match[3]));
  }
  for (const match of text.matchAll(/(\d{4})[-/](\d{1,2})(?:[-/](\d{1,2}))?/g)) {
    push(Number(match[1]), Number(match[2]), Number(match[3] || "1"));
  }
  for (const match of text.matchAll(/(?<!\d)(\d{1,2})\s*月\s*(\d{1,2})\s*日/g)) {
    push(current.year, Number(match[1]), Number(match[2]));
  }
  return [...new Set(serials)];
}

function containsPastDateFutureStartContradiction(text: string): boolean {
  const compact = String(text || "").replace(/\s+/g, "");
  if (!compact) return false;
  const today = beijingDateParts().serial;
  if (!extractExplicitDateSerials(compact).some((serial) => serial <= today)) return false;
  const futureStart =
    /(?:要到|将在|将于|预计|计划|还要等到|才会|才)[^。；;!?！？]{0,50}(?:开幕|开赛|开始|举行|进行|打响|正赛)/.test(compact) ||
    /(?:开幕|开赛|开始|举行|进行|打响|正赛)[^。；;!?！？]{0,50}(?:尚未|还没|还未|未|暂无)/.test(compact);
  const noResult =
    /(?:没有|暂无|尚未|还没有|还未|未查到|未获取到|未找到|未产生|无法获取)[^。；;!?！？]{0,60}(?:比分|赛果|结果|比赛|赛程|正赛|数据|信息)/.test(compact) ||
    /(?:比分|赛果|结果|比赛|赛程|正赛|数据|信息)[^。；;!?！？]{0,60}(?:没有|暂无|尚未|还没有|还未|未查到|未获取到|未找到|未产生|无法获取)/.test(compact);
  return futureStart && noResult;
}

export function contentToEvidenceText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const record = part as Record<string, unknown>;
      if (typeof record.text === "string") return record.text;
      if (typeof record.content === "string") return record.content;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function sanitizeToolEvidenceText(text: string): string {
  return text
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false;
      if (/^error\.[A-Za-z0-9_.-]+$/i.test(line)) return false;
      if (/\bTool not found\s*:/i.test(line)) return false;
      if (/工具(?:当前)?不可用[:：]/.test(line)) return false;
      if (/providerQuery is not defined/i.test(line)) return false;
      if (/\b(?:fetch failed|LLM request failed|aborted)\b/i.test(line)) return false;
      if (/^(?:抓取出错|访问页面失败|模型请求超时|模型请求失败)[:：]/.test(line)) return false;
      return true;
    })
    .join("\n")
    .trim();
}

export function collectToolEvidence(messages: EvidenceMessage[], maxChars = 5000): string {
  const entries = messages
    .filter((message) => message.role === "tool")
    .map((message, index) => {
      const text = sanitizeToolEvidenceText(contentToEvidenceText(message.content).replace(/\s+\n/g, "\n"));
      if (!text) return "";
      const name = message.name ? ` (${message.name})` : "";
      return `#${index + 1}${name}\n${text}`;
    })
    .filter(Boolean)
    .slice(-6);
  const joined = entries.join("\n\n");
  if (joined.length <= maxChars) return joined;
  return `${joined.slice(0, maxChars)}\n...[已截断过长工具证据]`;
}

export function evidenceToReadableLines(raw: string): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  const normalized = raw
    .replace(/\r/g, "\n")
    .replace(/error\.[A-Za-z0-9_.-]+/g, "")
    .replace(/📋\s*综合答案[:：]?/g, "")
    .replace(/\n{3,}/g, "\n\n");
  const chunks = normalized
    .replace(/(?<=[。！？!?])\s+(?=[^\s#])/g, "\n")
    .split(/\n+|(?=[^。\n]{4,90}\(\d{4}-\d{2}-\d{2}\)[:：])/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const chunk of chunks) {
    let line = chunk
      .replace(/^#\d+(?:\s+\([^)]+\))?\s*/g, "")
      .replace(/^[-•]\s*/g, "")
      .replace(/^搜索提示[:：].*$/g, "")
      .replace(/^sources?:.*$/i, "")
      .replace(/^details?:.*$/i, "")
      .replace(/^摘要[:：]\s*/g, "")
      .replace(/\.\.\.\[已截断过长工具证据\]$/g, "")
      .replace(/\bhttps?:\/\/\S+/gi, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!line || line.length < 8) continue;
    if (/^(搜索提示|工具证据|用户问题|已截断|#\d+)/.test(line)) continue;
    if (/^error\./i.test(line)) continue;
    if (/\bTool not found\s*:/i.test(line) || /工具(?:当前)?不可用[:：]/.test(line)) continue;
    if (/^\(?没有可用工具证据\)?$/.test(line)) continue;
    if (isLowValueToolEvidenceLine(line)) continue;
    if (!hasEnoughFactDensity(line)) continue;
    if (line.length > 220) line = `${line.slice(0, 218)}…`;
    const key = line.replace(/\s+/g, "");
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(line);
    if (lines.length >= 6) break;
  }
  return lines;
}

function isLowValueToolEvidenceLine(line: string): boolean {
  const compact = line.replace(/\s+/g, "");
  if (!compact) return true;
  if (containsPastDateFutureStartContradiction(line)) return true;
  if (/javascript\s*:|void\(0\)|szqbl\.chscht\.run/i.test(line)) return true;
  if (/您的?浏览器版本过低|请升级到|急速模式|无障碍阅读|手机版|热门搜|点击播放|视频加载|Skip to content|Previous\s+Next/i.test(line)) return true;
  if (/^\W*(?:来源|链接|URL|网站支持|数据开放|English|繁體)(?:\s|[:：]|$)/i.test(line)) return true;
  if (/^[\s\W]*(?:html|text|json|xml)\s*[→-]\s*(?:html|text|json|xml)/i.test(line)) return true;
  const urlLikeCount = (line.match(/\b(?:https?:\/\/|www\.|[a-z0-9-]+\.(?:com|cn|org|net|gov)\b)/gi) || []).length;
  if (urlLikeCount >= 2 && compact.length < 180) return true;
  const alphaNum = compact.replace(/[^\p{L}\p{N}]/gu, "");
  return alphaNum.length < Math.max(6, compact.length * 0.35);
}

function hasEnoughFactDensity(line: string): boolean {
  const text = line.trim();
  if (!text) return false;
  const compact = text.replace(/\s+/g, "");
  const hasEntityText = /[\p{L}\p{Script=Han}]{2,}/u.test(text);
  const hasNumber = /\d|[一二三四五六七八九十百千万]/.test(text);
  if (!hasEntityText || !hasNumber) return false;

  const hasScoreLike =
    /[\p{L}\p{Script=Han}][^。\n]{0,80}(?:\d+|[一二三四五六七八九十]+)\s*(?:[-:：比]\s*|比)(?:\d+|[一二三四五六七八九十]+)[^。\n]{0,80}[\p{L}\p{Script=Han}]/u.test(text);
  const hasDateLike =
    /\d{4}[-/年]\d{1,2}(?:[-/月]\d{1,2})?|\d{1,2}月\d{1,2}日|\d{1,2}:\d{2}|UTC|GMT|北京时间|发布(?:时间)?[:：]?\s*\d{4}/i.test(text);
  const hasMeasuredValue =
    /\d+(?:\.\d+)?\s*(?:%|℃|CNY|USD|RMB|CNH|HKD|EUR|JPY|元|美元|人民币|港元|欧元|日元|克|盎司|分|场|次|点|日|月|年|mm|毫米|km\/h|公里\/小时|AQI|级|倍|万|亿)/i.test(text);
  const hasRangeOrEquation =
    /\d+(?:\.\d+)?\s*(?:[-–—~至到]\s*)\d+(?:\.\d+)?/.test(text) ||
    /\b[A-Z]{2,6}\s*[=/]\s*\d+(?:\.\d+)?\b/i.test(text);
  const hasAttributionDate = /\(\d{4}-\d{2}-\d{2}\)|发布(?:时间)?[:：]?\s*\d{4}-\d{2}-\d{2}/.test(text);
  const hasStructuredSeparator = /[：:，,；;。]/.test(text);

  if (hasScoreLike) return true;
  if ((hasMeasuredValue || hasRangeOrEquation) && (hasDateLike || hasAttributionDate || compact.length <= 180)) return true;
  if (hasDateLike && hasStructuredSeparator && compact.length <= 180) return true;
  return false;
}

function latestUserQuestion(messages: EvidenceMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "user") continue;
    const text = contentToEvidenceText(message.content).trim();
    if (text) return text;
  }
  return "";
}

function buildInsufficientEvidenceAnswer(question: string): string {
  return [
    question ? `针对“${question}”，工具已经返回内容，但没有提取到足够可靠的事实来直接回答。` : "工具已经返回内容，但没有提取到足够可靠的事实来直接回答。",
    "",
    "我不会把网页导航、搜索摘要或抓取噪声当成结论。建议换一个更明确的数据源/时间范围再查，或继续让我重新检索并交叉验证。",
  ].join("\n");
}

export function buildEvidenceSafetyAnswer(messages: EvidenceMessage[]): string {
  const question = latestUserQuestion(messages);
  const evidence = collectToolEvidence(messages, 2600);
  if (!evidence) return "";
  const lines = evidenceToReadableLines(evidence);
  if (!lines.length) return buildInsufficientEvidenceAnswer(question);
  return [
    question ? `针对“${question}”，我能从工具证据中确认：` : "我能从工具证据中确认：",
    "",
    ...lines.map((line) => `- ${line}`),
    "",
    "如果需要更精确的实时结论，建议继续用官方或专业数据源交叉验证。",
  ].filter(Boolean).join("\n");
}
