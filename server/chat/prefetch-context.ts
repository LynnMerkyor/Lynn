/**
 * 预取上下文 — 离线计算与本地预取
 *
 * 从 server/routes/chat.js 提取。负责本地精确计算（预算等）和
 * report-research 预取决策。
 */
interface ModelInfoLike {
  isBrain?: unknown;
}

export function shouldPrefetchReportContext(reportKind: unknown, currentModelInfo?: ModelInfoLike | null): boolean {
  if (!reportKind) return false;
  // Brain V2 owns open-ended realtime research server-side. For deterministic
  // realtime facts, keep a local evidence pass so GUI turns can close with
  // visible tool evidence even if the writer times out.
  if (currentModelInfo?.isBrain) {
    return new Set(["market_weather_brief", "weather", "sports", "market", "stock", "news", "public_data"]).has(String(reportKind));
  }
  return true;
}

export function shouldSuppressLocalToolPrefetch(text: unknown): boolean {
  const source = String(text || "");
  return /(?:不要|不必|不用|无需|别|勿).{0,12}(?:调用|使用|用).{0,8}(?:工具|搜索|联网|查询|检索)/.test(source)
    || /(?:不要|不必|不用|无需|别|勿).{0,8}(?:搜索|联网|查询|检索)/.test(source)
    || /(?:只|仅)(?:回复|输出|回答)\s*[：:]/.test(source);
}

export function prefetchToolNameForKind(kind: unknown): string {
  if (kind === "market_weather_brief") return "market_weather_brief";
  if (kind === "weather") return "weather";
  if (kind === "sports") return "sports_score";
  if (kind === "market" || kind === "stock") return "stock_market";
  if (kind === "news") return "live_news";
  if (kind === "public_data") return "web_search";
  return "web_search";
}

function parseLooseAmount(value: unknown): number | null {
  const n = Number(String(value || "").replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

export function buildBudgetCalculationContext(text: unknown): string {
  const source = String(text || "");
  if (!/(?:月收入|收入)/.test(source) || !/(?:攒|存|储蓄|存款)/.test(source)) return "";

  const income = parseLooseAmount(source.match(/月收入\s*[：:]?\s*[¥￥]?\s*([\d,\s]+)/)?.[1]);
  const rent = parseLooseAmount(source.match(/房租\s*[：:]?\s*[¥￥]?\s*([\d,\s]+)/)?.[1]);
  const fixed = parseLooseAmount(source.match(/固定支出\s*[：:]?\s*[¥￥]?\s*([\d,\s]+)/)?.[1]);
  const months = parseLooseAmount(source.match(/(\d+)\s*个?\s*月/)?.[1]);
  const goal = parseLooseAmount(
    source.match(/(?:攒|存|储蓄|存款)\s*[¥￥]?\s*([\d,\s]+)/)?.[1]
      || source.match(/目标(?:金额|存款|储蓄)?\s*[：:]?\s*[¥￥]?\s*([\d,\s]+)/)?.[1],
  );

  const amounts = [income, rent, fixed, months, goal];
  if (!amounts.every((n): n is number => typeof n === "number" && Number.isFinite(n) && n > 0)) return "";
  const [incomeAmount, rentAmount, fixedAmount, monthsAmount, goalAmount] = amounts;
  const fixedSpend = rentAmount + fixedAmount;
  const remainingBeforeSaving = incomeAmount - fixedSpend;
  const monthlySaving = goalAmount / monthsAmount;
  const disposableAfterSaving = remainingBeforeSaving - monthlySaving;
  const fmt = (n: number) => Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.00$/, "");

  return [
    "【本地精确计算】",
    `月收入：${fmt(incomeAmount)}`,
    `房租：${fmt(rentAmount)}`,
    `固定支出：${fmt(fixedAmount)}`,
    `房租+固定支出：${fmt(fixedSpend)}`,
    `未储蓄前每月剩余：${fmt(remainingBeforeSaving)}`,
    `目标金额：${fmt(goalAmount)}`,
    `目标周期：${fmt(monthsAmount)} 个月`,
    `每月需要存：${fmt(monthlySaving)}`,
    `完成储蓄后每月可支配：${fmt(disposableAfterSaving)}`,
  ].join("\n");
}
