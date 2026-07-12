const EXPLICIT_LOOKUP_PROMPT_RE = /(?:查一下|查询|查证|搜索(?:一下|最新|官方|网页|结果)?|检索(?:一下|最新|官方|网页)?|访问|打开|看看|找一下|上网|联网|官网|官方文档|最新|实时|今天|今日|明天|天气|预警|航班|股价|金价|汇率|行情|比分|赛程|价格|发布了吗|有更新|Release\s+页面|release\s+tag)/iu;
const HIGH_RISK_CURRENT_CATEGORY_RE = /(?:_current$|^(?:realtime|search|mixed|product|official)$)/u;
const STABLE_SCENARIO_CATEGORY_RE = /^(?:simple|format|code|writing|life|medical|travel|education|recruiting|office|industry|research|ux)$/u;

function normalizedText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

/**
 * A tool-evidence claim must assert a concrete returned or real-time fact.
 * Generic educational wording such as "retrieved reference material" is not
 * evidence of a live tool call and must not make a stable answer fail a gate.
 */
export function claimsFreshToolEvidence(text) {
  return /(?:根据(?:最新|本次|本轮)?(?:查询|搜索|工具|检索)(?:结果|返回)|(?:查询|搜索|工具|检索)(?:结果|返回)(?:显示|表明|指出|为)|(?:最新|实时)(?:天气|行情|比分|赛程|价格|新闻|汇率|金价)|(?:查询|搜索)(?:到|得)(?:的)?(?:最新|实时)?(?:天气|行情|比分|赛程|价格|新闻|汇率|金价))/u.test(String(text || ""));
}

export function requiresFreshEvidenceForDialogue({ category, prompt }) {
  const c = String(category || "");
  if (HIGH_RISK_CURRENT_CATEGORY_RE.test(c)) return true;
  if (STABLE_SCENARIO_CATEGORY_RE.test(c) && !/(?:上网|联网|查一下|查询|查证|访问|打开官网|最新(?:版|发布|模型|政策|规则|材料|口径)|实时(?:数据|信息|行情|天气|比分|赛程)|今天(?:天气|新闻|行情|价格)|明天(?:天气|航班|降雨)|官方(?:来源|文档|页面)|release\s+tag)/iu.test(String(prompt || ""))) {
    return false;
  }
  return EXPLICIT_LOOKUP_PROMPT_RE.test(String(prompt || ""))
    && !/(?:不要|不用|不必|无需).{0,10}(?:联网|搜索|查询|工具)/u.test(String(prompt || ""));
}

function hasHonestNoEvidenceAnswer(text) {
  return /(没有查到|未查到|无法确认|不能确认|证据不足|来源不足|需要补充来源|无法从当前证据确认)/u.test(text);
}

function isCodeGenerationPrompt(prompt, category) {
  if (String(category || "") !== "code") return false;
  return /(?:写|实现|生成|给(?:我)?(?:一个|一段)?|构造|提供).{0,50}(?:函数|脚本|命令|schema|布局|伪代码|handler|union|debounce|JSON|TypeScript|JavaScript|Node\.?js|Python|bash|CSS|zod|Electron|React)/iu.test(prompt);
}

function hasCodeLikeAnswer(text) {
  const raw = String(text || "");
  return /```[\s\S]{12,}?```/.test(raw)
    || /\b(?:function|const|let|var|def|class|import|export|interface|type|SELECT|CREATE\s+TABLE|z\.object|async\s+function|useMemo)\b/.test(raw)
    || /\b(?:find|rg|wc|grep|node|python|npm|pnpm|git)\b.{0,80}(?:\*\.ts|\.ts|\.json|行数|keys?)/iu.test(raw)
    || /display:\s*grid|grid-template-columns|ipcMain\.handle|JSON\s*Schema/iu.test(raw);
}

function isNarrativeWritingPrompt(prompt, category) {
  if (String(category || "") !== "writing") return false;
  return /(?:写一段|续写|开头|对话|改写得更有画面感|悬疑小说)/u.test(prompt)
    && !/(?:大纲|章节规划|检查清单|世界观设定表)/u.test(prompt);
}

function isCharacterProfilePrompt(prompt, category) {
  if (String(category || "") !== "writing") return false;
  return /(?:人物小传|人物设定|角色小传|角色设定)/u.test(String(prompt || ""));
}

function isWritingPlanningPrompt(prompt, category) {
  if (String(category || "") !== "writing") return false;
  return /(?:大纲|章节规划|检查清单|世界观设定表|避免 AI 味)/u.test(prompt);
}

function hasNarrativeProse(text) {
  const raw = normalizedText(text);
  const sentenceMarks = (raw.match(/[。！？]/gu) || []).length;
  return raw.length >= 80 && sentenceMarks >= 3 && !/^(?:[-*]\s*){0,1}(?:可以|我可以|下面是|以下是)/u.test(raw.slice(0, 40));
}

function hasCharacterProfile(text) {
  const raw = normalizedText(text);
  if (raw.length < 120) return false;
  return /(?:工程师|职业|经历|过去|事故|记忆|缺口|权威|目标|弱点|性格|创伤|秘密|动机|不信任)/u.test(raw)
    && /(?:。|：|:|；|;|-|\n)/u.test(String(text || ""));
}

function hasWritingPlan(text) {
  const raw = normalizedText(text);
  return raw.length >= 160
    && /(?:角色|冲突|主题|章节|第一|第二|第三|世界观|设定|场景|节奏|检查)/u.test(raw);
}

function hasActionableAnswerForScenario(text) {
  const raw = normalizedText(text);
  if (raw.length < 80) return false;
  return /(?:步骤|清单|建议|先|然后|最后|模板|表|计划|准备|记录|风险|负责人|时间线|阶段|行动项|指标|证据|问题|确认|核对|检查|条件|取决于|流程|第[一二三四五六七八九十\d]+步|可尝试|处理|做法|切|炒|煎|煮|搭配|验证|避坑|留存|渠道|维度|原则|要点|比如|例子|就医|急诊|危险信号|观察|评分|rubric)/u.test(raw);
}

function isEducationExplanationPrompt(prompt, category) {
  return String(category || "") === "education" && /(?:解释|给.+解释|用.+例子)/u.test(String(prompt || ""));
}

function hasEducationalExplanationAnswer(text) {
  const raw = normalizedText(text);
  if (raw.length < 100) return false;
  return /(?:例子|比如|想象|本质|意思|理解|生活|公式|可以把|你可以)/u.test(raw);
}

function hasEvidenceBoundaryAnswer(text) {
  const raw = normalizedText(text);
  if (raw.length < 120) return false;
  return /(?:来源|官方|公告|官网|文件|公开信息|截至|当前|检索)/u.test(raw)
    && /(?:不确定|暂未|未检索到|未发布|无法确认|不能确认|口径|核验|以.+为准|结论)/u.test(raw);
}

function isScenarioCategory(category) {
  return /^(?:life|medical|gov_legal|education|travel|recruiting|office|industry)(?:_current)?$/u.test(String(category || ""));
}

function hasStaleCrossDomainLeak(prompt, text) {
  const p = String(prompt || "");
  const raw = String(text || "");
  if (!/(?:世界杯|NBA|金价|股价|天气|汇率|纳斯达克|指数|A\s*股|英伟达|苹果|比特币|BTC|TSLA|特斯拉|日元)/iu.test(p) && /(?:世界杯|NBA\s*总决赛|金价|现货黄金|纳斯达克|英伟达股价)/iu.test(raw)) {
    return true;
  }
  if (!/(?:ComfyUI|custom_nodes|python\s+main\.py)/iu.test(p) && /(?:ComfyUI|custom_nodes\/foo\.py|python\s+main\.py)/iu.test(raw)) {
    return true;
  }
  if (!/(?:Apple|notarization|公证|苹果)/iu.test(p) && /(?:Apple\s+notarization|notarizing_macos_software|Gatekeeper|苹果.{0,12}公证)/iu.test(raw)) {
    return true;
  }
  if (!/(?:Claude|Anthropic)/iu.test(p) && /(?:Claude\s+(?:4(?:\.\d+)?|模型)|Anthropic\s+官方)/iu.test(raw)) {
    return true;
  }
  if (!/(?:Microsoft|Windows\s+on\s+Arm)/iu.test(p) && /(?:Microsoft\s+Windows\s+on\s+Arm|developer\.microsoft\.com\/windows\/arm)/iu.test(raw)) {
    return true;
  }
  return false;
}

export function additionalDialogueQualityReason({ category, prompt, text, hasToolEvidence }) {
  const rawText = String(text || "");
  if (hasStaleCrossDomainLeak(prompt, rawText)) {
    return "answer-leaked-unrelated-domain-context";
  }
  if (requiresFreshEvidenceForDialogue({ category, prompt }) && !hasToolEvidence && !hasHonestNoEvidenceAnswer(rawText)) {
    return "fresh-evidence-question-without-tool-event";
  }
  if (isCodeGenerationPrompt(String(prompt || ""), category) && !hasCodeLikeAnswer(rawText)) {
    return "code-generation-question-without-code";
  }
  if (isCharacterProfilePrompt(String(prompt || ""), category) && !hasCharacterProfile(rawText)) {
    return "creative-character-profile-too-thin";
  }
  if (isNarrativeWritingPrompt(String(prompt || ""), category) && !hasNarrativeProse(rawText)) {
    return "creative-writing-question-without-narrative-prose";
  }
  if (isWritingPlanningPrompt(String(prompt || ""), category) && !hasWritingPlan(rawText)) {
    return "creative-writing-plan-too-thin";
  }
  if (isEducationExplanationPrompt(String(prompt || ""), category) && hasEducationalExplanationAnswer(rawText)) {
    return "";
  }
  if (isScenarioCategory(category) && !hasActionableAnswerForScenario(rawText) && !hasEvidenceBoundaryAnswer(rawText)) {
    return "daily-or-industry-scenario-answer-not-actionable";
  }
  return "";
}
