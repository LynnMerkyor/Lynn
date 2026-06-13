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
function wantsSourceLinks(query) {
  return /(官方|官网|来源|出处|引用|参考|链接|原文|source|citation|reference|official|link)/i.test(String(query || ""));
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
function isUsableStructuredResult(value) {
  const items = usefulItems(value?.items);
  const summary = String(value?.summary || "").trim();
  return items.length >= 1 && summary.length > 0 || items.length >= 2;
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
  const items = sr.map((x) => ({ title: String(x.title || ""), url: String(x.link || "").trim() || ("https://www.baidu.com/s?wd=" + encodeURIComponent(String(x.title || "").slice(0, 40))), snippet: String(x.content || "").slice(0, 240) }));
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
  const q = String(query || "").trim();
  if (!q) return { ok: false, error: "empty query", sources: [] };
  const cached = structuredCache.get(q.toLowerCase());
  if (cached) {
    log && log("info", "tool-exec/web_search_structured cache HIT q=" + q);
    return cached;
  }
  const ctrl = new AbortController();
  const primarySource = preferredPrimarySource(q);
  const primaryRacers = STRUCTURED_RACERS.filter((r) => r.source === primarySource).filter((r) => !r.optional || envOr(r.envKey)).map((r) => ({
    source: r.source,
    fn: () => r.fn(q, ctrl.signal).then((value) => requireUsableStructured(r.source, value))
  }));
  log && log("info", "tool-exec/web_search_structured primary race q=" + q + " racers=" + primaryRacers.map((r) => r.source).join(","));
  let settled = await raceUsableSources(primaryRacers, PRIMARY_SEARCH_BUDGET_MS);
  let anyOk = settled.some((s) => s.ok);
  if (!anyOk) {
    const fallbackCtrl = new AbortController();
    ctrl.abort();
    const fallbackRacers = STRUCTURED_RACERS.filter((r) => r.source !== primarySource).filter((r) => !r.optional || envOr(r.envKey)).map((r) => ({
      source: r.source,
      fn: () => r.fn(q, fallbackCtrl.signal).then((value) => requireUsableStructured(r.source, value))
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
  }
  const sourceStatus = (Array.isArray(result.sources) ? result.sources : []).map((source) => {
    const name = String(source?.name || "source");
    if (source?.ok) return name + "\u2713";
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
  const q = String(query || "").trim();
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
  formatStructuredSearchForTool
};
export {
  __testing__,
  searchMimo,
  searchMimoStructured,
  webSearch,
  webSearchStructured
};
