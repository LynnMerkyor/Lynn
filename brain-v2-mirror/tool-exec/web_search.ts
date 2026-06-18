// @ts-nocheck
// Brain v2 · web_search tool
// Search chain: GLM Web Search primary for speed/freshness, MiMo fallback for full source links.
import { makeLruCache } from "./_helpers.js";
const cache = makeLruCache(200, 5 * 60 * 1e3);
const structuredCache = makeLruCache(200, 5 * 60 * 1e3);
const BUDGET_MS = 14e3;
const PRIMARY_SEARCH_BUDGET_MS = Number(process.env.WEB_SEARCH_PRIMARY_BUDGET_MS || 1e4);
const SEARCH_SETTLE_WINDOW_MS = Number(process.env.WEB_SEARCH_SETTLE_WINDOW_MS || 50);
const NL = String.fromCharCode(10);
function envOr(name, fallback = "") {
  return process.env[name] || fallback;
}
function needsSourceGradeEvidence(query) {
  return /(私董会|会费|收费标准|人数规模|会员人数|主要(?:私董会|机构|协会|商会)|机构(?:名单|对比|收费|人数)|预测|概率|赔率|夺冠(?:概率|热门)?|榜单|排名)/i.test(String(query || ""));
}
function normalizeSearchQueryIntent(query) {
  const q = String(query || "").trim();
  if (!q) return q;
  if (!/世纪杯/.test(q)) return q;
  if (/(?:新世纪杯|21世纪杯|二十一世纪杯|世纪杯(?:英语|演讲|作文|龙舟|朗诵|竞赛|活动|赛事))/.test(q)) return q;
  if (!/(?:今晚|今夜|今天|今日|明天|昨晚|昨天|比赛|赛程|比分|赛果|小组赛|决赛|半决赛|足球|球队|对阵|夺冠|胜率|预测|world cup|fifa)/i.test(q)) return q;
  return q.replace(/世纪杯/g, "世界杯");
}
function isSportsPredictionQuery(query) {
  const q = String(query || "");
  return /(胜率|预测|概率|赔率|盘口|让球|夺冠|热门|odds|prediction|probability|forecast|betting)/i.test(q) &&
    /(世界杯|足球|英格兰|克罗地亚|西班牙|法国|德国|巴西|阿根廷|葡萄牙|荷兰|意大利|比利时|NBA|总决赛|决赛|半决赛|football|soccer|world cup|fifa|nba|finals|england|croatia|spain|france|germany|brazil|argentina|portugal|netherlands|belgium)/i.test(q);
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
function wantsSourceLinks(query) {
  const q = String(query || "");
  return /(官方|官网|来源|出处|引用|参考|链接|原文|source|citation|reference|official|link)/i.test(q) || needsSourceGradeEvidence(q);
}
function configuredStructuredSource(source) {
  const entry = STRUCTURED_RACERS.find((r) => r.source === source);
  return !!entry && (!entry.optional || envOr(entry.envKey));
}
function preferredPrimarySource(query) {
  const override = String(envOr("WEB_SEARCH_PRIMARY_PROVIDER") || "").trim().toLowerCase();
  if (override && configuredStructuredSource(override)) return override;
  if (wantsSourceLinks(query) && configuredStructuredSource("mimo")) return "mimo";
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
  if (!isSportsPredictionQuery(query) || !value || !Array.isArray(value.items)) return value;
  const scored = value.items.map((item, index) => ({ item, index, score: scoreSportsPredictionItem(item) }));
  const nonLowQuality = scored.filter((entry) => entry.score > -50);
  const kept = (nonLowQuality.length ? nonLowQuality : scored)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item);
  return { ...value, items: kept };
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
  const ctrl = new AbortController();
  const providerQuery = enrichSportsPredictionQuery(q);
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
  if (!anyOk) {
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
    provider: primary.name,
    items: mergedItems,
    summary: primary.summary,
    sources
  };
  log && log("info", "tool-exec/web_search_structured " + sources.filter((s) => s.ok).length + "/" + sources.length + " OK, primary=" + primary.name + " items=" + mergedItems.length);
  structuredCache.set(q.toLowerCase(), result);
  return result;
}
function formatStructuredSearchForTool(result) {
  if (!result || result.ok === false) {
    return JSON.stringify(result || { error: "all search sources failed" });
  }
  const lines = [];
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
  const formatted = formatStructuredSearchForTool(structured);
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
  normalizeSearchQueryIntent
};
export {
  __testing__,
  searchMimo,
  searchMimoStructured,
  webSearch,
  webSearchStructured
};
