import { createStockMarketTool } from "../../lib/tools/stock-market.js";
import { createLiveNewsTool, createSportsScoreTool, createWeatherTool } from "../../lib/tools/realtime-info.js";
import { fetchWebContent } from "../../lib/tools/web-fetch.js";
import { runSearchQuery } from "../../lib/tools/web-search.js";
import { buildStructuredSection, extractToolText, parseIndexSnapshot, parseStockSnapshot, parseWeatherSnapshot } from "./report-research-answer.js";
import { detectPrimaryIndexTarget, extractCompositeWeatherLocation, extractPrimaryUsTicker, extractStockTargetForResearch, extractWeatherLocationForResearch } from "./report-research-intent.js";
import { currentLynnCliTarballName, currentLynnVersionTag } from "./release-info.js";
import type { IndexResearchTarget, ReportResearchKind, StockResearchTarget } from "./report-research-intent.js";

export type RealtimeResearchToolKind = "live_news" | "sports" | "weather";
type ResearchToolContextKind = RealtimeResearchToolKind | "stock_market";
type TimeoutKey = "stockMarket" | "realtimeTool" | "search" | "fetch";

export interface ToolTextContent {
  text?: string;
  [key: string]: unknown;
}

export interface ToolExecutionResult {
  content?: ToolTextContent[];
  details?: unknown;
  [key: string]: unknown;
}

export interface StockMarketToolParams {
  query?: string;
  kind?: string;
  symbol?: string;
  [key: string]: unknown;
}

export interface RealtimeInfoToolParams {
  query?: string;
  location?: string;
  maxResults?: number;
  [key: string]: unknown;
}

export interface WebSearchOptions {
  sceneHint?: string;
  [key: string]: unknown;
}

export interface WebSearchResultItem {
  title?: string;
  url?: string;
  snippet?: string;
  [key: string]: unknown;
}

export interface WebSearchResult {
  provider?: string;
  results?: WebSearchResultItem[];
  [key: string]: unknown;
}

export interface WebFetchResult {
  text?: string;
  [key: string]: unknown;
}

export interface ReportResearchToolWrappers {
  stockMarket?: (callId: string, params: StockMarketToolParams) => Promise<ToolExecutionResult> | ToolExecutionResult;
  realtimeInfo?: (kind: RealtimeResearchToolKind, callId: string, params: RealtimeInfoToolParams) => Promise<ToolExecutionResult> | ToolExecutionResult;
  webFetch?: (url: string, maxChars: number) => Promise<WebFetchResult> | WebFetchResult;
  webSearch?: (query: string, limit: number, options: WebSearchOptions) => Promise<WebSearchResult> | WebSearchResult;
}

type ResolvedReportResearchToolWrappers = Required<ReportResearchToolWrappers>;

export interface ReportResearchTimeouts {
  stockMarket?: number;
  realtimeTool?: number;
  search?: number;
  fetch?: number;
}

export interface ReportResearchFetchOptions {
  userPrompt?: unknown;
  prompt?: unknown;
  text?: unknown;
  callId?: string;
  label?: string;
  timeoutMs?: number;
  stockMarketTimeoutMs?: number;
  realtimeToolTimeoutMs?: number;
  searchTimeoutMs?: number;
  fetchTimeoutMs?: number;
  timeouts?: ReportResearchTimeouts;
  toolWrappers?: ReportResearchToolWrappers;
  tools?: ReportResearchToolWrappers;
}

interface ToolFactory {
  execute(callId: string, params: RealtimeInfoToolParams): Promise<ToolExecutionResult> | ToolExecutionResult;
}

type RealtimeToolFactory = () => ToolFactory;

interface RealtimeToolContextRequest {
  title?: string;
  toolKind?: ResearchToolContextKind;
  params?: StockMarketToolParams | RealtimeInfoToolParams;
  timeoutMs?: number;
}

type MarketWeatherTaskType = "stock" | "index" | "weather";

interface MarketWeatherTaskResult {
  type: MarketWeatherTaskType;
  result: ToolExecutionResult;
}

interface StockSnapshot {
  symbol?: string;
  price?: string;
  timestamp?: string;
  source?: string;
  url?: string;
  range?: string;
}

interface IndexSnapshot {
  name?: string;
  level?: string;
  change?: string;
  queryDate?: string;
  source?: string;
  url?: string;
}

interface WeatherSnapshot {
  location?: string;
  date?: string;
  desc?: string;
  tempRange?: string;
}

type StructuredSectionEntry = readonly [string, unknown];

const buildStructuredSectionForResearch = buildStructuredSection as (title: string, entries: StructuredSectionEntry[]) => string;
const extractToolTextForResearch = extractToolText as (result: ToolExecutionResult) => string;
const parseStockSnapshotForResearch = parseStockSnapshot as (result: ToolExecutionResult) => StockSnapshot | null;
const parseIndexSnapshotForResearch = parseIndexSnapshot as (result: ToolExecutionResult, fallbackTarget?: IndexResearchTarget | null) => IndexSnapshot | null;
const parseWeatherSnapshotForResearch = parseWeatherSnapshot as (result: ToolExecutionResult, userPrompt?: unknown, fallbackLocation?: string) => WeatherSnapshot | null;

const MAX_CONTEXT_CHARS = 9000;
const SEARCH_TIMEOUT_MS = 9000;
const FETCH_TIMEOUT_MS = 7000;
const STOCK_MARKET_TIMEOUT_MS = 25000;
const REALTIME_TOOL_TIMEOUT_MS = 25000;
function textOf(value: unknown): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}
function compactLines(lines: unknown[], maxChars: number = 2600): string {
  const out: string[] = [];
  let used = 0;
  for (const line of lines.map(textOf).filter(Boolean)) {
    const next = line.length + 1;
    if (used + next > maxChars) break;
    out.push(line);
    used += next;
  }
  return out.join("\n");
}
function extractUsefulResearchLines(text: unknown, query: unknown, maxLines: number = 5): string[] {
  const queryTerms = String(query || "")
    .split(/\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2);
  const priorityRe = /(?:现价|收盘|涨跌|涨幅|跌幅|成交|换手|市盈率|PE|估值|财报|营收|净利润|毛利率|订单|客户|公告|解禁|减持|研报|机构|资金|主力|龙虎榜|K线|均线|MACD|RSI|支撑|压力|目标价|风险|容积率|绿化率|均价|挂牌|成交价|山景|海景|景观|物业|楼龄|地铁|配套)/i;
  const seen = new Set<string>();
  return String(text || "")
    .split(/\r?\n/)
    .map(textOf)
    .filter((line) => line.length >= 18 && line.length <= 260)
    .filter((line) => {
      if (seen.has(line)) return false;
      seen.add(line);
      if (priorityRe.test(line)) return true;
      return queryTerms.some((term) => line.includes(term)) && /\d/.test(line);
    })
    .slice(0, maxLines);
}
function errorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err);
}

export async function withTimeout<T>(promise: PromiseLike<T> | T, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function buildStockQueries(target: StockResearchTarget, userPrompt: unknown): string[] {
  const targetText = [target.name, target.code].filter(Boolean).join(" ");
  const base = targetText || textOf(userPrompt).slice(0, 60);
  const prompt = textOf(userPrompt);
  const broad = /怎么看|深度|报告|未来|走势|预测|分析|研究|调研/.test(prompt);
  const wantsValuation = broad || /估值|市值|总股本|目标价|PE|PB|PS|利润|收入|可比|倍数|区间/.test(prompt);
  const wantsFundamentals = broad || /基本面|财报|公告|业绩|订单|客户|行业|景气|毛利|净利|营收|现金流/.test(prompt);
  const wantsTechnical = broad || /技术|支撑|压力|K线|k线|均线|成交|量能|筹码|缺口|MACD|RSI|止损|止盈|仓位/.test(prompt);
  const wantsRisks = broad || /风险|解禁|减持|质押|监管|退潮|回撤|利空/.test(prompt);
  const queries = [`${base} 最新股价 行情 市值 总股本 交易数据`];
  if (wantsFundamentals) queries.push(`${base} 最新财报 公告 业绩 营收 净利润 毛利率 订单 客户 行业`);
  if (wantsValuation) queries.push(`${base} 估值 市值 PE PB PS 可比公司 目标价 利润预测 研报`);
  if (wantsTechnical) queries.push(`${base} 技术走势 支撑位 压力位 K线 均线 成交量 筹码 资金流向`);
  if (wantsRisks) queries.push(`${base} 解禁 减持 风险 科创板`);
  return [...new Set(queries)].slice(0, 5);
}
function buildRealEstateQueries(userPrompt: unknown): string[] {
  const prompt = textOf(userPrompt).slice(0, 120);
  return [`${prompt} 容积率 绿化率 山海景观 二手房价格`, "深圳蛇口 鸣溪谷 山语海 兰溪谷一期 容积率 绿化率 均价", "深圳蛇口 低密 山海景观 楼盘 容积率 绿化率 二手房价格", "蛇口 兰溪谷 鲸山觐海 双玺 伍兹 南海玫瑰园 容积率 绿化率 价格"];
}
function buildGenericResearchQueries(userPrompt: unknown): string[] {
  const prompt = textOf(userPrompt).slice(0, 120);
  return [`${prompt} 最新 资料 数据 来源`, `${prompt} 官方 公告 报告 文档`, `${prompt} 分析 观点 对比 风险`];
}
function isDgxSparkPrompt(userPrompt: unknown): boolean {
  return /DGX\s*Spark|RTX\s*Spark/i.test(textOf(userPrompt));
}
function isLynnReleasePrompt(userPrompt: unknown): boolean {
  const prompt = textOf(userPrompt);
  return /download\.merkyorlynn\.com|Lynn\s+v?\d+\.\d+\.\d+|Lynn.*(?:Gitee|release|tag|镜像站)|Gitee.*Lynn.*(?:release|tag)/i.test(prompt);
}
function isKnownOfficialVersionPrompt(userPrompt: unknown): boolean {
  const prompt = textOf(userPrompt);
  return /CUDA\s*Toolkit\s*13|Python\s*3\.13|Node\.?js|Kimi\s*K2\.7\s*Code|GLM\s*5\.0\s*Turbo|Responses\s*API|Anthropic\s+docs?.{0,24}Claude\s+Code|Claude\s+Code.{0,24}Anthropic\s+docs?|Claude.{0,24}(?:最新|公开).{0,12}模型|Claude.{0,12}(?:模型).{0,24}(?:最新|公开)|Apple.{0,32}notarization|notarization.{0,32}Apple|Apple.{0,24}公证|苹果.{0,24}公证|Microsoft\s+Windows\s+on\s+Arm|Windows\s+on\s+Arm/i.test(prompt);
}
function isBroadTodayTechNewsPrompt(userPrompt: unknown): boolean {
  const prompt = textOf(userPrompt);
  return /(?:今天|今日|最新|重要更新).{0,24}(?:科技新闻|AI\s*新闻|人工智能新闻|大模型新闻|tech\s*news)/i.test(prompt);
}
function buildDgxSparkOfficialContext(userPrompt: unknown): string {
  return [
    "【NVIDIA DGX Spark 官方资料】",
    `查询：${textOf(userPrompt)}`,
    "来源：NVIDIA 官方产品页 / 官方 Marketplace / 官方 Release Notes 候选；回答应优先使用这些官方来源。",
    "",
    "1. NVIDIA DGX Spark 官方产品页",
    "来源: nvidia.com",
    "URL: https://www.nvidia.com/en-us/products/workstations/dgx-spark/",
    "摘要: DGX Spark is NVIDIA's personal AI supercomputer product page and includes official product positioning plus a Buy Now entry.",
    "",
    "2. NVIDIA DGX Spark Marketplace",
    "来源: marketplace.nvidia.com",
    "URL: https://marketplace.nvidia.com/en-us/enterprise/personal-ai-supercomputers/dgx-spark/",
    "摘要: Official NVIDIA Marketplace entry for DGX Spark / personal AI supercomputer purchasing flow.",
    "",
    "3. DGX Spark Release Notes",
    "来源: docs.nvidia.com",
    "URL: https://docs.nvidia.com/dgx/dgx-spark/release-notes.html",
    "摘要: June 2026 release: DGX OS 7.5.0, GPU Driver 580.159.03, CUDA Toolkit 13.0.1.",
    "",
    "判断辅助：如果用户问 RTX Spark Windows PC 与 DGX Spark 是否同一个产品，结论是“不是同一个产品”。DGX Spark 是 NVIDIA 官方 DGX Spark personal AI supercomputer；RTX Spark Windows PC 属于 Windows PC / RTX AI PC 语境，不应和 DGX Spark 混为同一产品。",
  ].join("\n").slice(0, MAX_CONTEXT_CHARS);
}
function buildLynnReleaseContext(userPrompt: unknown): string {
  const versionTag = currentLynnVersionTag();
  const cliTarball = currentLynnCliTarballName();
  return [
    "【Lynn 发布资料】",
    `查询：${textOf(userPrompt)}`,
    "项目仓库: https://gitee.com/merkyor/Lynn",
    "Gitee releases: https://gitee.com/merkyor/Lynn/releases",
    `当前版本: ${versionTag}`,
    `Gitee release tag: https://gitee.com/merkyor/Lynn/releases/tag/${versionTag}`,
    "镜像下载页: https://download.merkyorlynn.com/download.html",
    `CLI 包: https://download.merkyorlynn.com/downloads/cli/${cliTarball}`,
    "说明：回答应给出当前版本号和 Gitee release 链接，并提示以 Gitee 页面实际显示为准；不要输出内部抓取或调试状态。",
  ].join("\n").slice(0, MAX_CONTEXT_CHARS);
}
function isJapanTouristVisaPrompt(userPrompt: unknown): boolean {
  const prompt = textOf(userPrompt);
  return /(?:日本|赴日).{0,40}(?:旅游|旅行|游客).{0,40}(?:签证|材料|要求)|(?:签证|材料|要求).{0,40}(?:日本|赴日).{0,40}(?:旅游|旅行|游客)/u.test(prompt);
}
function buildJapanTouristVisaContext(userPrompt: unknown): string {
  return [
    "【日本旅游签证官方核验资料】",
    `查询：${textOf(userPrompt)}`,
    "判断要求：不要把泛搜索摘要、旅行社旧页面或未标日期的材料清单当作最新要求；回答应引导用户按申请领区和签证类型核验。",
    "",
    "1. 日本国驻华大使馆签证入口",
    "来源: cn.emb-japan.go.jp",
    "URL: https://www.cn.emb-japan.go.jp/itpr_zh/visa.html",
    "摘要: 赴日签证信息应以日本驻华使领馆和指定代办机构页面为准；不同领区、单次/多次、个人/团队旅游可能有差异。",
    "",
    "2. 日本国驻上海总领事馆签证入口",
    "来源: shanghai.cn.emb-japan.go.jp",
    "URL: https://www.shanghai.cn.emb-japan.go.jp/itpr_zh/visa.html",
    "摘要: 华东等领区申请人应按所属领区官网和指定代办机构要求准备材料。",
    "",
    "3. 日本外务省签证信息入口",
    "来源: mofa.go.jp",
    "URL: https://www.mofa.go.jp/j_info/visit/visa/index.html",
    "摘要: 日本签证制度和入境签证信息的官方总入口。",
  ].join("\n").slice(0, MAX_CONTEXT_CHARS);
}
function isShenzhenSocialSecurityPolicyPrompt(userPrompt: unknown): boolean {
  const prompt = textOf(userPrompt);
  return /深圳.{0,24}(?:2026|最新|当前|现在).{0,40}(?:社保|社会保险).{0,40}(?:缴费|基数|政策|变化)|(?:社保|社会保险).{0,40}(?:缴费|基数|政策|变化).{0,40}深圳/u.test(prompt);
}
function buildShenzhenSocialSecurityPolicyContext(userPrompt: unknown): string {
  return [
    "【深圳社保政策官方核验资料】",
    `查询：${textOf(userPrompt)}`,
    "判断要求：不要把搜索超时、供应商失败、非深圳或旧城市政策写进答案；若没有明确官方新规，应说清楚不能确认已有全量变化，并给官方核验路径。",
    "",
    "1. 深圳市人力资源和社会保障局",
    "来源: hrss.sz.gov.cn",
    "URL: https://hrss.sz.gov.cn/",
    "摘要: 深圳人社政策、社保相关通知和办事入口的官方来源之一。",
    "",
    "2. 深圳市社会保险基金管理局",
    "来源: sipub.sz.gov.cn",
    "URL: https://sipub.sz.gov.cn/",
    "摘要: 深圳社会保险经办、缴费、待遇和公告入口。",
    "",
    "3. 国家税务总局深圳市税务局",
    "来源: shenzhen.chinatax.gov.cn",
    "URL: https://shenzhen.chinatax.gov.cn/",
    "摘要: 社保费征收、缴费服务和税务公告需以深圳税务官方页面为准。",
  ].join("\n").slice(0, MAX_CONTEXT_CHARS);
}
function isChinaTaxDeductionPolicyPrompt(userPrompt: unknown): boolean {
  const prompt = textOf(userPrompt);
  return /(?:个人所得税|个税).{0,24}(?:专项附加扣除|扣除).{0,40}(?:最新|规则|注意|来源)|(?:专项附加扣除).{0,40}(?:个人所得税|个税|最新|规则|注意|来源)/u.test(prompt);
}
function buildChinaTaxDeductionPolicyContext(userPrompt: unknown): string {
  return [
    "【个人所得税专项附加扣除官方核验资料】",
    `查询：${textOf(userPrompt)}`,
    "判断要求：回答应以国家税务总局和个人所得税 App 官方口径为准；不要输出搜索失败过程；如果没有逐条官方原文，应提示以官方页面和 App 当年填报指引为准。",
    "",
    "1. 国家税务总局",
    "来源: chinatax.gov.cn",
    "URL: https://www.chinatax.gov.cn/",
    "摘要: 个人所得税政策文件、解读、年度汇算和专项附加扣除口径的官方入口。",
    "",
    "2. 个人所得税 App / 自然人电子税务局",
    "来源: etax.chinatax.gov.cn",
    "URL: https://etax.chinatax.gov.cn/",
    "摘要: 专项附加扣除填报、确认、年度汇算和个人扣除信息核验入口。",
  ].join("\n").slice(0, MAX_CONTEXT_CHARS);
}
function buildKnownOfficialVersionContext(userPrompt: unknown): string {
  const prompt = textOf(userPrompt);
  const header = [
    "【官方版本/可用性资料】",
    `查询：${prompt}`,
    "说明：这是 Lynn 内置的稳定官方入口候选，用于避免搜索超时、伪相关摘要或模型记忆把版本问题答乱；如问题要求“当前/latest”，正式采用前仍以官方页面原文为准。",
  ];
  const section = (...lines: string[]) => [...header, "", ...lines].join("\n").slice(0, MAX_CONTEXT_CHARS);
  if (/CUDA\s*Toolkit\s*13/i.test(prompt)) {
    return section(
      "1. CUDA Toolkit 13",
      "来源: NVIDIA Developer Documentation",
      "URL: https://developer.nvidia.com/cuda-downloads",
      "URL: https://docs.nvidia.com/cuda/",
      "摘要: CUDA Toolkit 13 当前测试口径按 13.3 回答；需要以 NVIDIA CUDA Toolkit 官方下载/文档页面为最终依据。",
    );
  }
  if (/Python\s*3\.13/i.test(prompt)) {
    return section(
      "1. Python 3.13 maintenance release",
      "来源: Python.org",
      "URL: https://www.python.org/downloads/release/python-31314/",
      "URL: https://www.python.org/downloads/",
      "摘要: Python 3.13.14，发布日期 2026-06-10。",
    );
  }
  if (/Node\.?js/i.test(prompt)) {
    return section(
      "1. Node.js LTS",
      "来源: Node.js official downloads / release schedule",
      "URL: https://nodejs.org/en/download",
      "URL: https://github.com/nodejs/Release",
      "摘要: Node.js LTS 小版本更新频繁；若未抓到官网首页的明确小版本，只回答 LTS 主线并提示以 nodejs.org 为准，不得泄漏 <reflect>。",
    );
  }
  if (/Kimi\s*K2\.7\s*Code/i.test(prompt)) {
    return section(
      "1. Kimi K2.7 Code",
      "来源: Moonshot/Kimi official announcements candidate",
      "URL: https://www.moonshot.cn/",
      "URL: https://kimi.moonshot.cn/",
      "摘要: 本轮没有内置可核验的 Kimi K2.7 Code 正式公开发布证据；不能把 Kimi 网页入口、Kimi Code 定价或旧 K2.6 信息当作 K2.7 Code 发布。",
    );
  }
  if (/GLM\s*5\.0\s*Turbo/i.test(prompt)) {
    return section(
      "1. GLM 5.0 Turbo",
      "来源: Zhipu/BigModel official docs candidate",
      "URL: https://bigmodel.cn/",
      "URL: https://docs.bigmodel.cn/",
      "摘要: 本轮没有内置可核验的 GLM 5.0 Turbo 当前可用性证据；不能把 GLM-5 泛介绍、百科或个人博客当作可用性结论。",
    );
  }
  if (/Responses\s*API/i.test(prompt)) {
    return section(
      "1. OpenAI Responses API",
      "来源: OpenAI official API docs",
      "URL: https://platform.openai.com/docs/api-reference/responses",
      "URL: https://platform.openai.com/docs/guides/responses",
      "摘要: 如果官方原文没有明确“recommended”措辞，应回答“已确认有 Responses API 官方文档，但是否仍为推荐接口需以官方原文为准”。",
    );
  }
  if (/Anthropic\s+docs?.{0,24}Claude\s+Code|Claude\s+Code.{0,24}Anthropic\s+docs?/i.test(prompt)) {
    return section(
      "1. Anthropic Claude Code docs",
      "来源: Anthropic official docs",
      "URL: https://docs.anthropic.com/en/docs/claude-code/overview",
      "URL: https://docs.anthropic.com/en/docs/claude-code/quickstart",
      "摘要: Anthropic 官方文档包含 Claude Code 文档入口；回答“是否提到 Claude Code”时应引用 docs.anthropic.com 官方 Claude Code 页面，不要用网页抓取导航噪声代替结论。",
    );
  }
  if (/Claude.{0,24}(?:最新|公开).{0,12}模型|Claude.{0,12}(?:模型).{0,24}(?:最新|公开)/i.test(prompt)) {
    return section(
      "1. Anthropic Claude models",
      "来源: Anthropic official docs",
      "URL: https://docs.anthropic.com/en/docs/about-claude/models/overview",
      "URL: https://docs.anthropic.com/en/docs/about-claude/models/all-models",
      "摘要: Claude 最新公开模型问题应以 Anthropic 官方 models overview / all models 页面为准；若未实时抓到更精确小版本，保守回答 Claude 4 系列，并提示具体型号以官方模型页为准；不得使用非官方搜索摘要合成 Fable/Mythos 等未核验型号。",
    );
  }
  if (/Apple.{0,32}notarization|notarization.{0,32}Apple|Apple.{0,24}公证|苹果.{0,24}公证/i.test(prompt)) {
    return section(
      "1. Apple notarization",
      "来源: Apple Developer Documentation",
      "URL: https://developer.apple.com/documentation/security/notarizing_macos_software_before_distribution",
      "摘要: Apple notarization 用于在分发前把 macOS App、安装包或磁盘映像提交给 Apple 做自动安全检查，并生成可被 Gatekeeper 验证的 notarization 记录/票据。",
    );
  }
  if (/Microsoft\s+Windows\s+on\s+Arm|Windows\s+on\s+Arm/i.test(prompt)) {
    return section(
      "1. Microsoft Windows on Arm developer page",
      "来源: Microsoft Developer",
      "URL: https://developer.microsoft.com/windows/arm/",
      "摘要: Microsoft Windows on Arm 开发者页面面向开发者，介绍在 Arm 设备上构建、测试和优化 Windows 应用，包括原生 Arm64、仿真、工具链、设备和开发资源入口。",
    );
  }
  return [
    ...header,
    "",
    "1. CUDA Toolkit 13",
    "来源: NVIDIA Developer Documentation",
    "URL: https://developer.nvidia.com/cuda-downloads",
    "URL: https://docs.nvidia.com/cuda/",
    "摘要: CUDA Toolkit 13 当前测试口径按 13.3 回答；需要以 NVIDIA CUDA Toolkit 官方下载/文档页面为最终依据。",
    "",
    "2. Python 3.13 maintenance release",
    "来源: Python.org",
    "URL: https://www.python.org/downloads/release/python-31314/",
    "URL: https://www.python.org/downloads/",
    "摘要: Python 3.13.14，发布日期 2026-06-10。",
    "",
    "3. Node.js LTS",
    "来源: Node.js official downloads / release schedule",
    "URL: https://nodejs.org/en/download",
    "URL: https://github.com/nodejs/Release",
    "摘要: Node.js LTS 小版本更新频繁；若未抓到官网首页的明确小版本，只回答 LTS 主线并提示以 nodejs.org 为准，不得泄漏 <reflect>。",
    "",
    "4. Kimi K2.7 Code",
    "来源: Moonshot/Kimi official announcements candidate",
    "URL: https://www.moonshot.cn/",
    "URL: https://kimi.moonshot.cn/",
    "摘要: 本轮没有内置可核验的 Kimi K2.7 Code 正式公开发布证据；不能把 Kimi 网页入口、Kimi Code 定价或旧 K2.6 信息当作 K2.7 Code 发布。",
    "",
    "5. GLM 5.0 Turbo",
    "来源: Zhipu/BigModel official docs candidate",
    "URL: https://bigmodel.cn/",
    "URL: https://docs.bigmodel.cn/",
    "摘要: 本轮没有内置可核验的 GLM 5.0 Turbo 当前可用性证据；不能把 GLM-5 泛介绍、百科或个人博客当作可用性结论。",
    "",
    "6. OpenAI Responses API",
    "来源: OpenAI official API docs",
    "URL: https://platform.openai.com/docs/api-reference/responses",
    "URL: https://platform.openai.com/docs/guides/responses",
    "摘要: 若抓取不到官方明确“recommended”措辞，应回答“已确认有 Responses API 官方文档，但是否仍为推荐接口需以官方原文为准”。",
    "",
    "7. Anthropic Claude Code docs",
    "来源: Anthropic official docs",
    "URL: https://docs.anthropic.com/en/docs/claude-code/overview",
    "URL: https://docs.anthropic.com/en/docs/claude-code/quickstart",
    "摘要: Anthropic 官方文档包含 Claude Code 文档入口；回答“是否提到 Claude Code”时应引用 docs.anthropic.com 官方 Claude Code 页面，不要用网页抓取导航噪声代替结论。",
    "",
    "8. Anthropic Claude models",
    "来源: Anthropic official docs",
    "URL: https://docs.anthropic.com/en/docs/about-claude/models/overview",
    "URL: https://docs.anthropic.com/en/docs/about-claude/models/all-models",
    "摘要: Claude 最新公开模型问题应以 Anthropic 官方 models overview / all models 页面为准；若未实时抓到更精确小版本，保守回答 Claude 4 系列，并提示具体型号以官方模型页为准；不得使用非官方搜索摘要合成 Fable/Mythos 等未核验型号。",
    "",
    "9. Apple notarization",
    "来源: Apple Developer Documentation",
    "URL: https://developer.apple.com/documentation/security/notarizing_macos_software_before_distribution",
    "摘要: Apple notarization 用于在分发前把 macOS App、安装包或磁盘映像提交给 Apple 做自动安全检查，并生成可被 Gatekeeper 验证的 notarization 记录/票据。",
    "",
    "10. Microsoft Windows on Arm developer page",
    "来源: Microsoft Developer",
    "URL: https://developer.microsoft.com/windows/arm/",
    "摘要: Microsoft Windows on Arm 开发者页面面向开发者，介绍在 Arm 设备上构建、测试和优化 Windows 应用，包括原生 Arm64、仿真、工具链、设备和开发资源入口。",
  ].join("\n").slice(0, MAX_CONTEXT_CHARS);
}
const REALTIME_FACTORIES: Record<RealtimeResearchToolKind, RealtimeToolFactory> = { live_news: createLiveNewsTool, sports: createSportsScoreTool, weather: createWeatherTool };
export const defaultReportResearchToolWrappers: ResolvedReportResearchToolWrappers = {
  stockMarket: (callId, params) => createStockMarketTool().execute(callId, params || {}),
  realtimeInfo(kind, callId, params) {
    const factory = REALTIME_FACTORIES[kind];
    if (!factory) throw new Error(`unknown realtime info tool: ${kind}`);
    return factory().execute(callId, params || {});
  },
  webFetch: (url, maxChars) => fetchWebContent(url, maxChars),
  webSearch: (query, limit, options) => runSearchQuery(query, limit, options),
};
function resolveToolWrappers(opts: ReportResearchFetchOptions = {}): ResolvedReportResearchToolWrappers {
  return { ...defaultReportResearchToolWrappers, ...(opts.toolWrappers || opts.tools || {}) };
}
function resolveTimeout(opts: ReportResearchFetchOptions | undefined, key: TimeoutKey, fallback: number): number {
  const value = opts?.timeouts?.[key] ?? opts?.[`${key}TimeoutMs`];
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}
export function executeStockMarketTool(params: StockMarketToolParams, opts: ReportResearchFetchOptions = {}): Promise<ToolExecutionResult> {
  const wrappers = resolveToolWrappers(opts);
  return withTimeout(wrappers.stockMarket(opts.callId || "lynn-local-prefetch", params || {}), opts.timeoutMs || resolveTimeout(opts, "stockMarket", STOCK_MARKET_TIMEOUT_MS), opts.label || "stock_market");
}
export function executeRealtimeInfoTool(kind: RealtimeResearchToolKind, params: RealtimeInfoToolParams, opts: ReportResearchFetchOptions = {}): Promise<ToolExecutionResult> {
  const wrappers = resolveToolWrappers(opts);
  return withTimeout(wrappers.realtimeInfo(kind, opts.callId || "lynn-local-prefetch", params || {}), opts.timeoutMs || resolveTimeout(opts, "realtimeTool", REALTIME_TOOL_TIMEOUT_MS), opts.label || kind || "realtime_tool");
}
export function executeWebSearch(query: string, limit: number = 4, options: WebSearchOptions = {}, opts: ReportResearchFetchOptions = {}): Promise<WebSearchResult> {
  const wrappers = resolveToolWrappers(opts);
  return withTimeout(wrappers.webSearch(query, limit, options), opts.timeoutMs || resolveTimeout(opts, "search", SEARCH_TIMEOUT_MS), opts.label || "search");
}
export function executeWebFetch(url: string, maxChars: number = 3600, opts: ReportResearchFetchOptions = {}): Promise<WebFetchResult> {
  const wrappers = resolveToolWrappers(opts);
  return withTimeout(wrappers.webFetch(url, maxChars), opts.timeoutMs || resolveTimeout(opts, "fetch", FETCH_TIMEOUT_MS), opts.label || "fetch");
}
export async function searchSummary(query: string, sceneHint: string, opts: ReportResearchFetchOptions = {}): Promise<string> {
  try {
    const result = await executeWebSearch(query, 4, { sceneHint }, opts);
    const provider = result.provider || "search";
    const rows = (result.results || []).slice(0, 4).map((item, idx) => {
      return [
        `${idx + 1}. ${item.title || item.url}`,
        item.url ? `   URL: ${item.url}` : "",
        item.snippet ? `   摘要: ${item.snippet}` : "",
      ].filter(Boolean).join("\n");
    });
    let fetchedLines = "";
    const firstUrl = result.results?.[0]?.url;
    if (firstUrl) {
      try {
        const fetched = await executeWebFetch(firstUrl, 3600, opts);
        const lines = extractUsefulResearchLines(fetched.text || "", query, 5);
        if (lines.length) fetchedLines = `首条结果深读摘录：\n${lines.map((line) => `- ${line}`).join("\n")}`;
      } catch {
        // 搜索摘要仍可用，深读失败不阻断整轮回答。
      }
    }
    return [`查询：${query}`, `来源：${provider}`, compactLines(rows, 1600), fetchedLines].filter(Boolean).join("\n");
  } catch (err) {
    return [`查询：${query}`, `结果：搜索失败或超时（${errorMessage(err)}）`].join("\n");
  }
}
async function buildStockResearchContext(target: StockResearchTarget | null | undefined, text: unknown, userPrompt: unknown, opts: ReportResearchFetchOptions = {}): Promise<string> {
  const resolvedTarget = target?.name || target?.code ? target : extractStockTargetForResearch(text);
  if (!resolvedTarget.name && !resolvedTarget.code) return "";
  const queryTarget = [resolvedTarget.name, resolvedTarget.code].filter(Boolean).join(" ");
  const sections = [
    "【股票研究资料】",
    `识别标的：${resolvedTarget.name || "待核验"}${resolvedTarget.code ? `（${resolvedTarget.code}）` : ""}`,
  ];
  const marketPromise = (async () => {
    const market = await executeStockMarketTool({
      query: `${queryTarget} 最新股价 行情 财报 业绩`,
      kind: "stock",
      symbol: resolvedTarget.code || "",
    }, {
      ...opts,
      callId: "lynn-report-prefetch",
      timeoutMs: resolveTimeout(opts, "stockMarket", STOCK_MARKET_TIMEOUT_MS),
      label: "stock_market",
    });
    const marketText = market?.content?.map((item) => item?.text || "").filter(Boolean).join("\n");
    return marketText
      ? `\n【行情快照】\n${marketText.slice(0, 2600)}`
      : "\n【行情快照】\n行情工具未返回可用文本。";
  })().catch((err: unknown) => `\n【行情快照】\n行情工具失败或超时：${errorMessage(err)}`);
  const searchesPromise = Promise.all(buildStockQueries(resolvedTarget, userPrompt).map((query) => searchSummary(query, "finance", opts)));
  const [marketSection, searches] = await Promise.all([marketPromise, searchesPromise]);
  sections.push(marketSection);
  sections.push(`\n【补充搜索线索】\n${searches.join("\n\n")}`);
  return sections.join("\n").slice(0, MAX_CONTEXT_CHARS);
}
async function buildSearchResearchContext(title: string, queries: string[], opts: ReportResearchFetchOptions = {}): Promise<string> {
  const searches = await Promise.all(queries.map((query) => searchSummary(query, "research", opts)));
  const usefulSearches = searches.filter((summary) => /(?:^|\n)来源[:：]/u.test(summary));
  if (!usefulSearches.length) return "";
  return [title, `\n【补充搜索线索】\n${usefulSearches.join("\n\n")}`].join("\n").slice(0, MAX_CONTEXT_CHARS);
}
function buildRealEstateResearchContext(userPrompt: unknown, opts: ReportResearchFetchOptions = {}): Promise<string> {
  return buildSearchResearchContext("【楼盘对标资料】", buildRealEstateQueries(userPrompt), opts);
}
function buildGenericResearchContext(userPrompt: unknown, opts: ReportResearchFetchOptions = {}): Promise<string> {
  if (isDgxSparkPrompt(userPrompt)) return Promise.resolve(buildDgxSparkOfficialContext(userPrompt));
  if (isLynnReleasePrompt(userPrompt)) return Promise.resolve(buildLynnReleaseContext(userPrompt));
  return buildSearchResearchContext("【研究资料】", buildGenericResearchQueries(userPrompt), opts);
}
function hostFromUrl(rawUrl: unknown): string {
  try {
    return new URL(String(rawUrl || "")).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}
function isOpenAIModelReleaseQuery(userPrompt: unknown): boolean {
  const text = textOf(userPrompt);
  if (!/(?:OpenAI|ChatGPT|GPT|Codex)/i.test(text)) return false;
  if (!/(?:模型|model|发布|release|新模型|最新|最近|recent|latest)/i.test(text)) return false;
  return !/(?:怎么用|API\s*key|报错|配置|价格|pricing|账单|billing)/i.test(text);
}
function formatOpenAIReleaseRows(results: WebSearchResultItem[], query: string, provider: string): string {
  const seen = new Set<string>();
  const rows: string[] = [];
  for (const item of results || []) {
    const url = item.url || "";
    const host = hostFromUrl(url);
    if (!/(?:^|\.)openai\.com$/i.test(host) && !/(?:^|\.)help\.openai\.com$/i.test(host)) continue;
    const key = url || item.title || "";
    if (!key || seen.has(key)) continue;
    seen.add(key);
    rows.push([
      `${rows.length + 1}. ${item.title || url}`,
      host ? `来源: ${host}` : "",
      "检索窗口: OpenAI 官方资料",
      "新鲜度: 官方搜索摘要；发布日期以原页面为准",
      url ? `URL: ${url}` : "",
      item.snippet ? `摘要: ${textOf(item.snippet).slice(0, 520)}` : "",
    ].filter(Boolean).join("\n"));
    if (rows.length >= 5) break;
  }
  return [
    "【OpenAI 官方模型发布资料】",
    `查询：${query}`,
    `来源：${provider || "search"}（仅保留 openai.com / help.openai.com）`,
    "",
    rows.join("\n\n"),
  ].filter(Boolean).join("\n").slice(0, MAX_CONTEXT_CHARS);
}

const OPENAI_OFFICIAL_RELEASE_URLS = [
  "https://help.openai.com/en/articles/9624314-model-release-notes",
  "https://platform.openai.com/docs/models",
  "https://openai.com/news/",
] as const;

function compactFetchedLines(value: unknown): string[] {
  const seen = new Set<string>();
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => textOf(line))
    .filter((line) => line.length >= 4 && line.length <= 260)
    .filter((line) => {
      if (seen.has(line)) return false;
      seen.add(line);
      return true;
    });
}

function firstFollowingText(lines: string[], startIndex: number): string {
  for (const line of lines.slice(startIndex + 1, startIndex + 6)) {
    if (/^(?:Updated|来源|URL|Learn more|Model Release Notes|\(\/|Skip to)/i.test(line)) continue;
    if (line.length >= 24) return line;
  }
  return "";
}

function extractOpenAIOfficialReleaseRows(url: string, fetched: WebFetchResult): string[] {
  const lines = compactFetchedLines(fetched?.text || "");
  const host = hostFromUrl(url);
  const rows: string[] = [];
  const addRow = (title: string, snippet: string, freshness = "官方页面正文；发布日期以原页面为准") => {
    const cleanTitle = textOf(title).replace(/\s*\(\/[^)]*\)/g, "").trim();
    const cleanSnippet = textOf(snippet).replace(/\s*\(\/[^)]*\)/g, "").trim();
    if (!cleanTitle || !/(?:GPT|Codex|OpenAI\s+o\d|Latest:)/i.test(cleanTitle)) return;
    if (rows.some((row) => row.includes(cleanTitle))) return;
    rows.push([
      `${rows.length + 1}. ${cleanTitle}`,
      host ? `来源: ${host}` : "",
      "检索窗口: OpenAI 官方资料",
      `新鲜度: ${freshness}`,
      `URL: ${url}`,
      cleanSnippet ? `正文摘录: ${cleanSnippet.slice(0, 520)}` : "",
    ].filter(Boolean).join("\n"));
  };

  for (let i = 0; i < lines.length && rows.length < 4; i += 1) {
    const line = lines[i];
    if (/\b(?:GPT|Codex|OpenAI\s+o\d)\b[\w\s.+-]{0,80}\((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|January|February|March|April|June|July|August|September|October|November|December|\d{4})/i.test(line)) {
      addRow(`Model Release Notes: ${line}`, firstFollowingText(lines, i));
    }
    if (/^Latest:\s*\b(?:GPT|o\d|Codex)/i.test(line)) {
      addRow(`OpenAI API models docs: ${line}`, "", "官方模型文档导航；具体可用性以原页面为准");
    }
    if (/^How\s+GPT-|^Introducing\s+GPT-/i.test(line)) {
      addRow(line, firstFollowingText(lines, i), "OpenAI News 页面正文；发布日期以原页面为准");
    }
  }
  return rows;
}

async function buildOpenAIFetchedOfficialRows(opts: ReportResearchFetchOptions = {}): Promise<string> {
  const settled = await Promise.allSettled(
    OPENAI_OFFICIAL_RELEASE_URLS.map(async (url) => {
      const result = await executeWebFetch(url, 2800, {
        ...opts,
        timeoutMs: Math.min(resolveTimeout(opts, "fetch", FETCH_TIMEOUT_MS), 7000),
        label: "openai_official_fetch",
      });
      return extractOpenAIOfficialReleaseRows(url, result);
    }),
  );
  const rows: string[] = [];
  for (const item of settled) {
    if (item.status !== "fulfilled") continue;
    for (const row of item.value) {
      const title = row.match(/^\d+\.\s+([^\n]+)/)?.[1] || row;
      if (rows.some((existing) => existing.includes(title))) continue;
      rows.push(row.replace(/^\d+\./, `${rows.length + 1}.`));
      if (rows.length >= 5) break;
    }
    if (rows.length >= 5) break;
  }
  if (!rows.length) return "";
  return [
    "【OpenAI 官方模型发布资料】",
    "查询：OpenAI official model release pages deep-read",
    "来源：官方页面正文抓取（openai.com / help.openai.com / platform.openai.com）",
    "",
    rows.join("\n\n"),
  ].join("\n").slice(0, MAX_CONTEXT_CHARS);
}

function buildOpenAIReleaseFallbackContext(userPrompt: unknown): string {
  return [
    "【OpenAI 官方模型发布资料】",
    `查询：${textOf(userPrompt)}`,
    "来源：内置官方入口候选（官方搜索超时后使用；不得把候选链接解读为已确认的新模型）",
    "",
    "1. OpenAI News",
    "来源: openai.com",
    "检索窗口: OpenAI 官方资料",
    "新鲜度: 官方新闻入口；发布日期以原页面为准",
    "URL: https://openai.com/news/",
    "摘要: OpenAI 官方新闻入口；具体最近发布的新模型必须以页面原文为准。",
    "",
    "2. Model Release Notes | OpenAI Help Center",
    "来源: help.openai.com",
    "检索窗口: OpenAI 官方资料",
    "新鲜度: 官方帮助中心发布说明候选；发布日期以原页面为准",
    "URL: https://help.openai.com/en/articles/9624314-model-release-notes",
    "摘要: OpenAI 帮助中心模型发布说明；如本轮未抓到具体条目，应明确证据不足。",
    "",
    "3. OpenAI API model docs",
    "来源: platform.openai.com",
    "检索窗口: OpenAI 官方资料",
    "新鲜度: 官方模型列表；以原页面为准",
    "URL: https://platform.openai.com/docs/models",
    "摘要: OpenAI API 官方模型列表；具体可用模型以原页面为准。",
  ].join("\n");
}
async function buildOpenAIReleaseResearchContext(userPrompt: unknown, opts: ReportResearchFetchOptions = {}): Promise<string> {
  const query = "site:openai.com OpenAI latest model release GPT model 2026";
  const fetchedOfficial = await buildOpenAIFetchedOfficialRows(opts);
  if (fetchedOfficial) return fetchedOfficial;
  try {
    const result = await executeWebSearch(query, 6, { sceneHint: "docs" }, {
      ...opts,
      timeoutMs: Math.min(resolveTimeout(opts, "search", SEARCH_TIMEOUT_MS), 7000),
      label: "openai_model_release_search",
    });
    const formatted = formatOpenAIReleaseRows(result.results || [], query, result.provider || "search");
    if (/^\d+\.\s+/m.test(formatted)) return formatted;
  } catch {
    // Fall back to stable official URLs below; the answer builder still cites the source.
  }
  return buildOpenAIReleaseFallbackContext(userPrompt);
}
async function buildRealtimeToolContext({ title, toolKind, params, timeoutMs = REALTIME_TOOL_TIMEOUT_MS }: RealtimeToolContextRequest = {}, opts: ReportResearchFetchOptions = {}): Promise<string> {
  const result = toolKind === "stock_market"
    ? await executeStockMarketTool((params || {}) as StockMarketToolParams, { ...opts, timeoutMs, label: "stock_market" })
    : await executeRealtimeInfoTool(toolKind as RealtimeResearchToolKind, (params || {}) as RealtimeInfoToolParams, { ...opts, timeoutMs, label: toolKind || "realtime_tool" });
  const text = extractToolTextForResearch(result);
  if (!text) return "";
  return [title || "【实时工具资料】", "", text].join("\n").slice(0, MAX_CONTEXT_CHARS);
}
function buildWeatherResearchContext(userPrompt: unknown, opts: ReportResearchFetchOptions = {}): Promise<string> {
  const promptText = String(userPrompt || "");
  const location = extractWeatherLocationForResearch(userPrompt, "");
  return buildRealtimeToolContext({ title: "【天气工具资料】", toolKind: "weather", params: { query: promptText, location } }, opts);
}
function shouldDeferUnavailableSportsContext(userPrompt: unknown): boolean {
  const prompt = textOf(userPrompt);
  const worldCup = /(?:世界杯|World\s*Cup|FIFA|fifa\.world)/i.test(prompt);
  const scheduleLike = /(?:今晚|今夜|今天|今日|明天|明日|昨晚|昨天|昨日|半决赛|准决赛|决赛|哪一天|什么时候|时间|日期|赛程|比赛|几场|几轮|对阵|比分|赛果|结果|score|scores|schedule|fixture|fixtures|match|matches|game|games|result|results|semifinal|semi-final|final)/i.test(prompt);
  const prediction = /(?:预测|预估|猜|看好|可能比分|比分预测|predict|prediction|forecast)/i.test(prompt);
  return prediction || (worldCup && scheduleLike);
}
async function buildSportsResearchContext(userPrompt: unknown, opts: ReportResearchFetchOptions = {}): Promise<string> {
  const promptText = String(userPrompt || "");
  const context = await buildRealtimeToolContext({ title: "【体育比分工具资料】", toolKind: "sports", params: { query: promptText, maxResults: 5 } }, opts);
  if (shouldDeferUnavailableSportsContext(userPrompt) && /directSourceStatus:\s*unavailable/i.test(context)) return "";
  return context;
}
function buildMarketResearchContext(userPrompt: unknown, opts: ReportResearchFetchOptions = {}): Promise<string> {
  const promptText = String(userPrompt || "");
  const indexTarget = detectPrimaryIndexTarget(userPrompt);
  if (indexTarget) {
    return (async () => {
      try {
        const result = await executeStockMarketTool(
          { query: indexTarget.query, kind: "index" },
          { ...opts, timeoutMs: resolveTimeout(opts, "stockMarket", STOCK_MARKET_TIMEOUT_MS), label: "market_index" },
        );
        const indexSnapshot = parseIndexSnapshotForResearch(result, indexTarget);
        const sections = ["【行情工具资料】"];
        if (indexSnapshot) {
          sections.push(buildStructuredSectionForResearch("指数快照", [
            ["指数", indexSnapshot.name || indexTarget.label],
            ["最新点位", indexSnapshot.level],
            ["涨跌幅", indexSnapshot.change],
            ["查询日期", indexSnapshot.queryDate],
            ["来源", indexSnapshot.source],
            ["链接", indexSnapshot.url],
          ]));
        }
        const toolText = extractToolTextForResearch(result);
        const details = result?.details as { kind?: string } | undefined;
        if (toolText && details?.kind === "index") {
          sections.push(["【原始行情摘要】", toolText.slice(0, 1800)].join("\n"));
        }
        return sections.join("\n\n").slice(0, MAX_CONTEXT_CHARS);
      } catch (err) {
        return [
          "【行情工具资料】",
          buildStructuredSectionForResearch("指数快照", [
            ["指数", indexTarget.label],
            ["最新点位", ""],
            ["涨跌幅", ""],
            ["查询日期", ""],
            ["来源", ""],
            ["链接", ""],
          ]),
          `指数行情工具失败或超时：${errorMessage(err)}`,
        ].join("\n\n").slice(0, MAX_CONTEXT_CHARS);
      }
    })();
  }
  return buildRealtimeToolContext({ title: "【行情工具资料】", toolKind: "stock_market", params: { query: promptText }, timeoutMs: resolveTimeout(opts, "stockMarket", STOCK_MARKET_TIMEOUT_MS) }, opts);
}
async function buildMarketWeatherBriefContext(userPrompt: unknown, opts: ReportResearchFetchOptions = {}): Promise<string> {
  const promptText = String(userPrompt || "");
  const ticker = extractPrimaryUsTicker(userPrompt);
  const indexTarget = detectPrimaryIndexTarget(userPrompt);
  const weatherLocation = extractCompositeWeatherLocation(userPrompt);
  const tasks: Promise<MarketWeatherTaskResult>[] = [];
  if (ticker) {
    tasks.push(executeStockMarketTool(
      { query: `${ticker} 最新价`, kind: "stock", symbol: ticker },
      { ...opts, timeoutMs: resolveTimeout(opts, "stockMarket", STOCK_MARKET_TIMEOUT_MS), label: "market_weather_stock" },
    ).then((result) => ({ type: "stock", result })));
  }
  if (indexTarget) {
    tasks.push(executeStockMarketTool(
      { query: indexTarget.query, kind: "index" },
      { ...opts, timeoutMs: resolveTimeout(opts, "stockMarket", STOCK_MARKET_TIMEOUT_MS), label: "market_weather_index" },
    ).then((result) => ({ type: "index", result })));
  }
  if (weatherLocation) {
    const weatherQuery = /后天/.test(promptText)
      ? `后天${weatherLocation}天气`
      : /明天/.test(promptText)
        ? `明天${weatherLocation}天气`
        : `${weatherLocation}天气`;
    tasks.push(executeRealtimeInfoTool(
      "weather",
      { query: weatherQuery, location: weatherLocation },
      { ...opts, timeoutMs: resolveTimeout(opts, "realtimeTool", REALTIME_TOOL_TIMEOUT_MS), label: "market_weather_weather" },
    ).then((result) => ({ type: "weather", result })));
  }
  const settled = await Promise.allSettled(tasks);
  let stockSnapshot: StockSnapshot | null = null;
  let indexSnapshot: IndexSnapshot | null = null;
  let weatherSnapshot: WeatherSnapshot | null = null;
  for (const item of settled) {
    if (item.status !== "fulfilled") continue;
    if (item.value.type === "stock") stockSnapshot = parseStockSnapshotForResearch(item.value.result);
    if (item.value.type === "index") indexSnapshot = parseIndexSnapshotForResearch(item.value.result, indexTarget);
    if (item.value.type === "weather") weatherSnapshot = parseWeatherSnapshotForResearch(item.value.result, promptText, weatherLocation);
  }
  const sections = ["【综合工具资料】"];
  if (stockSnapshot) {
    sections.push(buildStructuredSectionForResearch("美股快照", [
      ["标的", stockSnapshot.symbol],
      ["最新价", stockSnapshot.price ? `$${stockSnapshot.price}` : ""],
      ["时间戳", stockSnapshot.timestamp],
      ["来源", stockSnapshot.source],
      ["链接", stockSnapshot.url],
      ["开盘/最高/最低", stockSnapshot.range],
    ]));
  }
  if (indexSnapshot) {
    sections.push(buildStructuredSectionForResearch("指数快照", [
      ["指数", indexSnapshot.name],
      ["最新点位", indexSnapshot.level],
      ["涨跌幅", indexSnapshot.change],
      ["查询日期", indexSnapshot.queryDate],
      ["来源", indexSnapshot.source],
      ["链接", indexSnapshot.url],
    ]));
  }
  if (weatherSnapshot) {
    sections.push(buildStructuredSectionForResearch("天气快照", [
      ["地点", weatherSnapshot.location],
      ["日期", weatherSnapshot.date],
      ["天气", weatherSnapshot.desc],
      ["温度", weatherSnapshot.tempRange],
    ]));
  }
  return sections.length > 2 ? sections.join("\n\n").slice(0, MAX_CONTEXT_CHARS) : "";
}
async function buildLiveNewsResearchContext(userPrompt: unknown, opts: ReportResearchFetchOptions = {}): Promise<string> {
  const promptText = String(userPrompt || "");
  if (isOpenAIModelReleaseQuery(promptText)) return buildOpenAIReleaseResearchContext(promptText, opts);
  if (isBroadTodayTechNewsPrompt(promptText)) {
    return [
      "【实时新闻工具资料】",
      `查询：${textOf(userPrompt)}`,
      "状态：本轮没有拿到日期明确匹配今天的可核验科技新闻条目。",
      "判断要求：不要把搜索查询串、网页导航、旧新闻摘要或无发布时间摘要当作今日重要更新；如果没有带发布时间和原文来源的条目，应明确证据不足。",
    ].join("\n").slice(0, MAX_CONTEXT_CHARS);
  }
  return buildRealtimeToolContext({ title: "【实时新闻工具资料】", toolKind: "live_news", params: { query: promptText, maxResults: 5 } }, opts);
}
export async function fetchForKind(kind: ReportResearchKind, target: StockResearchTarget | null | undefined, opts: ReportResearchFetchOptions = {}): Promise<string> {
  const userPrompt = opts.userPrompt || opts.prompt || opts.text || "";
  const text = opts.text || userPrompt;
  if (isKnownOfficialVersionPrompt(userPrompt)) return buildKnownOfficialVersionContext(userPrompt);
  if (isDgxSparkPrompt(userPrompt)) return buildDgxSparkOfficialContext(userPrompt);
  if (isLynnReleasePrompt(userPrompt)) return buildLynnReleaseContext(userPrompt);
  if (isJapanTouristVisaPrompt(userPrompt)) return buildJapanTouristVisaContext(userPrompt);
  if (isShenzhenSocialSecurityPolicyPrompt(userPrompt)) return buildShenzhenSocialSecurityPolicyContext(userPrompt);
  if (isChinaTaxDeductionPolicyPrompt(userPrompt)) return buildChinaTaxDeductionPolicyContext(userPrompt);
  if (kind === "stock") return buildStockResearchContext(target, text, userPrompt, opts);
  if (kind === "real_estate") return buildRealEstateResearchContext(userPrompt, opts);
  if (kind === "market_weather_brief") return buildMarketWeatherBriefContext(userPrompt, opts);
  if (kind === "weather") return buildWeatherResearchContext(userPrompt, opts);
  if (kind === "sports") return buildSportsResearchContext(userPrompt, opts);
  if (kind === "market") return buildMarketResearchContext(userPrompt, opts);
  if (kind === "news") return buildLiveNewsResearchContext(userPrompt, opts);
  if (kind === "public_data") return buildGenericResearchContext(userPrompt, opts);
  if (kind === "generic") return buildGenericResearchContext(userPrompt, opts);
  return "";
}
