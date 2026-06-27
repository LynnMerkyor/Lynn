import type {
  EvidenceBlockOptions,
  EvidenceMeta,
  ResearchAnswerKind,
} from "./report-research-answer-types.js";
import {
  extractEvidenceSources,
  formatLocalDateTime,
  textOf,
} from "./report-research-answer-utils.js";

function inferEvidenceMeta(kind: ResearchAnswerKind | undefined, prompt: string): EvidenceMeta {
  if (kind === "weather") {
    return {
      tool: "weather",
      basis: "天气预报快照，按用户问法优先选择今天/明天/后天对应日期。",
      caveat: "天气预报会滚动变化，出门前建议再看本地天气 App 或雷达。",
    };
  }
  if (kind === "sports") {
    return {
      tool: "sports_score",
      basis: "体育比分数据源返回的赛程/赛果快照，按用户问法筛选赛事和日期。",
      caveat: "赛程、开球时间和赛果会滚动更新，赛前/赛后建议再核验官方赛程页。",
    };
  }
  if (kind === "news") {
    return {
      tool: "live_news / web_search",
      basis: "按最近新闻候选、发布时间、来源链接和主题相关度筛选。",
      caveat: "正式引用前建议打开原文核验全文和发布时间。",
    };
  }
  if (kind === "market_weather_brief") {
    return {
      tool: "stock_market + weather",
      basis: "综合行情快照和天气预报快照生成行动建议。",
      caveat: "行情与天气都会实时波动，关键决策前请二次核验。",
    };
  }
  if (/金价|黄金|白银|金交所|金店|回收价|Au99\.99|Au9999|XAU|金条/i.test(prompt)) {
    return {
      tool: "stock_market",
      basis: "黄金/白银行情与品牌报价聚合结果，优先使用含明确数字的最近可用报价。",
      caveat: "门店、地区、工费和更新时间会造成差异，不构成投资或购买建议。",
    };
  }
  if (/原油|油价|布伦特|WTI|crude|oil/i.test(prompt)) {
    return {
      tool: "stock_market",
      basis: "原油行情数据返回的最近可用合约报价。",
      caveat: "期货/CFD 价格盘中波动明显，交易前请用行情终端核验。",
    };
  }
  if (kind === "market") {
    return {
      tool: "stock_market",
      basis: "行情数据返回的最近可用股价、指数或板块候选数据。",
      caveat: "行情展示不构成投资建议；交易级实时性请用券商或交易所源核验。",
    };
  }
  return {
    tool: "research_prefetch",
    basis: "系统预取资料中的可用证据。",
    caveat: "资料不足时应继续补充来源再下结论。",
  };
}

function formatEvidenceDataSource(tool: string): string {
  const normalized = String(tool || "").trim();
  if (!normalized) return "资料检索";
  const parts = normalized
    .split(/\s*(?:\+|\/|,|，)\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
  const mapped = parts.map((part) => {
    switch (part) {
      case "weather":
        return "天气预报";
      case "sports_score":
        return "体育比分";
      case "stock_market":
        return "行情报价";
      case "live_news":
        return "新闻源";
      case "web_search":
        return "网页检索";
      case "web_fetch":
        return "网页正文";
      case "research_prefetch":
        return "预取资料";
      default:
        return "资料检索";
    }
  });
  return Array.from(new Set(mapped)).join(" + ") || "资料检索";
}

export function appendEvidenceBlock(answer: unknown, { kind, context, userPrompt }: EvidenceBlockOptions = {}): string {
  const body = String(answer || "").trim();
  if (!body || /数据来源\/判断依据|来源与核验/.test(body)) return body;
  const prompt = textOf(userPrompt);
  if (/(?:一句话|一句|一行|简短|简洁|直接回答|只回复|只回答)/.test(prompt)) return body;
  const meta = inferEvidenceMeta(kind, prompt);
  const sources = extractEvidenceSources(context);
  return [
    body,
    "",
    "来源与核验",
    `- 数据源：${formatEvidenceDataSource(meta.tool)}`,
    `- 时间：${formatLocalDateTime()}（本机时间）`,
    sources.length ? `- 参考来源：${sources.join("、")}` : "",
    `- 依据：${meta.basis}`,
    `- 注意：${meta.caveat}`,
  ].filter(Boolean).join("\n");
}
