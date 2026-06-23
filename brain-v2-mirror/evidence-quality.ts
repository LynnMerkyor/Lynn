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
const PRODUCT_RELEASE_RE = /(最新版|新版本|版本|发布|发售|开售|上市|开卖|出了吗|出了没|可以买|可购买|能买|购买|在售|售卖|release\s*notes?|released?|available|shipping|launch(?:ed)?|version|update|changelog|firmware|driver|sdk|software|buy\s*now|for\s*sale|purchase|marketplace)/i;
const PRODUCT_OR_TECH_RE = /(DGX|RTX|CUDA|GPU|NVIDIA|英伟达|OpenAI|ChatGPT|Claude|Gemini|Kimi|Qwen|GLM|StepFun|iPhone|Mac|Windows|Android|Python|Node\.?js|Chrome|Safari|SDK|API|model|模型|产品|软件|固件|驱动|系统|芯片|显卡|服务器|工作站)/i;
const DGX_SPARK_RE = /(?:^|\b)DGX\s*Spark\b|英伟达.*DGX\s*Spark|NVIDIA.*DGX\s*Spark/i;

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

export function isProductReleaseOrVersionQuery(query: unknown): boolean {
  const q = String(query || "");
  if (DGX_SPARK_RE.test(q)) return true;
  return PRODUCT_RELEASE_RE.test(q) && (PRODUCT_OR_TECH_RE.test(q) || /[A-Za-z][A-Za-z0-9+.-]{1,}/.test(q));
}

export function classifySearchEvidencePolicy(query: unknown): EvidencePolicy {
  const q = String(query || "");
  if (!q.trim()) return { grade: "fast", reason: "empty" };
  if (SOURCE_REQUEST_RE.test(q)) return { grade: "source", reason: "explicit-source-request" };
  if (isProductReleaseOrVersionQuery(q)) return { grade: "source", reason: "product-release-or-version" };
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
  if (isFreshIntent(q)) {
    lines.push("- 对“今天/当前/最新/实时”问题，如果证据只包含早于当前日期的来源，不要展开旧日期明细或把旧来源当今天结论；只说明“未查到同日/当前有效证据”，必要时用一句话标注旧来源不足。");
  }
  if (isSportsScoreOrScheduleQuery(q) || isEventPredictionQuery(q)) {
    lines.push("- 赛事/赛程/比分/预测属于高波动问题：只列工具证据支持的时间、队伍、比分；证据冲突时明确说不确定并说明冲突。");
  } else if (isProductReleaseOrVersionQuery(q)) {
    lines.push("- 产品发布/版本/上市状态属于高波动问题：优先官方 release notes、产品页、文档或商城；搜索结果只提到上位品牌但没命中具体产品名时，不得当作有效证据。");
    lines.push("- 最终回答必须显式列出可用的官方 URL（不要只写“官方文档/官方产品页”）；如果只有第三方/代理商/新闻稿线索，必须标为未核实线索。");
    if (DGX_SPARK_RE.test(q)) {
      lines.push("- DGX Spark 题必须优先引用 NVIDIA 官方来源：docs.nvidia.com、marketplace.nvidia.com 或 nvidia.com；不要用丽台/代理商/泛硬件站替代官方依据。");
    }
  } else if (isFreshIntent(q) && isVolatileFactQuery(q)) {
    lines.push("- 当前行情/天气/政策/人员等高波动事实：优先同日或最新来源；偏旧来源只能作为“证据不足”的说明，不要展开成主要答案。");
    if (/(?:A\s*股|a\s*股|A股|a股|沪深|上证|深证|创业板|股市|行情|异动)/i.test(q)) {
      lines.push("- 询问“今天/当前”的股市异动时，如果证据只包含旧交易日数据，不要展开旧日期明细；最多一句说明“旧数据不能回答今天问题”，并明确等待开盘或补充同日来源。");
    }
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
  } else if (isProductReleaseOrVersionQuery(q)) {
    additions.push("official release notes product page documentation version availability source");
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

function hasCurrentOrPastRelativeContext(normalized: string): boolean {
  return /(今天|今日|今晚|今早|今晨|目前|现在|当前|刚刚|刚才|昨晚|昨天|昨日|截至|截止|today|tonight|currently|current|latest|yesterday)/iu.test(normalized);
}

export function containsTemporalNoResultContradiction(text: unknown, now = new Date()): boolean {
  const normalized = String(text || "").replace(/\s+/g, "");
  if (!normalized) return false;
  const dates = extractExplicitDateSerials(normalized, now);
  if (!dates.some((date) => date <= currentDateSerialForZone(now)) && !hasCurrentOrPastRelativeContext(normalized)) return false;
  return hasNoCurrentResultClaim(normalized) || hasPastDateFutureStartClaim(normalized);
}

export function containsGroundedToolDenialContradiction(text: unknown): boolean {
  const normalized = String(text || "").replace(/\s+/g, "");
  if (!normalized) return false;
  return /(?:工具集|工具箱|工具列表|当前工具|可用工具|CLI工具|LynnCLI工具).{0,24}(?:没有|未包含|不包含|缺少|暂无|不支持).{0,24}(?:天气|搜索|查询|检索|行情|股价|金价|汇率|比分|赛程|网页|访问)/iu.test(normalized)
    || /(?:没有|未包含|不包含|缺少|暂无|不支持).{0,24}(?:天气|搜索|查询|检索|行情|股价|金价|汇率|比分|赛程|网页|访问).{0,24}(?:工具|功能|能力|接口)/iu.test(normalized)
    || /(?:无法|不能|没法|不支持).{0,24}(?:实时|在线|联网|访问网页|查询天气|查询股价|查询汇率|查询比分|查询赛程)/iu.test(normalized);
}
