import { createStockMarketTool } from "../../lib/tools/stock-market.js";
import { createLiveNewsTool, createSportsScoreTool, createWeatherTool } from "../../lib/tools/realtime-info.js";
import { fetchWebContent } from "../../lib/tools/web-fetch.js";
import { runSearchQuery } from "../../lib/tools/web-search.js";
import { buildStructuredSection, extractToolText, parseIndexSnapshot, parseStockSnapshot, parseWeatherSnapshot } from "./report-research-answer.js";
import { detectPrimaryIndexTarget, extractCompositeWeatherLocation, extractPrimaryUsTicker, extractStockTargetForResearch, extractWeatherLocationForResearch } from "./report-research-intent.js";
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
  return [title, `\n【补充搜索线索】\n${searches.join("\n\n")}`].join("\n").slice(0, MAX_CONTEXT_CHARS);
}
function buildRealEstateResearchContext(userPrompt: unknown, opts: ReportResearchFetchOptions = {}): Promise<string> {
  return buildSearchResearchContext("【楼盘对标资料】", buildRealEstateQueries(userPrompt), opts);
}
function buildGenericResearchContext(userPrompt: unknown, opts: ReportResearchFetchOptions = {}): Promise<string> {
  return buildSearchResearchContext("【研究资料】", buildGenericResearchQueries(userPrompt), opts);
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
function buildSportsResearchContext(userPrompt: unknown, opts: ReportResearchFetchOptions = {}): Promise<string> {
  const promptText = String(userPrompt || "");
  return buildRealtimeToolContext({ title: "【体育比分工具资料】", toolKind: "sports", params: { query: promptText, maxResults: 5 } }, opts);
}
function buildMarketResearchContext(userPrompt: unknown, opts: ReportResearchFetchOptions = {}): Promise<string> {
  const promptText = String(userPrompt || "");
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
  return buildRealtimeToolContext({ title: "【实时新闻工具资料】", toolKind: "live_news", params: { query: promptText, maxResults: 5 } }, opts);
}
export async function fetchForKind(kind: ReportResearchKind, target: StockResearchTarget | null | undefined, opts: ReportResearchFetchOptions = {}): Promise<string> {
  const userPrompt = opts.userPrompt || opts.prompt || opts.text || "";
  const text = opts.text || userPrompt;
  if (kind === "stock") return buildStockResearchContext(target, text, userPrompt, opts);
  if (kind === "real_estate") return buildRealEstateResearchContext(userPrompt, opts);
  if (kind === "market_weather_brief") return buildMarketWeatherBriefContext(userPrompt, opts);
  if (kind === "weather") return buildWeatherResearchContext(userPrompt, opts);
  if (kind === "sports") return buildSportsResearchContext(userPrompt, opts);
  if (kind === "market") return buildMarketResearchContext(userPrompt, opts);
  if (kind === "news") return buildLiveNewsResearchContext(userPrompt, opts);
  if (kind === "generic") return buildGenericResearchContext(userPrompt, opts);
  return "";
}
