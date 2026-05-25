/**
 * realtime-info.js — lightweight realtime lookup tools.
 *
 * These are intentionally local-first wrappers around public search/fetch
 * paths. They keep common daily queries from falling through to heavyweight
 * SKILL.md workflows.
 */

import { Type } from "@sinclair/typebox";
import { getLocale } from "../../server/i18n.js";
import { runSearchQuery } from "./web-search.js";
import { fetchWebContent } from "./web-fetch.js";

const SEARCH_LIMIT = 5;
const FETCH_LIMIT = 2200;
const NEWS_RSS_TIMEOUT_MS = 9000;

function isZhLocale() {
  return String(getLocale?.() || "").toLowerCase().startsWith("zh");
}

function zhOrEn(zh, en) {
  return isZhLocale() ? zh : en;
}

function compactLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeWeatherLocationToken(value) {
  return compactLine(value)
    .replace(/^(?:请|帮我|麻烦|顺便|再|同时|一起|以及|还有|然后|顺手|看一下|看下|查一下|查查|搜一下|搜索|查询)\s*/g, "")
    .replace(/^(?:今天|今日|明天|后天|今晚|今早|今天早上|明早|明天早上|下午|上午|中午|夜间|晚上|白天|夜里)\s*/g, "")
    .replace(/\s*(?:白天|早上|上午|下午|晚上|夜间|夜里)\s*$/g, "")
    .replace(/\s*(?:今天|今日|明天|后天|今晚|今早|明早|下午|上午|中午|夜间|晚上|白天|夜里)$/g, "")
    .replace(/\s*(?:天气|气温|温度|预报|多少度|几度|冷不冷|热不热)\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const WEATHER_CODE_ZH = new Map([
  [0, "晴"], [1, "大部晴朗"], [2, "局部多云"], [3, "阴"],
  [45, "雾"], [48, "雾凇"],
  [51, "小毛毛雨"], [53, "毛毛雨"], [55, "较强毛毛雨"],
  [56, "冻毛毛雨"], [57, "较强冻毛毛雨"],
  [61, "小雨"], [63, "中雨"], [65, "大雨"],
  [66, "冻雨"], [67, "较强冻雨"],
  [71, "小雪"], [73, "中雪"], [75, "大雪"],
  [77, "米雪"],
  [80, "小阵雨"], [81, "阵雨"], [82, "强阵雨"],
  [85, "小阵雪"], [86, "强阵雪"],
  [95, "雷暴"], [96, "雷暴伴小冰雹"], [99, "雷暴伴冰雹"],
]);

function weatherCodeText(code) {
  const n = Number(code);
  return WEATHER_CODE_ZH.get(n) || `天气代码 ${code}`;
}

const WTTR_DESC_ZH = new Map([
  ["Sunny", "晴"],
  ["Clear", "晴"],
  ["Partly cloudy", "局部多云"],
  ["Cloudy", "多云"],
  ["Overcast", "阴"],
  ["Mist", "薄雾"],
  ["Fog", "雾"],
  ["Patchy rain nearby", "附近有零星小雨"],
  ["Patchy light rain", "零星小雨"],
  ["Light rain", "小雨"],
  ["Light rain shower", "小阵雨"],
  ["Moderate or heavy rain shower", "阵雨"],
  ["Rain shower", "阵雨"],
  ["Shower", "阵雨"],
  ["Moderate rain", "中雨"],
  ["Heavy rain", "大雨"],
  ["Light drizzle", "小毛毛雨"],
  ["Thundery outbreaks in nearby", "附近有雷雨"],
  ["Patchy snow nearby", "附近有零星小雪"],
  ["Light snow", "小雪"],
]);

function localizeWttrDesc(value) {
  const text = compactLine(value);
  if (!text) return "";
  if (!isZhLocale()) return text;
  return WTTR_DESC_ZH.get(text) || text;
}

function forecastDayLabel(index) {
  const labels = isZhLocale()
    ? ["今天", "明天", "后天", "大后天"]
    : ["today", "tomorrow", "day after tomorrow"];
  return labels[index] || (isZhLocale() ? `${index}天后` : `in ${index} days`);
}

function parseWeatherDayCount(text) {
  const value = compactLine(text);
  const digit = value.match(/(?:未来|接下来|往后|之后|后面)\s*(\d{1,2})\s*天/);
  if (digit) return Math.max(1, Math.min(7, Number(digit[1])));
  const zhDigits = new Map([
    ["一", 1], ["二", 2], ["两", 2], ["俩", 2], ["三", 3], ["四", 4], ["五", 5], ["六", 6], ["七", 7],
  ]);
  const zh = value.match(/(?:未来|接下来|往后|之后|后面)\s*([一二两俩三四五六七])\s*天/);
  return zh ? zhDigits.get(zh[1]) : null;
}

function resolveWeatherForecastWindow(query = "") {
  const text = compactLine(query);
  if (/明后天|明天.*后天|后天.*明天/.test(text)) {
    return { startIndex: 1, days: 2, targeted: true, label: zhOrEn("明天和后天", "tomorrow and the day after tomorrow") };
  }
  if (/后天/.test(text)) {
    return { startIndex: 2, days: 1, targeted: true, label: zhOrEn("后天", "the day after tomorrow") };
  }
  if (/明天/.test(text)) {
    return { startIndex: 1, days: 1, targeted: true, label: zhOrEn("明天", "tomorrow") };
  }
  const dayCount = parseWeatherDayCount(text);
  if (dayCount) {
    const includesToday = /(?:含今天|包括今天|从今天|今天起|今起|今日起)/.test(text);
    return {
      startIndex: includesToday ? 0 : 1,
      days: dayCount,
      targeted: true,
      label: includesToday
        ? zhOrEn(`未来${dayCount}天（含今天）`, `next ${dayCount} days including today`)
        : zhOrEn(`未来${dayCount}天（不含今天）`, `next ${dayCount} days excluding today`),
    };
  }
  return { startIndex: 0, days: 3, targeted: false, label: zhOrEn("未来三天", "Next days") };
}

function formatForecastSection(lines, window) {
  const safeWindow = window || resolveWeatherForecastWindow("");
  const selected = lines.slice(safeWindow.startIndex, safeWindow.startIndex + safeWindow.days);
  const body = (selected.length ? selected : lines.slice(0, 3)).join("\n");
  if (!body) return "";
  if (!safeWindow.targeted) return `\n${safeWindow.label}\n${body}`;
  const title = zhOrEn(
    `问题匹配日期：${safeWindow.label}`,
    `Dates matching the question: ${safeWindow.label}`,
  );
  const note = zhOrEn(
    safeWindow.startIndex > 0 ? "（已按用户问题排除今天）" : "（已按用户问题包含今天）",
    safeWindow.startIndex > 0 ? "(today excluded per the question)" : "(today included per the question)",
  );
  return `\n${title}${note}\n${body}`;
}

function weatherLooksRainyText(text) {
  return /雨|阵雨|雷暴|雷雨|毛毛雨|rain|shower|storm|drizzle/i.test(String(text || ""));
}

function openMeteoCodeLooksRainy(code) {
  const n = Number(code);
  return (n >= 51 && n <= 67) || (n >= 80 && n <= 82) || (n >= 95 && n <= 99);
}

function formatRainHint({ desc = "", code = null, precipitationProbability = null, precipitation = null } = {}) {
  const probability = Number(precipitationProbability);
  const amount = Number(precipitation);
  const rainy = weatherLooksRainyText(desc)
    || openMeteoCodeLooksRainy(code)
    || (Number.isFinite(probability) && probability >= 40)
    || (Number.isFinite(amount) && amount > 0);
  return zhOrEn(
    `降雨判断: ${rainy ? "有降雨可能" : "未显示明显降雨"}`,
    `Rain: ${rainy ? "possible" : "not clearly indicated"}`,
  );
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function stripHtml(value) {
  return decodeHtml(value).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function hostname(url) {
  try {
    return new URL(String(url || "")).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

function timeoutSignal(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}

function extractXmlTag(xml, tag) {
  const match = String(xml || "").match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? decodeHtml(match[1]) : "";
}

function extractSourceFromItemXml(xml) {
  const match = String(xml || "").match(/<source\s+url="([^"]*)"[^>]*>([\s\S]*?)<\/source>/i);
  if (!match) return { name: "", url: "" };
  return {
    name: decodeHtml(match[2]),
    url: decodeHtml(match[1]),
  };
}

function isRecentPubDate(pubDate, maxAgeHours = 36) {
  const ts = Date.parse(pubDate || "");
  if (!Number.isFinite(ts)) return false;
  const ageMs = Date.now() - ts;
  return ageMs >= -60 * 60 * 1000 && ageMs <= maxAgeHours * 60 * 60 * 1000;
}

function buildNewsRssQuery(query) {
  const text = compactLine(query);
  const terms = [];
  const addIf = (pattern, term) => {
    if (pattern.test(text) && !terms.includes(term)) terms.push(term);
  };

  addIf(/AI|人工智能/i, "AI");
  addIf(/科技|技术/i, "科技");
  addIf(/大模型|模型|LLM/i, "大模型");
  addIf(/OpenAI/i, "OpenAI");
  addIf(/Anthropic|Claude/i, "Anthropic Claude");
  addIf(/Gemini|Google|谷歌/i, "Google Gemini");
  addIf(/芯片|半导体|算力|GPU/i, "AI 芯片");
  addIf(/机器人|具身/i, "机器人");
  addIf(/美伊|伊朗|中东/i, "美伊 中东");
  addIf(/俄乌|俄罗斯|乌克兰/i, "俄乌");
  addIf(/关税|制裁/i, "关税 制裁");
  addIf(/股市|市场|财经/i, "市场");
  addIf(/干细胞|细胞治疗|再生医学|临床|医疗|医药|医院|药企/i, "干细胞 细胞治疗 再生医学");

  if (terms.length) return terms.join(" ");
  return text
    .replace(/(?:请|帮我|给我|查询|搜索|今天|今日|最新|实时|消息|新闻|报道|每条|包含|发生日期|来源链接|为什么重要|领域|重要|条|[0-9０-９]+)/g, " ")
    .replace(/[，。、“”‘’：:；;,.!?？/\\|()[\]{}<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "今日 热点";
}

async function fetchGoogleNewsRss(query, maxResults = SEARCH_LIMIT, opts = {}) {
  const timer = timeoutSignal(NEWS_RSS_TIMEOUT_MS);
  try {
    const days = Math.max(1, Math.min(30, Number(opts.days || 1)));
    const maxAgeHours = Number(opts.maxAgeHours || (days * 24 + 12));
    const windowLabel = opts.windowLabel || (days <= 1 ? zhOrEn("今日/最近36小时", "today / last 36h") : zhOrEn(`最近${days}天`, `last ${days} days`));
    const rawQuery = buildNewsRssQuery(query) || "科技 AI";
    const rssQuery = /\bwhen:\d+d\b/i.test(rawQuery) ? rawQuery : `${rawQuery} when:${days}d`;
    const params = new URLSearchParams({
      q: rssQuery,
      hl: "zh-CN",
      gl: "CN",
      ceid: "CN:zh-Hans",
    });
    const url = `https://news.google.com/rss/search?${params.toString()}`;
    const resp = await fetch(url, {
      signal: timer.signal,
      headers: { "User-Agent": "Lynn/LiveNewsRSS" },
    });
    if (!resp.ok) throw new Error(`Google News RSS ${resp.status}`);
    const xml = await resp.text();
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)]
      .map((match) => {
        const itemXml = match[1] || "";
        const source = extractSourceFromItemXml(itemXml);
        const title = stripHtml(extractXmlTag(itemXml, "title"));
        const link = decodeHtml(extractXmlTag(itemXml, "link"));
        const pubDate = decodeHtml(extractXmlTag(itemXml, "pubDate"));
        const snippet = stripHtml(extractXmlTag(itemXml, "description"));
        return {
          title,
          url: link,
          snippet,
          pubDate,
          source: source.name,
          sourceUrl: source.url,
          windowLabel,
          windowDays: days,
        };
      })
      .filter((item) => item.title && item.url && isRecentPubDate(item.pubDate, maxAgeHours));
    return items.slice(0, maxResults);
  } finally {
    timer.clear();
  }
}

function formatSearchResults(title, query, provider, results) {
  const rows = results.map((result, index) => {
    const host = hostname(result.url);
    return [
      `${index + 1}. ${result.title || result.url}`,
      host ? `${zhOrEn("来源", "Source")}: ${host}` : "",
      result.windowLabel ? `${zhOrEn("检索窗口", "Search window")}: ${result.windowLabel}` : "",
      result.freshness ? `${zhOrEn("新鲜度", "Freshness")}: ${result.freshness}` : "",
      result.url,
      result.snippet ? `- ${compactLine(result.snippet)}` : "",
      result.fetchedText ? `- ${zhOrEn("正文摘录", "Fetched excerpt")}: ${compactLine(result.fetchedText).slice(0, 520)}` : "",
    ].filter(Boolean).join("\n");
  }).join("\n\n");

  return [
    `${title} (${provider})`,
    `${zhOrEn("查询", "Query")}: ${query}`,
    "",
    rows,
  ].join("\n");
}

function formatNewsRssResults(query, results, opts = {}) {
  const rows = results.map((result, index) => {
    const published = result.pubDate ? new Date(result.pubDate).toISOString().replace("T", " ").replace(".000Z", " UTC") : "";
    return [
      `${index + 1}. ${result.title}`,
      result.source ? `${zhOrEn("来源", "Source")}: ${result.source}` : "",
      result.sourceUrl ? `${zhOrEn("来源站点", "Source site")}: ${result.sourceUrl}` : "",
      result.windowLabel ? `${zhOrEn("检索窗口", "Search window")}: ${result.windowLabel}` : "",
      `${zhOrEn("新鲜度", "Freshness")}: ${zhOrEn("RSS 发布时间已校验", "RSS timestamp verified")}`,
      result.url,
      published ? `${zhOrEn("发布时间", "Published")}: ${published}` : "",
      result.snippet ? `- ${compactLine(result.snippet)}` : "",
    ].filter(Boolean).join("\n");
  }).join("\n\n");

  return [
    `${zhOrEn("实时新闻结果", "Live news results")} (google-news-rss)`,
    `${zhOrEn("查询", "Query")}: ${query}`,
    zhOrEn(
      opts.expanded
        ? "日期校验：最近 36 小时候选不足时，工具已自动扩展到 3 天/7 天；回答时必须按检索窗口分组，不要把近 7 天结果说成“今天发生”。"
        : "日期校验：这里只列出 RSS 发布时间在最近 36 小时内的候选。回答“今日/最新”时必须引用这里的发布时间；如果没有足够证据，不要使用旧年份链接冒充今日新闻。",
      opts.expanded
        ? "Freshness check: when the last-36h candidates were thin, the tool expanded to 3/7 days. Group by search window and do not present last-7d items as today's news."
        : "Freshness check: candidates here have RSS pubDate within the last 36 hours. For today/latest answers, cite these timestamps; if evidence is insufficient, do not use stale links as today's news.",
    ),
    "",
    rows,
  ].join("\n");
}

async function searchAndFetch(query, sceneHint, maxResults = SEARCH_LIMIT) {
  const searchResult = await runSearchQuery(query, maxResults, { sceneHint }) || {};
  const { results = [], provider = "", plan = null } = searchResult;
  const enriched = [];
  for (const result of results.slice(0, 2)) {
    let text = "";
    try {
      const fetched = await fetchWebContent(result.url, FETCH_LIMIT);
      text = compactLine(fetched.text).slice(0, 900);
    } catch {
      text = "";
    }
    enriched.push({ ...result, fetchedText: text });
  }
  return {
    provider,
    plan,
    results: enriched.length ? enriched : results,
  };
}

function localDateQueryText() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}年${month}月${day}日`;
}

function buildSupplementalNewsQueries(query, windowDays = 1) {
  const raw = compactLine(query);
  const core = raw
    .replace(/(?:请|帮我|查一下|查查|搜索|查询|全网|今天|今日|最新|新闻|有什么|哪些|一下)/g, " ")
    .replace(/\s+/g, " ")
    .trim() || raw;
  const dateText = localDateQueryText();
  const windowText = Number(windowDays) <= 1 ? "今日 最新" : `近${windowDays}天 最新`;
  const queries = [
    `${raw} ${windowText} 消息 新闻`,
    `${core} ${dateText} ${windowText} 新闻`,
  ];
  if (/干细胞|细胞治疗|再生医学|临床|医疗|医药|医院|药企/.test(raw)) {
    queries.push(`${core} 细胞治疗 临床研究 产业 政策 进展 ${windowText}`);
    queries.push(`${core} 再生医学 医院 药企 备案 ${windowText}`);
  } else if (/AI|人工智能|大模型|模型|芯片|半导体|机器人/i.test(raw)) {
    queries.push(`${core} 行业 公司 产品 发布 ${windowText}`);
  } else {
    queries.push(`${core} 进展 影响 来源 ${windowText}`);
  }
  return [...new Set(queries.map(compactLine).filter(Boolean))].slice(0, 4);
}

function mergeSearchResults(groups, maxResults = SEARCH_LIMIT) {
  const merged = [];
  const seen = new Set();
  for (const group of groups || []) {
    for (const item of group?.results || []) {
      const key = item.url || item.title;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
      if (merged.length >= maxResults) return merged;
    }
  }
  return merged;
}

function mergeSearchResultsBalancedByWindow(groups, maxPerWindow = 3, maxTotal = 12) {
  const labels = [];
  for (const group of groups || []) {
    for (const item of group?.results || []) {
      const label = item.windowLabel || "";
      if (label && !labels.includes(label)) labels.push(label);
    }
  }
  const balanced = [];
  const seen = new Set();
  const windows = labels.length ? labels : [""];
  for (const label of windows) {
    let picked = 0;
    for (const group of groups || []) {
      for (const item of group?.results || []) {
        if ((item.windowLabel || "") !== label) continue;
        const key = item.url || item.title;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        balanced.push(item);
        picked += 1;
        if (balanced.length >= maxTotal || picked >= maxPerWindow) break;
      }
      if (balanced.length >= maxTotal || picked >= maxPerWindow) break;
    }
    if (balanced.length >= maxTotal) break;
  }
  return balanced;
}

function cleanWeatherLocationCandidate(value) {
  const normalized = normalizeWeatherLocationToken(value)
    .replace(/^(?:嗯|呃|啊|那个|就是|请问|我想问(?:一下)?|我想查(?:一下)?|我要查(?:一下)?|我要问(?:一下)?|我查(?:一下)?|我问(?:一下)?|查的是|问的是|要查的是|想查的是|要问的是|想问的是)\s*/g, "")
    .replace(/^(?:用工具\s*)?(?:帮我|请|麻烦|给我|替我)?\s*(?:查一下|查下|查查|查询|查|搜一下|搜索|看看|看一下|看下|告诉我)\s*/, "")
    .replace(/^(?:用工具|工具)\s*/, "")
    .replace(/(?:今天|今日|明天|后天|今晚|明早|未来\d*天|天气|气温|温度|预报|如何|怎么样|会不会|是否|有没有|下雨|降雨|降水|多少度|几度|区间|概率)+/g, "")
    .replace(/^(?:什么|啥|什)+/g, "")
    .replace(/(?:呢|吗)$/g, "")
    .replace(/[，,。？?、:：；;]/g, "")
    .replace(/(?:给|和)+$/g, "")
    .trim();
  if (!normalized) return "";
  if (/^(?:温度|气温|区间|概率|降雨|降水|天气|预报|今天|明天|后天|给|和)$/.test(normalized)) return "";
  return normalized;
}

const COMMON_WEATHER_LOCATIONS = [
  "北京", "上海", "广州", "深圳", "杭州", "南京", "苏州", "成都", "重庆", "天津",
  "武汉", "西安", "长沙", "郑州", "青岛", "济南", "厦门", "福州", "宁波", "无锡",
  "佛山", "东莞", "珠海", "中山", "惠州", "汕头", "南宁", "海口", "三亚", "昆明",
  "贵阳", "南昌", "合肥", "太原", "石家庄", "沈阳", "大连", "长春", "哈尔滨",
  "呼和浩特", "银川", "兰州", "西宁", "乌鲁木齐", "拉萨", "香港", "澳门", "台北",
  "和田", "喀什", "伊犁", "桂林", "丽江", "大理", "张家界", "黄山",
];

const COMMON_WEATHER_COORDS = new Map([
  ["北京", { name: "北京", admin1: "北京", latitude: 39.9042, longitude: 116.4074, timezone: "Asia/Shanghai" }],
  ["上海", { name: "上海", admin1: "上海", latitude: 31.2304, longitude: 121.4737, timezone: "Asia/Shanghai" }],
  ["广州", { name: "广州", admin1: "广东", latitude: 23.1291, longitude: 113.2644, timezone: "Asia/Shanghai" }],
  ["深圳", { name: "深圳", admin1: "广东", latitude: 22.5431, longitude: 114.0579, timezone: "Asia/Shanghai" }],
  ["杭州", { name: "杭州", admin1: "浙江", latitude: 30.2741, longitude: 120.1551, timezone: "Asia/Shanghai" }],
  ["南京", { name: "南京", admin1: "江苏", latitude: 32.0603, longitude: 118.7969, timezone: "Asia/Shanghai" }],
  ["苏州", { name: "苏州", admin1: "江苏", latitude: 31.2989, longitude: 120.5853, timezone: "Asia/Shanghai" }],
  ["成都", { name: "成都", admin1: "四川", latitude: 30.5728, longitude: 104.0668, timezone: "Asia/Shanghai" }],
  ["重庆", { name: "重庆", admin1: "重庆", latitude: 29.563, longitude: 106.5516, timezone: "Asia/Shanghai" }],
  ["武汉", { name: "武汉", admin1: "湖北", latitude: 30.5928, longitude: 114.3055, timezone: "Asia/Shanghai" }],
  ["西安", { name: "西安", admin1: "陕西", latitude: 34.3416, longitude: 108.9398, timezone: "Asia/Shanghai" }],
  ["长沙", { name: "长沙", admin1: "湖南", latitude: 28.2282, longitude: 112.9388, timezone: "Asia/Shanghai" }],
  ["郑州", { name: "郑州", admin1: "河南", latitude: 34.7472, longitude: 113.6249, timezone: "Asia/Shanghai" }],
  ["青岛", { name: "青岛", admin1: "山东", latitude: 36.0671, longitude: 120.3826, timezone: "Asia/Shanghai" }],
  ["厦门", { name: "厦门", admin1: "福建", latitude: 24.4798, longitude: 118.0894, timezone: "Asia/Shanghai" }],
  ["福州", { name: "福州", admin1: "福建", latitude: 26.0745, longitude: 119.2965, timezone: "Asia/Shanghai" }],
  ["宁波", { name: "宁波", admin1: "浙江", latitude: 29.8683, longitude: 121.544, timezone: "Asia/Shanghai" }],
  ["佛山", { name: "佛山", admin1: "广东", latitude: 23.0215, longitude: 113.1214, timezone: "Asia/Shanghai" }],
  ["东莞", { name: "东莞", admin1: "广东", latitude: 23.0207, longitude: 113.7518, timezone: "Asia/Shanghai" }],
  ["珠海", { name: "珠海", admin1: "广东", latitude: 22.2707, longitude: 113.5767, timezone: "Asia/Shanghai" }],
  ["香港", { name: "香港", admin1: "香港", latitude: 22.3193, longitude: 114.1694, timezone: "Asia/Hong_Kong" }],
  ["澳门", { name: "澳门", admin1: "澳门", latitude: 22.1987, longitude: 113.5439, timezone: "Asia/Macau" }],
]);

function extractKnownWeatherLocation(text) {
  const value = compactLine(text);
  if (!value) return "";
  const hits = [];
  for (const city of COMMON_WEATHER_LOCATIONS) {
    let index = value.indexOf(city);
    while (index >= 0) {
      hits.push({ city, index });
      index = value.indexOf(city, index + city.length);
    }
  }
  if (!hits.length) return "";
  const weatherIndex = value.search(/天气|气温|温度|预报|下雨|降雨|降水|多少度|几度/);
  hits.sort((a, b) => {
    if (weatherIndex >= 0) {
      const da = Math.abs((a.index + a.city.length) - weatherIndex);
      const db = Math.abs((b.index + b.city.length) - weatherIndex);
      if (da !== db) return da - db;
    }
    return b.index - a.index;
  });
  return hits[0].city;
}

export function extractWeatherLocation(query, location) {
  const explicit = normalizeWeatherLocationToken(location);
  if (explicit) return explicit;
  const text = compactLine(query);
  const knownLocation = extractKnownWeatherLocation(text);
  if (knownLocation) return knownLocation;
  const rainOrTempMatch = text.match(/(?:今天|今日|明天|后天|今晚|明早)?\s*([\u4e00-\u9fa5A-Za-z .-]{2,16}?)(?:今天|今日|明天|后天|今晚|明早)?(?:会不会|是否|有没有)?(?:下雨|降雨|降水|温度|气温|多少度|几度)/);
  if (rainOrTempMatch?.[1]) {
    const normalized = cleanWeatherLocationCandidate(rainOrTempMatch[1]);
    if (normalized) return normalized;
  }
  const match = text.match(/(?:明天|今天|后天|未来\d*天|未来)?\s*([\u4e00-\u9fa5A-Za-z .-]{2,32}?)(?:的)?(?:天气|气温|预报)/);
  if (match?.[1]) {
    const normalized = cleanWeatherLocationCandidate(match[1]);
    if (normalized) return normalized;
  }
  return cleanWeatherLocationCandidate(text) || "深圳";
}

async function fetchOpenMeteoWeather(location, query = "") {
  const safeLocation = compactLine(location) || "深圳";
  const geoTimer = timeoutSignal(5000);
  let geo = COMMON_WEATHER_COORDS.get(safeLocation);
  try {
    if (!geo) {
      const params = new URLSearchParams({
        name: safeLocation,
        count: "1",
        language: "zh",
        format: "json",
      });
      const resp = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${params.toString()}`, {
        signal: geoTimer.signal,
        headers: { "User-Agent": "Lynn/OpenMeteoWeather" },
      });
      if (!resp.ok) throw new Error(`open-meteo geocode ${resp.status}`);
      const data = await resp.json();
      geo = data.results?.[0];
      if (!geo?.latitude || !geo?.longitude) throw new Error("open-meteo geocode empty");
    }
  } finally {
    geoTimer.clear();
  }

  const weatherTimer = timeoutSignal(7000);
  try {
    const window = resolveWeatherForecastWindow(query);
    const params = new URLSearchParams({
      latitude: String(geo.latitude),
      longitude: String(geo.longitude),
      current: "temperature_2m,relative_humidity_2m,precipitation,rain,weather_code,wind_speed_10m",
      daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
      timezone: geo.timezone || "Asia/Shanghai",
      forecast_days: String(Math.max(3, Math.min(7, window.startIndex + window.days))),
    });
    const resp = await fetch(`https://api.open-meteo.com/v1/forecast?${params.toString()}`, {
      signal: weatherTimer.signal,
      headers: { "User-Agent": "Lynn/OpenMeteoWeather" },
    });
    if (!resp.ok) throw new Error(`open-meteo forecast ${resp.status}`);
    const data = await resp.json();
    const areaName = [geo.name, geo.admin1].filter(Boolean).join(" · ");
    const current = data.current || {};
    const now = [
      `${areaName || safeLocation} ${zhOrEn("当前天气", "current weather")}`,
      Number.isFinite(Number(current.weather_code)) ? `- ${zhOrEn("天气", "Weather")}: ${weatherCodeText(current.weather_code)}` : "",
      Number.isFinite(Number(current.temperature_2m)) ? `- ${zhOrEn("温度", "Temperature")}: ${current.temperature_2m}°C` : "",
      Number.isFinite(Number(current.relative_humidity_2m)) ? `- ${zhOrEn("湿度", "Humidity")}: ${current.relative_humidity_2m}%` : "",
      Number.isFinite(Number(current.wind_speed_10m)) ? `- ${zhOrEn("风速", "Wind")}: ${current.wind_speed_10m} km/h` : "",
      Number.isFinite(Number(current.precipitation)) ? `- ${zhOrEn("降水", "Rain")}: ${current.precipitation} mm` : "",
    ].filter(Boolean).join("\n");
    const daily = data.daily || {};
    const forecastLines = (daily.time || []).slice(0, Math.max(3, window.startIndex + window.days)).map((date, index) => {
      const desc = weatherCodeText(daily.weather_code?.[index]);
      const min = daily.temperature_2m_min?.[index] ?? "?";
      const max = daily.temperature_2m_max?.[index] ?? "?";
      const pop = daily.precipitation_probability_max?.[index];
      const rainHint = formatRainHint({
        desc,
        code: daily.weather_code?.[index],
        precipitationProbability: pop,
        precipitation: daily.precipitation_sum?.[index],
      });
      return `- ${forecastDayLabel(index)} ${date}: ${desc} ${min}~${max}°C${Number.isFinite(Number(pop)) ? ` 降雨概率 ${pop}%` : ""} ${rainHint}`;
    });
    return [now, formatForecastSection(forecastLines, window)].filter(Boolean).join("\n");
  } finally {
    weatherTimer.clear();
  }
}

async function fetchWttrWeather(location, query = "") {
  const safeLocation = compactLine(location) || "深圳";
  const timer = timeoutSignal(8000);
  try {
    const url = `https://wttr.in/${encodeURIComponent(safeLocation)}?format=j1&lang=zh`;
    const resp = await fetch(url, {
      signal: timer.signal,
      headers: { "User-Agent": "Lynn/RealtimeWeather" },
    });
    if (!resp.ok) throw new Error(`wttr ${resp.status}`);
    const data = await resp.json();
    const current = data.current_condition?.[0] || {};
    const area = data.nearest_area?.[0] || {};
    const rawAreaName = area.areaName?.[0]?.value || safeLocation;
    const areaName = /[\u4e00-\u9fa5]/.test(safeLocation) ? safeLocation : rawAreaName;
    const currentDesc = localizeWttrDesc(current.weatherDesc?.[0]?.value);
    const now = [
      `${areaName} ${zhOrEn("当前天气", "current weather")}`,
      currentDesc ? `- ${zhOrEn("天气", "Weather")}: ${currentDesc}` : "",
      current.temp_C ? `- ${zhOrEn("温度", "Temperature")}: ${current.temp_C}°C` : "",
      current.FeelsLikeC ? `- ${zhOrEn("体感", "Feels like")}: ${current.FeelsLikeC}°C` : "",
      current.humidity ? `- ${zhOrEn("湿度", "Humidity")}: ${current.humidity}%` : "",
      current.windspeedKmph ? `- ${zhOrEn("风速", "Wind")}: ${current.windspeedKmph} km/h` : "",
      current.precipMM ? `- ${zhOrEn("降水", "Rain")}: ${current.precipMM} mm` : "",
    ].filter(Boolean).join("\n");

    const window = resolveWeatherForecastWindow(query);
    const forecastLines = (data.weather || []).map((day, index) => {
      const hourly = day.hourly?.[4] || day.hourly?.[0] || {};
      const desc = localizeWttrDesc(hourly.weatherDesc?.[0]?.value) || "";
      const displayDesc = desc || zhOrEn("天气数据可用", "weather data available");
      return `- ${forecastDayLabel(index)} ${day.date}: ${displayDesc} ${day.mintempC || "?"}~${day.maxtempC || "?"}°C ${formatRainHint({ desc: displayDesc })}`;
    });

    return [now, formatForecastSection(forecastLines, window)].filter(Boolean).join("\n");
  } finally {
    timer.clear();
  }
}

function buildWeatherEvidence(provider, location, text, extra = {}) {
  const firstLine = compactLine(String(text || "").split(/\n/).find(Boolean) || "");
  return [{
    type: "weather",
    kind: "weather",
    label: location || "",
    value: firstLine,
    timestamp: new Date().toISOString(),
    source: provider || "",
    location: location || "",
    fallback: !!extra.fallback,
    error: extra.error || "",
  }].filter((item) => item.value || item.source);
}

const WEATHER_NUMERIC_EVIDENCE_RE = /(?:-?\d+(?:\.\d+)?\s*(?:°\s*C|°C|℃|度)|(?:温度|气温|体感|湿度|风速|风力|降雨概率|降水|雨量|最高|最低)[：:\s]*-?\d|(?:min|max|temp|humidity|wind|rain|precipitation)[^\d-]{0,12}-?\d)/i;
const WEATHER_STATE_EVIDENCE_RE = /(?:晴|多云|阴|小雨|中雨|大雨|阵雨|雷雨|暴雨|雪|雾|霾|台风|天气|预报|sunny|cloudy|overcast|rain|shower|storm|snow|fog|weather|forecast)/i;

function hasConcreteWeatherEvidence(text) {
  const value = compactLine(text);
  if (!value) return false;
  return WEATHER_NUMERIC_EVIDENCE_RE.test(value) && WEATHER_STATE_EVIDENCE_RE.test(value);
}

function filterConcreteWeatherSearchResults(results = []) {
  return (results || []).filter((result) => {
    const text = [
      result?.title,
      result?.snippet,
      result?.fetchedText,
    ].filter(Boolean).join(" ");
    return hasConcreteWeatherEvidence(text);
  });
}

function buildWeatherNoEvidenceText({ location, query, provider, error } = {}) {
  const target = compactLine(location || query) || zhOrEn("目标城市", "the requested location");
  return [
    zhOrEn("未检索到明确天气数据。", "No concrete weather data was found."),
    zhOrEn(
      `已尝试 wttr.in 和 Open-Meteo 两个天气源，但这次没有拿到 ${target} 的可用天气状态、温度或降雨字段。`,
      `Tried wttr.in and Open-Meteo, but did not get usable weather state, temperature, or rain fields for ${target}.`,
    ),
    provider ? `${zhOrEn("天气源", "Weather sources")}: ${provider}` : "",
    error ? `${zhOrEn("错误", "Error")}: ${compactLine(error)}` : "",
    zhOrEn(
      "可核验入口：中国天气网 https://www.weather.com.cn/ ，中央气象台 https://www.nmc.cn/ 。",
      "Checkable sources: China Weather https://www.weather.com.cn/ and NMC https://www.nmc.cn/ .",
    ),
  ].filter(Boolean).join("\n");
}

export function createWeatherTool() {
  return {
    name: "weather",
    label: zhOrEn("天气查询", "Weather"),
    description: zhOrEn(
      "查询实时天气和未来几天天气预报。适合“深圳天气如何”“明天北京天气”等问题。",
      "Look up current weather and short forecasts.",
    ),
    parameters: Type.Object({
      query: Type.String({ description: zhOrEn("原始天气问题", "Original weather query") }),
      location: Type.Optional(Type.String({ description: zhOrEn("城市或地区", "City or location") })),
    }),
    execute: async (_toolCallId, params) => {
      const query = compactLine(params.query);
      const location = extractWeatherLocation(query, params.location);
      const providers = [
        {
          name: "wttr.in",
          run: () => fetchWttrWeather(location, query),
        },
        {
          name: "open-meteo",
          run: () => fetchOpenMeteoWeather(location, query),
        },
      ];
      const runProviderRound = () => {
        const attempts = providers.map((provider) => provider.run()
          .then((text) => ({ provider: provider.name, text }))
          .catch((err) => {
            throw new Error(`${provider.name}: ${err?.message || err}`);
          }));
        return Promise.any(attempts);
      };

      let lastError;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const { provider, text } = await runProviderRound();
          return {
            content: [{ type: "text", text }],
            details: {
              provider,
              location,
              fallback: provider !== "wttr.in" || attempt > 0,
              attempt: attempt + 1,
              evidence: buildWeatherEvidence(provider, location, text, {
                fallback: provider !== "wttr.in" || attempt > 0,
              }),
            },
          };
        } catch (err) {
          lastError = err;
          if (attempt === 0) await sleep(250);
        }
      }

      {
        const errors = Array.isArray(lastError?.errors)
          ? lastError.errors.map((item) => item?.message || String(item)).join("; ")
          : lastError?.message || String(lastError);
        const text = buildWeatherNoEvidenceText({
          location,
          query,
          provider: "wttr.in/open-meteo",
          error: errors,
        });
        return {
          content: [{ type: "text", text }],
          details: {
            provider: "wttr.in/open-meteo",
            location,
            fallback: true,
            error: errors,
            evidence: buildWeatherEvidence("wttr.in/open-meteo", location, text, {
              fallback: true,
              error: errors,
            }),
          },
        };
      }
    },
  };
}

export function createLiveNewsTool() {
  return {
    name: "live_news",
    label: zhOrEn("热点新闻", "Live news"),
    description: zhOrEn(
      "查询今日热点、突发新闻和最新进展。适合“今天有什么新闻”“美伊谈判最新消息”等问题。",
      "Look up live news, breaking stories, and latest developments.",
    ),
    parameters: Type.Object({
      query: Type.String({ description: zhOrEn("新闻问题或关键词", "News query or keywords") }),
      maxResults: Type.Optional(Type.Number({ default: 5 })),
    }),
    execute: async (_toolCallId, params) => {
      const query = compactLine(params.query);
      const searchQuery = `${query} 今日 最新 消息 新闻`;
      const maxResults = params.maxResults || SEARCH_LIMIT;
      const enableGoogleNewsRss = process.env.LYNN_ENABLE_GOOGLE_NEWS_RSS === "1";
      const windows = [
        { days: 1, label: zhOrEn("今日/最近36小时", "today / last 36h"), maxAgeHours: 36 },
        { days: 3, label: zhOrEn("最近3天", "last 3 days"), maxAgeHours: 84 },
        { days: 7, label: zhOrEn("最近7天", "last 7 days"), maxAgeHours: 180 },
      ];
      const allRssResults = [];
      const allSearchGroups = [];
      const allSupplementalQueries = [];
      const usedWindows = [];

      for (const window of windows) {
        const supplementalQueries = buildSupplementalNewsQueries(query, window.days);
        allSupplementalQueries.push(...supplementalQueries);
        const rssPromise = enableGoogleNewsRss
          ? fetchGoogleNewsRss(searchQuery, maxResults, {
            days: window.days,
            maxAgeHours: window.maxAgeHours,
            windowLabel: window.label,
          }).catch(() => [])
          : Promise.resolve([]);
        const searchPromises = supplementalQueries.map((item) => {
          return searchAndFetch(item, "realtime", Math.max(3, Math.ceil(maxResults / 2)))
            .then((group) => ({
              ...group,
              results: (group.results || []).map((result) => ({
                ...result,
                windowLabel: window.label,
                windowDays: window.days,
                freshness: zhOrEn("搜索候选，需打开原文核验日期", "search candidate; open original page to verify date"),
              })),
            }))
            .catch(() => null);
        });
        const [rssResults, ...searchGroups] = await Promise.all([rssPromise, ...searchPromises]);
        if (rssResults.length || searchGroups.some(Boolean)) usedWindows.push(window.label);
        allRssResults.push(...rssResults);
        allSearchGroups.push(...searchGroups.filter(Boolean));
        // RSS carries verified timestamps; plain search often returns stale pages even for
        // "today" queries, so it should not stop expansion by itself.
        if (allRssResults.length >= Math.min(3, maxResults)) break;
      }

      const provider = allSearchGroups.find(Boolean)?.provider || "";
      const results = mergeSearchResultsBalancedByWindow(
        allSearchGroups,
        Math.max(2, Math.ceil(maxResults / 2)),
        Math.max(maxResults * 3, 12),
      );
      const sections = [];
      if (allRssResults.length) {
        sections.push(formatNewsRssResults(searchQuery, allRssResults.slice(0, maxResults), {
          expanded: usedWindows.some((label) => /3|7/.test(label)),
        }));
      }
      if (results.length) {
        sections.push(formatSearchResults(
          allRssResults.length ? zhOrEn("补充全网搜索结果", "Supplemental web news results") : zhOrEn("实时新闻结果", "Live news results"),
          [...new Set(allSupplementalQueries)].join(" / "),
          provider || "search",
          results,
        ));
      }
      if (!sections.length) {
        sections.push(formatSearchResults(zhOrEn("实时新闻结果", "Live news results"), searchQuery, provider || "search", []));
      }
      sections.push(allRssResults.length
        ? zhOrEn(
          "\n日期校验：RSS 候选带有发布时间；补充搜索结果用于扩展视野，仍建议打开原文核验是否为今日最新。",
          "\nFreshness check: RSS candidates include timestamps; supplemental web results broaden coverage and should still be opened to verify freshness.",
        )
        : zhOrEn(
          `\n日期校验：国内默认不依赖 Google News RSS；以上为全网搜索候选，检索窗口已自动扩展到 ${usedWindows.join("、") || "今日/最近36小时"}。回答时必须按检索窗口说明新鲜度，不要把近 7 天结果说成“今天发生”。`,
          `\nFreshness check: Google News RSS is disabled by default. These are web-search candidates expanded across ${usedWindows.join(", ") || "today / last 36h"}. State freshness by search window; do not present last-7d items as today's news.`,
        ));
      return {
        content: [{
          type: "text",
          text: sections.join("\n\n"),
        }],
        details: {
          provider: allRssResults.length ? "google-news-rss+search" : provider,
          query: searchQuery,
          supplementalQueries: [...new Set(allSupplementalQueries)],
          expansionWindows: usedWindows,
          googleNewsRssEnabled: enableGoogleNewsRss,
        },
      };
    },
  };
}

export function createSportsScoreTool() {
  return {
    name: "sports_score",
    label: zhOrEn("体育比分", "Sports scores"),
    description: zhOrEn(
      "查询体育比分、赛程、排名和比赛结果。适合 NBA、CBA、中超、英超等比分赛程问题。",
      "Look up sports scores, schedules, standings, and match results.",
    ),
    parameters: Type.Object({
      query: Type.String({ description: zhOrEn("体育比分或赛程问题", "Sports score or schedule query") }),
      maxResults: Type.Optional(Type.Number({ default: 5 })),
    }),
    execute: async (_toolCallId, params) => {
      const query = compactLine(params.query);
      const searchQuery = `${query} 比分 赛程 排名 最新`;
      const { provider, results } = await searchAndFetch(searchQuery, "sports", params.maxResults || SEARCH_LIMIT);
      return {
        content: [{
          type: "text",
          text: formatSearchResults(zhOrEn("体育查询结果", "Sports lookup results"), searchQuery, provider, results),
        }],
        details: { provider, query: searchQuery },
      };
    },
  };
}
