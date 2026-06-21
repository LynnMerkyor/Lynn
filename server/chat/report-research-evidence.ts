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
      basis: "天气工具返回的预报快照，按用户问法优先选择今天/明天/后天对应日期。",
      caveat: "天气预报会滚动变化，出门前建议再看本地天气 App 或雷达。",
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
      basis: "原油行情工具返回的最近可用合约报价。",
      caveat: "期货/CFD 价格盘中波动明显，交易前请用行情终端核验。",
    };
  }
  if (kind === "market") {
    return {
      tool: "stock_market",
      basis: "行情工具返回的最近可用股价、指数或板块候选数据。",
      caveat: "行情展示不构成投资建议；交易级实时性请用券商或交易所源核验。",
    };
  }
  return {
    tool: "research_prefetch",
    basis: "系统预取资料中的可用证据。",
    caveat: "资料不足时应继续补充来源再下结论。",
  };
}

export function appendEvidenceBlock(answer: unknown, { kind, context, userPrompt }: EvidenceBlockOptions = {}): string {
  const body = String(answer || "").trim();
  if (!body || /数据来源\/判断依据/.test(body)) return body;
  const prompt = textOf(userPrompt);
  if (/(?:一句话|一句|一行|简短|简洁|直接回答|只回复|只回答)/.test(prompt)) return body;
  const meta = inferEvidenceMeta(kind, prompt);
  const sources = extractEvidenceSources(context);
  return [
    body,
    "",
    "数据来源/判断依据",
    `- 工具：${meta.tool}`,
    `- 时间：${formatLocalDateTime()}（本机时间）`,
    sources.length ? `- 来源：${sources.join("、")}` : "",
    `- 依据：${meta.basis}`,
    `- 注意：${meta.caveat}`,
  ].filter(Boolean).join("\n");
}
