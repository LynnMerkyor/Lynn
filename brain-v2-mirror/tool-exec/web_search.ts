// @ts-nocheck
// Brain v2 · web_search tool
// Search chain: GLM Web Search primary for speed/freshness, MiMo fallback for full source links.
import {
  buildEvidencePolicyHint,
  classifySearchEvidencePolicy,
  enrichEvidenceSearchQuery,
  isEventPredictionQuery,
  isProductReleaseOrVersionQuery,
  isSportsScoreOrScheduleQuery,
  needsSourceGradeEvidence,
  normalizeSearchQueryIntent,
} from "../evidence-quality.js";
import { makeLruCache } from "./_helpers.js";
import { sportsScore } from "./utility.js";
const cache = makeLruCache(200, 5 * 60 * 1e3);
const structuredCache = makeLruCache(200, 5 * 60 * 1e3);
const BUDGET_MS = 14e3;
const PRIMARY_SEARCH_BUDGET_MS = Number(process.env.WEB_SEARCH_PRIMARY_BUDGET_MS || 1e4);
const SEARCH_SETTLE_WINDOW_MS = Number(process.env.WEB_SEARCH_SETTLE_WINDOW_MS || 50);
const NL = String.fromCharCode(10);
function envOr(name, fallback = "") {
  return process.env[name] || fallback;
}
function isSportsPredictionQuery(query) {
  return isEventPredictionQuery(query);
}
function enrichSportsPredictionQuery(query) {
  const q = String(query || "").trim();
  if (!isSportsPredictionQuery(q)) return q;
  const aliases = [];
  const aliasPairs = [
    [/英格兰/i, "England"],
    [/克罗地亚/i, "Croatia"],
    [/西班牙/i, "Spain"],
    [/法国/i, "France"],
    [/德国/i, "Germany"],
    [/巴西/i, "Brazil"],
    [/阿根廷/i, "Argentina"],
    [/葡萄牙/i, "Portugal"],
    [/荷兰/i, "Netherlands"],
    [/比利时/i, "Belgium"],
    [/世界杯|FIFA/i, "FIFA World Cup 2026"],
    [/NBA/i, "NBA"],
  ];
  for (const [pattern, value] of aliasPairs) {
    if (pattern.test(q) && !q.toLowerCase().includes(String(value).toLowerCase())) aliases.push(value);
  }
  const tail = "odds implied probability win probability prediction bookmaker Opta";
  return [q, ...aliases, tail].join(" ").replace(/\s+/g, " ").trim().slice(0, 220);
}
function enrichProductReleaseQuery(query) {
  const q = String(query || "").trim();
  if (!isProductReleaseOrVersionQuery(q)) return q;
  const additions = ["official release notes product page documentation version availability source"];
  if (/(?:^|\b)dgx\s+spark\b|英伟达.*DGX|NVIDIA.*DGX/i.test(q)) {
    additions.push("NVIDIA DGX Spark site:nvidia.com OR site:docs.nvidia.com OR site:marketplace.nvidia.com");
  } else if (/\bNVIDIA\b|英伟达|CUDA|RTX|DGX/i.test(q)) {
    additions.push("NVIDIA official site:nvidia.com docs.nvidia.com");
  }
  return [q, ...additions].join(" ").replace(/\s+/g, " ").trim().slice(0, 260);
}
function isOpenAIModelReleaseQuery(query) {
  const q = String(query || "");
  return /(?:OpenAI|ChatGPT|GPT|Codex)/i.test(q)
    && /(?:模型|model|发布|release|新模型|最新|最近|recent|latest)/i.test(q)
    && !/(?:怎么用|API\s*key|报错|配置|价格|pricing|账单|billing)/i.test(q);
}
function isAnthropicModelReleaseQuery(query) {
  const q = String(query || "");
  return /(?:Anthropic|Claude)/i.test(q)
    && /(?:模型|model|发布|release|新模型|最新|最近|recent|latest|公开|代)/i.test(q)
    && !/(?:怎么用|API\s*key|报错|配置|价格|pricing|账单|billing)/i.test(q);
}
function isOfficialModelReleaseQuery(query) {
  return isOpenAIModelReleaseQuery(query) || isAnthropicModelReleaseQuery(query);
}
function wantsSourceLinks(query) {
  return needsSourceGradeEvidence(query);
}
function configuredStructuredSource(source) {
  const entry = STRUCTURED_RACERS.find((r) => r.source === source);
  return !!entry && (!entry.optional || envOr(entry.envKey));
}
function preferredPrimarySource(query) {
  const override = String(envOr("WEB_SEARCH_PRIMARY_PROVIDER") || "").trim().toLowerCase();
  if (wantsSourceLinks(query) && configuredStructuredSource("mimo")) return "mimo";
  if (override && configuredStructuredSource(override)) return override;
  if (configuredStructuredSource("glm")) return "glm";
  if (configuredStructuredSource("mimo")) return "mimo";
  return "";
}
async function searchBocha(query, signal) {
  const key = envOr("BOCHA_KEY");
  if (!key) throw new Error("BOCHA_KEY missing");
  const resp = await fetch("https://api.bochaai.com/v1/web-search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
    body: JSON.stringify({ query, summary: true, count: 8 }),
    signal
  });
  if (!resp.ok) throw new Error("bocha HTTP " + resp.status);
  const data = await resp.json();
  const items = data?.data?.webPages?.value || [];
  if (!items.length) throw new Error("bocha empty");
  return items.map((it, i) => i + 1 + ". " + it.name + NL + "   " + it.url + NL + "   " + (it.snippet || it.summary || "").slice(0, 240)).join(NL);
}
async function searchTavily(query, signal) {
  const key = envOr("TAVILY_KEY");
  if (!key) throw new Error("TAVILY_KEY missing");
  const resp = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: key, query, search_depth: "basic", max_results: 8 }),
    signal
  });
  if (!resp.ok) throw new Error("tavily HTTP " + resp.status);
  const data = await resp.json();
  const items = data?.results || [];
  if (!items.length) throw new Error("tavily empty");
  return items.map((it, i) => i + 1 + ". " + it.title + NL + "   " + it.url + NL + "   " + (it.content || "").slice(0, 240)).join(NL);
}
async function searchSerper(query, signal) {
  const key = envOr("SERPER_KEY");
  if (!key) throw new Error("SERPER_KEY missing");
  const resp = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-KEY": key },
    body: JSON.stringify({ q: query, num: 8 }),
    signal
  });
  if (!resp.ok) throw new Error("serper HTTP " + resp.status);
  const data = await resp.json();
  const items = data?.organic || [];
  if (!items.length) throw new Error("serper empty");
  return items.map((it, i) => i + 1 + ". " + it.title + NL + "   " + it.link + NL + "   " + (it.snippet || "").slice(0, 240)).join(NL);
}
async function searchBochaStructured(query, signal) {
  const key = envOr("BOCHA_KEY");
  if (!key) throw new Error("BOCHA_KEY missing");
  const resp = await fetch("https://api.bochaai.com/v1/web-search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
    body: JSON.stringify({ query, summary: true, count: 8 }),
    signal
  });
  if (!resp.ok) throw new Error("bocha HTTP " + resp.status);
  const data = await resp.json();
  const raw = data?.data?.webPages?.value || [];
  if (raw.length === 0) throw new Error("bocha empty");
  const items = raw.map((it) => ({
    title: String(it.name || ""),
    url: String(it.url || ""),
    snippet: String(it.snippet || it.summary || "").slice(0, 240)
  }));
  return { items };
}
async function searchTavilyStructured(query, signal) {
  const key = envOr("TAVILY_KEY");
  if (!key) throw new Error("TAVILY_KEY missing");
  const resp = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: key, query, search_depth: "basic", max_results: 8 }),
    signal
  });
  if (!resp.ok) throw new Error("tavily HTTP " + resp.status);
  const data = await resp.json();
  const raw = data?.results || [];
  if (raw.length === 0) throw new Error("tavily empty");
  const items = raw.map((it) => ({
    title: String(it.title || ""),
    url: String(it.url || ""),
    snippet: String(it.content || "").slice(0, 240)
  }));
  return { items };
}
async function searchSerperStructured(query, signal) {
  const key = envOr("SERPER_KEY");
  if (!key) throw new Error("SERPER_KEY missing");
  const resp = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-KEY": key },
    body: JSON.stringify({ q: query, num: 8 }),
    signal
  });
  if (!resp.ok) throw new Error("serper HTTP " + resp.status);
  const data = await resp.json();
  const raw = data?.organic || [];
  if (raw.length === 0) throw new Error("serper empty");
  const items = raw.map((it) => ({
    title: String(it.title || ""),
    url: String(it.link || ""),
    snippet: String(it.snippet || "").slice(0, 240)
  }));
  return { items };
}
async function searchMimoStructured(query, signal) {
  const key = envOr("MIMO_SEARCH_KEY");
  if (!key) throw new Error("MIMO_SEARCH_KEY missing");
  const base = envOr("MIMO_SEARCH_BASE", "https://api.xiaomimimo.com/v1");
  const model = envOr("MIMO_SEARCH_MODEL", "mimo-v2-flash");
  const resp = await fetch(base + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-key": key, Authorization: "Bearer " + key },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: query }],
      tools: [{ type: "web_search", max_keyword: 3, force_search: true }],
      max_completion_tokens: 2e3,
      thinking: { type: "disabled" },
      stream: false
    }),
    signal
  });
  if (!resp.ok) throw new Error("mimo HTTP " + resp.status);
  const data = await resp.json();
  const msg = data.choices?.[0]?.message;
  if (!msg) throw new Error("mimo empty msg");
  const items = [];
  for (const ann of msg.annotations || []) {
    if (ann.type === "url_citation" && ann.url) {
      items.push({ title: String(ann.title || ""), url: String(ann.url), snippet: String(ann.summary || "").slice(0, 240) });
    }
  }
  const summary = String(msg.content || "").trim() || void 0;
  if (!items.length && !summary) throw new Error("mimo empty result");
  return { items, summary };
}
async function searchMimo(query, signal) {
  const { items, summary } = await searchMimoStructured(query, signal);
  const info = items.map((it, i) => i + 1 + ". " + it.title + NL + "   " + it.url + NL + "   " + it.snippet).join(NL);
  const out = (info || "") + (summary ? (info ? NL : "") + "\u6458\u8981: " + summary : "");
  if (!out.trim()) throw new Error("mimo empty result");
  return out.trim();
}
function usefulItems(items) {
  return (Array.isArray(items) ? items : []).filter((item) => String(item?.url || "").trim());
}
function hostnameOf(url) {
  try {
    return new URL(String(url || "")).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

const PRODUCT_QUERY_STOPWORDS = new Set([
  "latest",
  "current",
  "official",
  "source",
  "release",
  "releases",
  "notes",
  "note",
  "product",
  "page",
  "documentation",
  "docs",
  "version",
  "versions",
  "availability",
  "available",
  "shipping",
  "launch",
  "launched",
  "released",
  "update",
  "updates",
  "software",
  "driver",
  "drivers",
  "firmware",
]);

const OFFICIAL_PRODUCT_DOMAIN_PATTERNS = [
  /(^|\.)nvidia\.com$/i,
  /(^|\.)docs\.nvidia\.com$/i,
  /(^|\.)marketplace\.nvidia\.com$/i,
  /(^|\.)developer\.nvidia\.com$/i,
  /(^|\.)openai\.com$/i,
  /(^|\.)platform\.openai\.com$/i,
  /(^|\.)anthropic\.com$/i,
  /(^|\.)docs\.anthropic\.com$/i,
  /(^|\.)google\.com$/i,
  /(^|\.)deepmind\.google$/i,
  /(^|\.)microsoft\.com$/i,
  /(^|\.)apple\.com$/i,
  /(^|\.)python\.org$/i,
  /(^|\.)nodejs\.org$/i,
  /(^|\.)github\.com$/i,
  /(^|\.)gitee\.com$/i,
];

function productQueryTokens(query) {
  const q = String(query || "").toLowerCase();
  const tokens = [];
  for (const match of q.matchAll(/[a-z][a-z0-9.+-]{1,}/g)) {
    const token = match[0].replace(/^[.+-]+|[.+-]+$/g, "");
    if (token.length < 2 || PRODUCT_QUERY_STOPWORDS.has(token)) continue;
    tokens.push(token);
  }
  return [...new Set(tokens)].slice(0, 8);
}

function productItemText(item) {
  return [item?.title, item?.snippet, item?.summary, item?.url].map((v) => String(v || "")).join(" ").toLowerCase();
}

function isOfficialProductDomain(host) {
  return OFFICIAL_PRODUCT_DOMAIN_PATTERNS.some((pattern) => pattern.test(host));
}

function productItemRelevance(query, item) {
  const tokens = productQueryTokens(query);
  if (!tokens.length) return 0;
  const text = productItemText(item);
  const matched = tokens.filter((token) => text.includes(token));
  let score = matched.length * 20;
  const host = hostnameOf(item?.url);
  if (host && isOfficialProductDomain(host)) score += 50;
  if (/(release notes?|changelog|version|driver|firmware|documentation|docs|marketplace|buy now|available|shipping|download|产品页|官方|文档|发售|上市|开售|版本|更新)/i.test(text)) score += 12;
  if (/(资讯|广告|代理|解决方案|培训|历史沿革|基本资料|电脑配置|装机|科技有限公司|新闻中心|产品资讯)/i.test(text)) score -= 18;
  if (tokens.length >= 2 && matched.length < 2) score -= 60;
  return score;
}

function productSummaryIsRelevant(query, summary) {
  const tokens = productQueryTokens(query);
  if (!tokens.length) return true;
  const text = String(summary || "").toLowerCase();
  const matched = tokens.filter((token) => text.includes(token)).length;
  return tokens.length >= 2 ? matched >= 2 : matched >= 1;
}

function refineProductReleaseResultForQuery(query, value) {
  if (!isProductReleaseOrVersionQuery(query) || !value || !Array.isArray(value.items)) return value;
  const scored = value.items.map((item, index) => ({ item, index, score: productItemRelevance(query, item) }));
  const minScore = productQueryTokens(query).length >= 2 ? 25 : 20;
  const kept = scored
    .filter((entry) => entry.score >= minScore)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item);
  const summary = productSummaryIsRelevant(query, value.summary) ? value.summary : undefined;
  return { ...value, items: kept, summary };
}

function officialProductFallbackUrls(query) {
  const q = String(query || "");
  if (/(?:^|\b)DGX\s*Spark\b|英伟达.*DGX\s*Spark|NVIDIA.*DGX\s*Spark/i.test(q)) {
    return [
      "https://docs.nvidia.com/dgx/dgx-spark/release-notes.html",
      "https://marketplace.nvidia.com/en-us/enterprise/personal-ai-supercomputers/dgx-spark/",
      "https://www.nvidia.com/en-us/products/workstations/dgx-spark/",
    ];
  }
  return [];
}
function officialModelReleaseFallbackUrls(query) {
  const q = String(query || "");
  if (isOpenAIModelReleaseQuery(q)) {
    return [
      "https://openai.com/news/",
      "https://help.openai.com/en/articles/9624314-model-release-notes",
      "https://platform.openai.com/docs/models",
    ];
  }
  if (isAnthropicModelReleaseQuery(q)) {
    return [
      "https://docs.anthropic.com/en/docs/about-claude/models/overview",
      "https://www.anthropic.com/news",
      "https://docs.anthropic.com/en/release-notes/api",
    ];
  }
  return [];
}

function htmlToEvidenceSnippet(html) {
  const text = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
  const matches = [
    ...text.matchAll(/(?:June\s+2026|DGX\s+OS\s+\d+(?:\.\d+)+|GPU\s+Driver\s+\d+(?:\.\d+)+|CUDA\s+Toolkit\s+\d+(?:\.\d+)+|Release\s+Notes|Buy\s+Now|Personal\s+AI\s+Supercomputer|Grace\s+Blackwell)/gi),
  ].map((match) => match[0]);
  const unique = [...new Set(matches)].slice(0, 10);
  return (unique.length ? unique.join("; ") + ". " : "") + text.slice(0, 420);
}

function htmlToPlainEvidenceSnippet(html) {
  const text = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, 520);
}

function sanitizeOfficialModelEvidenceText(value) {
  return String(value || "")
    .replace(/\bGPT\s*-?\s*5\.(?:3|4|5)\b/gi, "[unverified-model-name-redacted]")
    .replace(/Claude\s+Fable\s+5|Fable\s+5|Claude\s+Mythos\s+5|Mythos\s+5|Mythos\s*级|神话级/gi, "[unverified-model-name-redacted]");
}

async function structuredOfficialModelReleaseFallback(query, previousSources, { log } = {}) {
  const urls = officialModelReleaseFallbackUrls(query);
  if (!urls.length) return null;
  const items = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8e3);
  try {
    for (const url of urls) {
      try {
        const resp = await fetch(url, {
          headers: { "User-Agent": "LynnBrain/0.85 source-grade evidence" },
          signal: controller.signal,
        });
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        const html = await resp.text();
        const title = sanitizeOfficialModelEvidenceText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim())
          || (url.includes("anthropic") ? "Anthropic official model page" : "OpenAI official model page");
        const snippet = sanitizeOfficialModelEvidenceText(htmlToPlainEvidenceSnippet(html));
        items.push({ title, url, snippet: snippet || "Official model page fetched, but no extractable snippet was available." });
      } catch (error) {
        items.push({
          title: url.includes("anthropic") ? "Anthropic official model source" : "OpenAI official model source",
          url,
          snippet: `Official entry point; Lynn could not fetch page content in this run (${error?.message || String(error)}). Do not infer a specific newest model from this candidate alone.`,
        });
        log && log("warn", "tool-exec/web_search official model fallback fetch failed url=" + url + " error=" + (error?.message || String(error)));
      }
    }
  } finally {
    clearTimeout(timer);
  }
  if (!items.length) return null;
  const summary = items
    .map((item) => `${item.title}: ${item.snippet}`)
    .join("\n")
    .replace(/\bGPT\s*-?\s*5\.(?:3|4|5)\b/gi, "[unverified-model-name-redacted]")
    .replace(/Claude\s+Fable\s+5|Fable\s+5|Claude\s+Mythos\s+5|Mythos\s+5|Mythos\s*级|神话级/gi, "[unverified-model-name-redacted]")
    .slice(0, 1800);
  log && log("info", "tool-exec/web_search_structured official model fallback q=" + query + " items=" + items.length);
  return {
    ok: true,
    query,
    evidencePolicy: classifySearchEvidencePolicy(query),
    provider: "official_model_fallback",
    items,
    summary,
    sources: [
      ...(Array.isArray(previousSources) ? previousSources : []),
      { name: "official_model_fallback", ok: true, items, summary },
    ],
  };
}

async function structuredOfficialProductFallback(query, previousSources, { log } = {}) {
  const urls = officialProductFallbackUrls(query);
  if (!urls.length) return null;
  const items = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8e3);
  try {
    for (const url of urls) {
      try {
        const resp = await fetch(url, {
          headers: { "User-Agent": "LynnBrain/0.85 source-grade evidence" },
          signal: controller.signal,
        });
        if (!resp.ok) {
          if (/marketplace\.nvidia\.com/i.test(url)) {
            items.push({
              title: "NVIDIA DGX Spark Marketplace",
              url,
              snippet: `Official NVIDIA marketplace page returned HTTP ${resp.status} to Lynn's server-side fetch; purchase status could not be verified from this run.`,
            });
            continue;
          }
          throw new Error("HTTP " + resp.status);
        }
        const html = await resp.text();
        const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim()
          || (url.includes("release-notes") ? "NVIDIA DGX Spark Release Notes" : "NVIDIA DGX Spark official page");
        const snippet = htmlToEvidenceSnippet(html);
        if (/DGX\s*Spark/i.test(`${title} ${snippet}`)) {
          items.push({ title, url, snippet: snippet.slice(0, 500) });
        }
      } catch (error) {
        log && log("warn", "tool-exec/web_search official product fallback failed url=" + url + " error=" + (error?.message || String(error)));
      }
    }
  } finally {
    clearTimeout(timer);
  }
  if (!items.length) return null;
  const summary = items.map((item) => `${item.title}: ${item.snippet}`).join("\n").slice(0, 1400);
  log && log("info", "tool-exec/web_search_structured official product fallback q=" + query + " items=" + items.length);
  return {
    ok: true,
    query,
    evidencePolicy: classifySearchEvidencePolicy(query),
    provider: "official_product_fallback",
    items,
    summary,
    sources: [
      ...(Array.isArray(previousSources) ? previousSources : []),
      { name: "official_product_fallback", ok: true, items, summary },
    ],
  };
}

function mergeOfficialProductFallback(query, base, official) {
  if (!official) return base;
  const baseItems = Array.isArray(base?.items) ? base.items : [];
  const officialItems = Array.isArray(official.items) ? official.items : [];
  const seen = new Set();
  const mergedItems = [];
  for (const item of [...officialItems, ...baseItems]) {
    const url = String(item?.url || "").trim();
    const key = url || `${item?.title || ""}:${item?.snippet || ""}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    mergedItems.push(item);
  }
  const summary = [official.summary, base?.summary].filter(Boolean).join("\n").slice(0, 1800);
  return {
    ...base,
    ok: true,
    query,
    evidencePolicy: classifySearchEvidencePolicy(query),
    provider: "official_product_fallback",
    items: mergedItems,
    summary,
    sources: [
      ...(Array.isArray(base?.sources) ? base.sources : []),
      ...(Array.isArray(official.sources) ? official.sources : []),
    ],
  };
}
const LOW_QUALITY_SPORTS_PREDICTION_DOMAINS = new Set([
  "cricinformers.com",
  "heavenlypredictions.com",
  "soccertips.ai",
]);
const PREFERRED_SPORTS_PREDICTION_DOMAINS = [
  /(^|\.)oddschecker\.com$/i,
  /(^|\.)theanalyst\.com$/i,
  /(^|\.)opta/i,
  /(^|\.)espn\.com$/i,
  /(^|\.)fifa\.com$/i,
  /(^|\.)uefa\.com$/i,
  /(^|\.)sofascore\.com$/i,
  /(^|\.)fotmob\.com$/i,
  /(^|\.)flashscore\./i,
  /(^|\.)sportsmole\.co\.uk$/i,
  /(^|\.)bettingexpert\.com$/i,
];
function scoreSportsPredictionItem(item) {
  const host = hostnameOf(item?.url);
  const text = [item?.title, item?.snippet, item?.summary, item?.url].map((v) => String(v || "")).join(" ");
  let score = 0;
  if (LOW_QUALITY_SPORTS_PREDICTION_DOMAINS.has(host)) score -= 100;
  if (PREFERRED_SPORTS_PREDICTION_DOMAINS.some((pattern) => pattern.test(host))) score += 60;
  if (/(odds|implied|probability|prediction|bookmaker|赔率|胜率|概率|盘口|让球)/i.test(text)) score += 20;
  if (/\b\d{1,2}(?:\.\d+)?%|\b\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?\b/.test(text)) score += 10;
  return score;
}
function refineStructuredResultForQuery(query, value) {
  const productRefined = refineProductReleaseResultForQuery(query, value);
  if (!isSportsPredictionQuery(query) || !productRefined || !Array.isArray(productRefined.items)) return productRefined;
  const scored = productRefined.items.map((item, index) => ({ item, index, score: scoreSportsPredictionItem(item) }));
  const nonLowQuality = scored.filter((entry) => entry.score > -50);
  const kept = (nonLowQuality.length ? nonLowQuality : scored)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item);
  return { ...productRefined, items: kept };
}
function shouldUseDirectSportsScoreboard(query) {
  const q = String(query || "");
  if (!isSportsScoreOrScheduleQuery(q) || isSportsPredictionQuery(q)) return false;
  return /(今晚|今夜|今天|今日|昨晚|昨天|昨日|明天|明日|已出|已经|比分|赛果|结果|完赛|半决赛|准决赛|四分之一决赛|八强|决赛|today|tonight|yesterday|tomorrow|score|result|final|semifinal|semi-final|quarterfinal)/i.test(q);
}
function isUsableStructuredResult(value) {
  const items = usefulItems(value?.items);
  const rawItems = (Array.isArray(value?.items) ? value.items : []).filter((item) => (
    String(item?.title || "").trim() || String(item?.snippet || item?.summary || "").trim()
  ));
  const summary = String(value?.summary || "").trim();
  return items.length >= 1 && summary.length > 0 || items.length >= 2 || rawItems.length >= 1 && summary.length > 0;
}
function requireUsableStructured(source, value) {
  if (!isUsableStructuredResult(value)) throw new Error(source + " unusable result");
  return value;
}
function requireUsableText(source, value) {
  const text = String(value || "").trim();
  if (!text) throw new Error(source + " empty result");
  return text;
}
async function raceUsableSources(racers, budgetMs, { settleWindowMs = SEARCH_SETTLE_WINDOW_MS } = {}) {
  const list = Array.isArray(racers) ? racers : [];
  if (!list.length) return [];
  return new Promise((resolve) => {
    let done = false;
    let pending = list.length;
    let success = 0;
    let settleTimer = null;
    const entries = [];
    const pendingSources = new Set(list.map((r) => r.source));
    function finish(reason) {
      if (done) return;
      done = true;
      clearTimeout(budgetTimer);
      clearTimeout(settleTimer);
      for (const source of pendingSources) {
        entries.push({
          source,
          ok: false,
          error: reason === "timeout" ? source + " timeout " + budgetMs + "ms" : source + " aborted after faster usable source answered"
        });
      }
      resolve(entries);
    }
    function scheduleFinish() {
      if (done || settleTimer) return;
      if (settleWindowMs <= 0) {
        finish("settled");
        return;
      }
      settleTimer = setTimeout(() => finish("settled"), settleWindowMs);
    }
    const budgetTimer = setTimeout(() => finish("timeout"), budgetMs);
    list.forEach(({ source, fn }) => {
      Promise.resolve().then(() => fn()).then(
        (value) => ({ source, ok: true, value }),
        (error) => ({ source, ok: false, error: error?.message || String(error) })
      ).then((entry) => {
        if (done) return;
        pendingSources.delete(source);
        entries.push(entry);
        pending--;
        if (entry.ok) success++;
        if (pending === 0) finish("all");
        else if (success > 0) scheduleFinish();
      });
    });
  });
}
async function searchGlmWebStructured(query, signal) {
  const key = envOr("ZHIPU_KEY");
  if (!key) throw new Error("ZHIPU_KEY missing");
  const engine = envOr("ZHIPU_SEARCH_ENGINE", "search_std");
  const resp = await fetch("https://open.bigmodel.cn/api/paas/v4/web_search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
    body: JSON.stringify({ search_query: String(query || "").slice(0, 70), search_engine: engine, count: 10, search_recency_filter: "oneWeek", content_size: "high" }),
    signal
  });
  if (!resp.ok) throw new Error("glm-search HTTP " + resp.status);
  const data = await resp.json();
  if (data.error) throw new Error("glm-search " + JSON.stringify(data.error).slice(0, 80));
  const sr = (Array.isArray(data.search_result) ? data.search_result : []).filter((x) => String(x.content || "").trim());
  if (!sr.length) throw new Error("glm-search empty result");
  const items = sr.map((x) => ({ title: String(x.title || ""), url: String(x.link || "").trim(), snippet: String(x.content || "").slice(0, 240) }));
  const summary = sr.slice(0, 5).map((x) => String(x.title || "").trim() + (x.publish_date ? "(" + x.publish_date + ")" : "") + "：" + String(x.content || "").replace(/\s+/g, " ").slice(0, 220)).join("\n");
  return { items, summary };
}

const STRUCTURED_RACERS = [
  { source: "mimo", fn: (q, s) => searchMimoStructured(q, s), optional: true, envKey: "MIMO_SEARCH_KEY" },
  { source: "glm", fn: (q, s) => searchGlmWebStructured(q, s), optional: true, envKey: "ZHIPU_KEY" },
  { source: "bocha", fn: (q, s) => searchBochaStructured(q, s), optional: true, envKey: "BOCHA_KEY" },
  { source: "tavily", fn: (q, s) => searchTavilyStructured(q, s), optional: true, envKey: "TAVILY_KEY" },
  { source: "serper", fn: (q, s) => searchSerperStructured(q, s), optional: true, envKey: "SERPER_KEY" }
];
async function webSearchStructured(query, { log } = {}) {
  const rawQuery = String(query || "").trim();
  const q = normalizeSearchQueryIntent(rawQuery);
  if (!q) return { ok: false, error: "empty query", sources: [] };
  const cached = structuredCache.get(q.toLowerCase());
  if (cached) {
    log && log("info", "tool-exec/web_search_structured cache HIT q=" + q);
    return cached;
  }
  if (shouldUseDirectSportsScoreboard(q)) {
    const sportsDirect = await structuredSportsScoreFallback(q, [], { log });
    if (sportsDirect) {
      structuredCache.set(q.toLowerCase(), sportsDirect);
      return sportsDirect;
    }
  }
  if (isOfficialModelReleaseQuery(q)) {
    const officialModel = await structuredOfficialModelReleaseFallback(q, [], { log });
    if (officialModel) {
      structuredCache.set(q.toLowerCase(), officialModel);
      return officialModel;
    }
  }
  const ctrl = new AbortController();
  const providerQuery = isSportsPredictionQuery(q)
    ? enrichSportsPredictionQuery(q)
    : isProductReleaseOrVersionQuery(q)
      ? enrichProductReleaseQuery(q)
    : enrichEvidenceSearchQuery(q);
  const primarySource = preferredPrimarySource(q);
  const primaryRacers = STRUCTURED_RACERS.filter((r) => r.source === primarySource).filter((r) => !r.optional || envOr(r.envKey)).map((r) => ({
    source: r.source,
    fn: () => r.fn(providerQuery, ctrl.signal).then((value) => requireUsableStructured(r.source, refineStructuredResultForQuery(q, value)))
  }));
  log && log("info", "tool-exec/web_search_structured primary race q=" + q + (rawQuery && rawQuery !== q ? " raw_q=" + rawQuery : "") + (providerQuery !== q ? " provider_q=" + providerQuery : "") + " racers=" + primaryRacers.map((r) => r.source).join(","));
  let settled = await raceUsableSources(primaryRacers, PRIMARY_SEARCH_BUDGET_MS);
  let anyOk = settled.some((s) => s.ok);
  if (!anyOk) {
    const fallbackCtrl = new AbortController();
    ctrl.abort();
    const fallbackRacers = STRUCTURED_RACERS.filter((r) => r.source !== primarySource).filter((r) => !r.optional || envOr(r.envKey)).map((r) => ({
      source: r.source,
      fn: () => r.fn(providerQuery, fallbackCtrl.signal).then((value) => requireUsableStructured(r.source, refineStructuredResultForQuery(q, value)))
    }));
    log && log("info", "tool-exec/web_search_structured fallback race q=" + q + " racers=" + fallbackRacers.map((r) => r.source).join(","));
    const fallbackSettled = await raceUsableSources(fallbackRacers, BUDGET_MS);
    fallbackCtrl.abort();
    settled = [...settled, ...fallbackSettled];
    anyOk = settled.some((s) => s.ok);
  } else {
    ctrl.abort();
  }
  const sources = settled.map((s) => ({
    name: s.source,
    ok: s.ok,
    error: s.ok ? void 0 : s.error,
    items: s.ok && Array.isArray(s.value?.items) ? s.value.items : [],
    summary: s.ok && s.value?.summary ? s.value.summary : void 0
  }));
  const officialFallback = officialProductFallbackUrls(q).length
    ? await structuredOfficialProductFallback(q, sources, { log })
    : null;
  if (!anyOk) {
    if (officialFallback) {
      structuredCache.set(q.toLowerCase(), officialFallback);
      return officialFallback;
    }
    if (isSportsScoreOrScheduleQuery(q)) {
      const sportsFallback = await structuredSportsScoreFallback(q, sources, { log });
      if (sportsFallback) {
        structuredCache.set(q.toLowerCase(), sportsFallback);
        return sportsFallback;
      }
    }
    log && log("warn", "tool-exec/web_search_structured all racers failed");
    return { ok: false, error: "all search sources failed", sources };
  }
  const primary = sources.find((s) => s.ok);
  const seenUrls = /* @__PURE__ */ new Set();
  const mergedItems = [];
  for (const s of sources) {
    if (!s.ok) continue;
    for (const item of s.items) {
      const url = String(item.url || "").trim();
      if (!url || seenUrls.has(url)) continue;
      seenUrls.add(url);
      mergedItems.push(item);
    }
  }
  const result = {
    ok: true,
    query: q,
    evidencePolicy: classifySearchEvidencePolicy(q),
    provider: primary.name,
    items: mergedItems,
    summary: primary.summary,
    sources
  };
  if (officialFallback) {
    const mergedOfficial = mergeOfficialProductFallback(q, result, officialFallback);
    log && log("info", "tool-exec/web_search_structured merged official product fallback q=" + q + " items=" + mergedOfficial.items.length);
    structuredCache.set(q.toLowerCase(), mergedOfficial);
    return mergedOfficial;
  }
  log && log("info", "tool-exec/web_search_structured " + sources.filter((s) => s.ok).length + "/" + sources.length + " OK, primary=" + primary.name + " items=" + mergedItems.length);
  structuredCache.set(q.toLowerCase(), result);
  return result;
}
async function structuredSportsScoreFallback(query, previousSources, { log } = {}) {
  try {
    const text = await sportsScore(query);
    const trimmed = String(text || "").trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed?.error || parsed?.status === "no_direct_source" || parsed?.status === "no_score_events") return null;
    } catch {
      // formatted sports evidence
    }
    if (!/^provider:\s*espn_scoreboard/im.test(trimmed)) return null;
    const source = trimmed.match(/^source:\s*(.+)$/im)?.[1]?.trim() || "https://site.api.espn.com/";
    const item = {
      title: "ESPN scoreboard",
      url: source,
      snippet: trimmed.replace(/\s+/g, " ").slice(0, 240)
    };
    log && log("info", "tool-exec/web_search_structured sports fallback source=espn_scoreboard q=" + query);
    return {
      ok: true,
      query,
      evidencePolicy: classifySearchEvidencePolicy(query),
      provider: "espn_scoreboard",
      items: [item],
      summary: trimmed,
      sources: [
        ...(Array.isArray(previousSources) ? previousSources : []),
        { name: "espn_scoreboard", ok: true, items: [item], summary: trimmed }
      ]
    };
  } catch (error) {
    log && log("warn", "tool-exec/web_search_structured sports fallback failed: " + (error?.message || String(error)));
    return null;
  }
}
function formatStructuredSearchForTool(result, query) {
  if (!result || result.ok === false) {
    return JSON.stringify(result || { error: "all search sources failed" });
  }
  const lines = [];
  const policyHint = buildEvidencePolicyHint(query || result.query || "");
  if (policyHint) {
    lines.push(policyHint);
    lines.push("");
  }
  if (result.provider) lines.push("provider: " + result.provider);
  if (result.summary) lines.push("\u6458\u8981: " + String(result.summary).trim());
  const items = usefulItems(result.items).slice(0, 8);
  if (items.length) {
    if (lines.length) lines.push("");
    lines.push("\u641C\u7D22\u7ED3\u679C:");
    items.forEach((item, index) => {
      lines.push(index + 1 + ". " + String(item.title || item.url || "source").trim());
      lines.push("   " + String(item.url || "").trim());
      const snippet = String(item.snippet || item.summary || "").replace(/\s+/g, " ").trim();
      if (snippet) lines.push("   " + snippet.slice(0, 240));
    });
    if (isProductReleaseOrVersionQuery(query || result.query || "")) {
      lines.push("");
      lines.push("\u6700\u7EC8\u56DE\u7B54\u5FC5\u987B\u663E\u5F0F\u5217\u51FA\u4E0A\u65B9\u53EF\u7528\u7684\u5B98\u65B9 URL\uFF0C\u4E0D\u8981\u53EA\u5199\u201C\u5B98\u65B9\u6587\u6863\u201D\u6216\u201C\u5B98\u65B9\u4EA7\u54C1\u9875\u201D\u3002");
    }
  } else if (result.provider === "glm" && result.summary) {
    if (lines.length) lines.push("");
    lines.push("\u6765\u6E90\u8BF4\u660E: GLM Web Search \u672A\u8FD4\u56DE\u53EF\u70B9\u51FB\u539F\u6587\u94FE\u63A5;\u4E0A\u65B9\u6458\u8981\u53EA\u80FD\u4F5C\u4E3A\u641C\u7D22\u7EBF\u7D22,\u6536\u8D39/\u4EBA\u6570/\u9884\u6D4B\u7B49\u53E3\u5F84\u9700\u4F18\u5148\u4F7F\u7528\u5E26\u94FE\u63A5\u6765\u6E90\u590D\u6838\u3002");
  }
  const sourceStatus = (Array.isArray(result.sources) ? result.sources : []).map((source) => {
    const name = String(source?.name || "source");
    if (source?.ok) {
      const sourceItems = usefulItems(source.items || []);
      const summaryOnly = name === "glm" && !sourceItems.length && source?.summary;
      return name + "\u2713" + (summaryOnly ? "(\u6458\u8981\u65E0\u539F\u6587\u94FE\u63A5)" : "");
    }
    const error = String(source?.error || "").trim();
    return name + "\u2717" + (error ? "(" + error.slice(0, 120) + ")" : "");
  }).filter(Boolean);
  if (sourceStatus.length) {
    if (lines.length) lines.push("");
    lines.push("\u6765\u6E90\u72B6\u6001: " + sourceStatus.join(" \xB7 "));
  }
  return lines.join(NL).trim() || JSON.stringify(result);
}
async function webSearch(query, { log } = {}) {
  const q = normalizeSearchQueryIntent(query);
  if (!q) return JSON.stringify({ error: "empty query" });
  const cached = cache.get(q.toLowerCase());
  if (cached) {
    log && log("info", "tool-exec/web_search cache HIT q=" + q);
    return cached;
  }
  const structured = await webSearchStructured(q, { log });
  const formatted = formatStructuredSearchForTool(structured, q);
  cache.set(q.toLowerCase(), formatted);
  return formatted;
}
const __testing__ = {
  searchBocha,
  searchTavily,
  searchSerper,
  searchMimo,
  cache,
  searchBochaStructured,
  searchTavilyStructured,
  searchSerperStructured,
  searchMimoStructured,
  searchGlmWebStructured,
  structuredCache,
  formatStructuredSearchForTool,
  normalizeSearchQueryIntent,
  classifySearchEvidencePolicy,
  isSportsScoreOrScheduleQuery,
  buildEvidencePolicyHint,
  needsSourceGradeEvidence
};
export {
  __testing__,
  searchMimo,
  searchMimoStructured,
  webSearch,
  webSearchStructured
};
