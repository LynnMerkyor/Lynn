// Brain v2 · Evidence Quality Protocol
//
// This is the shared "Codex + Kun" reliability layer for volatile facts:
// plan/act can still be model-led, but search and synthesis must obey a small
// evidence contract instead of growing per-topic keyword patches.

export type EvidenceGrade = "fast" | "source";

export interface EvidencePolicy {
  grade: EvidenceGrade;
  reason: string;
}

const EVENT_SHAPE_RE = /(比赛|赛事|赛程|赛果|比分|对阵|场次|几场|开赛|几点|直播|杯|联赛|小组赛|淘汰赛|决赛|半决赛|总决赛|主客场|赛况|event|game|match|fixture|schedule|score|result|finals|tournament|league|cup|kickoff)/i;
const EVENT_ANSWER_RE = /(比分|赛果|结果|赛程|对阵|场次|几场|哪一天|哪天|什么时候|日期|昨晚|昨日|昨天|今晚|今夜|今天|今日|明天|开赛|几点|时间|直播|schedule|fixture|score|result|match|kickoff|when|date)/i;
const FRESH_RE = /(最新|实时|当前|现在|今天|今日|今晚|今夜|昨晚|昨日|昨天|明天|本周|本月|今年|刚刚|latest|current|today|tonight|yesterday|tomorrow|live|now)/i;
const VOLATILE_FACT_RE = /(股价|行情|金价|汇率|价格|票价|收费|会费|费用|人数|规模|排名|榜单|预测|概率|赔率|政策|法规|规则|标准|CEO|董事长|总统|总理|天气|预警|空气质量|财报|财务|融资|估值|赛程|比分|赛果|结果|对阵|日程|schedule|score|result|price|weather|ranking|odds|policy|law)/i;
const NUMERIC_DEMAND_RE = /(人数|收费|会费|费用|价格|规模|名单|排名|榜单|概率|赔率|估值|融资|会员|收入|财报|市值|多少|几家|几人|几场|多少钱|占比|份额|top\s*\d*|rank(?:ing)?|list|compare|comparison|fee|price|member|count|size|market share)/i;
const RESEARCH_SCOPE_RE = /(主要|中国|全球|国内|海外|行业|机构|协会|商会|公司|企业|平台|品牌|学校|医院|城市|地区|市场|同业|竞品|头部|leading|major|industry|market|provider|vendor|association|company|enterprise|platform|brand)/i;
const PREDICTION_RE = /(预测|概率|热门|看好|prediction|probability|forecast)/i;
const ODDS_RE = /(胜率|赔率|盘口|让球|夺冠|胜负|odds|betting|win rate)/i;
const SOURCE_REQUEST_RE = /(官方|官网|来源|出处|引用|参考|链接|原文|source|citation|reference|official|link)/i;
const EVENT_STAGE_DATE_RE = /(半决赛|准决赛|四分之一决赛|八强|决赛|总决赛|semifinal|semi-final|semi final|quarterfinal|quarter-final|final)/i;

export function isSportsScoreOrScheduleQuery(query: unknown): boolean {
  const q = String(query || "");
  return !!q && EVENT_SHAPE_RE.test(q) && EVENT_ANSWER_RE.test(q);
}

export function isFreshIntent(query: unknown): boolean {
  return FRESH_RE.test(String(query || ""));
}

export function isVolatileFactQuery(query: unknown): boolean {
  return VOLATILE_FACT_RE.test(String(query || ""));
}

export function isComparativeOrNumericResearch(query: unknown): boolean {
  const q = String(query || "");
  return NUMERIC_DEMAND_RE.test(q) && RESEARCH_SCOPE_RE.test(q);
}

export function isEventPredictionQuery(query: unknown): boolean {
  const q = String(query || "");
  return ODDS_RE.test(q) || (PREDICTION_RE.test(q) && EVENT_SHAPE_RE.test(q));
}

export function classifySearchEvidencePolicy(query: unknown): EvidencePolicy {
  const q = String(query || "");
  if (!q.trim()) return { grade: "fast", reason: "empty" };
  if (SOURCE_REQUEST_RE.test(q)) return { grade: "source", reason: "explicit-source-request" };
  if (isSportsScoreOrScheduleQuery(q) || isEventPredictionQuery(q)) {
    return { grade: "source", reason: "event-score-schedule-or-prediction" };
  }
  if (isFreshIntent(q) && isVolatileFactQuery(q)) {
    return { grade: "source", reason: "fresh-volatile-fact" };
  }
  if (isComparativeOrNumericResearch(q)) {
    return { grade: "source", reason: "comparative-or-numeric-fact" };
  }
  return { grade: "fast", reason: "low-risk-fast-summary" };
}

export function needsSourceGradeEvidence(query: unknown): boolean {
  return classifySearchEvidencePolicy(query).grade === "source";
}

export function normalizeSearchQueryIntent(query: unknown): string {
  const q = String(query || "").trim();
  if (!q) return q;
  if (!/世纪杯/.test(q)) return q;
  if (/(?:新世纪杯|21世纪杯|二十一世纪杯|世纪杯(?:英语|演讲|作文|龙舟|朗诵|竞赛|活动|赛事))/.test(q)) return q;
  if (!/(?:今晚|今夜|今天|今日|明天|昨晚|昨天|比赛|赛程|比分|赛果|小组赛|决赛|半决赛|足球|球队|对阵|夺冠|胜率|预测|world cup|fifa)/i.test(q)) return q;
  return q.replace(/世纪杯/g, "世界杯");
}

export function beijingDateStamp(now = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return [map.year, map.month, map.day].filter(Boolean).join("-");
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export function buildEvidencePolicyHint(query: unknown, now = new Date()): string {
  const policy = classifySearchEvidencePolicy(query);
  if (policy.grade !== "source") return "";
  const q = String(query || "");
  const lines = [
    "证据使用提示:",
    `- 当前北京时间日期: ${beijingDateStamp(now)}。遇到“今天/今晚/昨晚/最新/实时”必须按这个日期解释，不要沿用旧训练知识。`,
    "- 先把工具返回压缩成“已知事实 / 证据缺口 / 可回答结论”，再作答；不要在同一回答里先说未开始又引用已开赛证据。",
  ];
  if (isSportsScoreOrScheduleQuery(q) || isEventPredictionQuery(q)) {
    lines.push("- 赛事/赛程/比分/预测属于高波动问题：只列工具证据支持的时间、队伍、比分；证据冲突时明确说不确定并说明冲突。");
  } else if (isFreshIntent(q) && isVolatileFactQuery(q)) {
    lines.push("- 当前行情/天气/政策/人员等高波动事实：优先同日或最新来源；如果来源日期偏旧，必须标注数据日期。");
  } else if (isComparativeOrNumericResearch(q)) {
    lines.push("- 人数、收费、榜单、机构对比等数字研究：不要凭常识补数；没有公开数据时明确写“公开资料不足”。");
  }
  return lines.join("\n");
}

export function enrichEvidenceSearchQuery(query: unknown): string {
  const q = String(query || "").trim();
  if (!q) return q;
  const additions: string[] = [];
  if (isEventPredictionQuery(q)) {
    additions.push("odds implied probability win probability official source recent");
  } else if (isSportsScoreOrScheduleQuery(q)) {
    additions.push(EVENT_STAGE_DATE_RE.test(q)
      ? "official schedule dates semifinal final fixtures source"
      : "official schedule results fixtures score date source");
  } else if (isFreshIntent(q) && isVolatileFactQuery(q)) {
    additions.push("latest official source timestamp");
  } else if (isComparativeOrNumericResearch(q)) {
    additions.push("official source statistics fee membership date");
  }
  return [q, ...additions].join(" ").replace(/\s+/g, " ").trim().slice(0, 220);
}

export function formatDateTimeForZone(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

export function formatDateOnlyForZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

export function currentTemporalContext(now = new Date()): string {
  const addDays = (date: Date, days: number) => new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
  const shanghaiToday = formatDateOnlyForZone(now, "Asia/Shanghai");
  const shanghaiYesterday = formatDateOnlyForZone(addDays(now, -1), "Asia/Shanghai");
  const shanghaiTomorrow = formatDateOnlyForZone(addDays(now, 1), "Asia/Shanghai");
  return [
    `当前日期锚点(Asia/Shanghai): 今天=${shanghaiToday}, 昨天=${shanghaiYesterday}, 明天=${shanghaiTomorrow}`,
    `当前时间(Asia/Shanghai): ${formatDateTimeForZone(now, "Asia/Shanghai")}`,
    `当前时间(UTC): ${now.toISOString()}`,
  ].join("；");
}

function dateSerial(year: number, month: number, day: number): number {
  return Number(`${year}${String(month).padStart(2, "0")}${String(day).padStart(2, "0")}`);
}

function currentDateSerialForZone(now = new Date(), timeZone = "Asia/Shanghai"): number {
  const [year, month, day] = formatDateOnlyForZone(now, timeZone).split("-").map(Number);
  return dateSerial(year, month, day);
}

function extractExplicitDateSerials(text: string, now = new Date()): number[] {
  const normalized = String(text || "");
  const currentYear = Number(formatDateOnlyForZone(now, "Asia/Shanghai").slice(0, 4));
  const out: number[] = [];
  for (const match of normalized.matchAll(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/gu)) {
    out.push(dateSerial(Number(match[1]), Number(match[2]), Number(match[3])));
  }
  for (const match of normalized.matchAll(/(\d{4})-(\d{1,2})-(\d{1,2})/gu)) {
    out.push(dateSerial(Number(match[1]), Number(match[2]), Number(match[3])));
  }
  for (const match of normalized.matchAll(/(?<!\d)(\d{1,2})月\s*(\d{1,2})日/gu)) {
    out.push(dateSerial(currentYear, Number(match[1]), Number(match[2])));
  }
  return out;
}

function hasNoCurrentResultClaim(normalized: string): boolean {
  return /(?:没有|暂无|还没有|尚无|未有|并没有).{0,28}(?:正式比赛|正赛|比分|赛果|结果|赛事比分|数据|记录|信息)/u.test(normalized)
    || /(?:正式比赛|正赛|比分|赛果|结果|赛事比分|数据|记录|信息).{0,28}(?:没有|暂无|还没有|尚无|未有|并没有)/u.test(normalized)
    || /(?:尚未|未|还没|还未).{0,20}(?:开赛|开始|开幕|开打|举行|产生|公布)/u.test(normalized);
}

function hasPastDateFutureStartClaim(normalized: string): boolean {
  return /要到\d{4}年\d{1,2}月\d{1,2}日(?:[~～—–-]\d{1,2}月?\d{0,2}日?)?(?:才)?(?:正式)?(?:开赛|开始|开幕|开打|举行)/u.test(normalized)
    || /要到\d{1,2}月\d{1,2}日(?:[~～—–-]\d{1,2}月?\d{0,2}日?)?(?:才)?(?:正式)?(?:开赛|开始|开幕|开打|举行)/u.test(normalized);
}

export function containsTemporalNoResultContradiction(text: unknown, now = new Date()): boolean {
  const normalized = String(text || "").replace(/\s+/g, "");
  if (!normalized) return false;
  const dates = extractExplicitDateSerials(normalized, now);
  if (!dates.some((date) => date <= currentDateSerialForZone(now))) return false;
  return hasNoCurrentResultClaim(normalized) || hasPastDateFutureStartClaim(normalized);
}
