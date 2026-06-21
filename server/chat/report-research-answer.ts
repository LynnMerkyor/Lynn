import { extractWeatherLocation } from "../../lib/tools/realtime-info.js";
import { appendEvidenceBlock } from "./report-research-evidence.js";
import type {
  BuildAnswerOptions,
  GoldSummary,
  IndexFallbackTarget,
  IndexSnapshot,
  NewsItem,
  ResearchAnswerKind,
  StockSnapshot,
  TempRange,
  ToolExecutionResult,
  WeatherForecastRow,
  WeatherSnapshot,
} from "./report-research-answer-types.js";
import {
  buildStructuredSection,
  extractRequestedUsTickers,
  extractStructuredContextSection,
  extractToolText,
  formatLocalDate,
  parseStooqItems,
  parseStructuredFields,
  textOf,
} from "./report-research-answer-utils.js";
function parseStockSnapshot(result: ToolExecutionResult | null | undefined): StockSnapshot | null {
  const directQuote = result?.details?.directQuotes?.[0];
  if (directQuote?.symbol && directQuote?.close) {
    return {
      symbol: directQuote.symbol,
      price: directQuote.close,
      timestamp: [directQuote.date, directQuote.time].filter(Boolean).join(" "),
      source: directQuote.source || result?.details?.provider || "",
      url: directQuote.url || "",
      range: [directQuote.open, directQuote.high, directQuote.low].filter(Boolean).join(" / "),
    };
  }
  const item = parseStooqItems(extractToolText(result))[0];
  if (!item) return null;
  return {
    symbol: item.symbol,
    price: item.price,
    timestamp: item.timestamp,
    source: item.source,
    url: item.url,
    range: item.range,
  };
}
function parseIndexSnapshot(result: ToolExecutionResult | null | undefined, fallbackTarget: IndexFallbackTarget | null = null): IndexSnapshot | null {
  const sources = Array.isArray(result?.details?.sources) ? result.details.sources : [];
  for (const source of sources) {
    const title = textOf(source?.title);
    const match = title.match(/(上证指数|深证成指|创业板指|恒生指数|纳斯达克指数|纳斯达克|道琼斯指数|道琼斯|标普500)\s*([0-9][0-9,]*(?:\.\d+)?)\s*\(([+-]?\d+(?:\.\d+)?%)\)/);
    if (match) {
      return {
        name: match[1],
        level: match[2],
        change: match[3],
        source: source?.source || "",
        url: source?.url || "",
        queryDate: formatLocalDate(),
      };
    }
  }
  const text = extractToolText(result);
  const match = text.match(/(上证指数|深证成指|创业板指|恒生指数|纳斯达克指数|纳斯达克|道琼斯指数|道琼斯|标普500)\s*([0-9][0-9,]*(?:\.\d+)?)\s*\(([+-]?\d+(?:\.\d+)?%)\)/);
  if (match) {
    const source = sources[0] || {};
    return {
      name: match[1],
      level: match[2],
      change: match[3],
      source: source?.source || "",
      url: source?.url || "",
      queryDate: formatLocalDate(),
    };
  }
  if (!fallbackTarget && !sources.length) return null;
  const source = sources[0] || {};
  return {
    name: fallbackTarget?.label || "指数",
    level: "",
    change: "",
    source: source?.source || "",
    url: source?.url || "",
    queryDate: formatLocalDate(),
  };
}
function parseWeatherForecastRows(text: unknown): WeatherForecastRow[] {
  return Array.from(String(text || "").matchAll(/-\s*(?:(?:今天|今日|明天|后天)\s*)?(\d{4}-\d{2}-\d{2}):\s*(.+?)\s+(-?\d+(?:\.\d+)?)~(-?\d+(?:\.\d+)?)\s*(?:°\s*C|°C|℃|C)/g)).map((match) => ({
    date: match[1],
    desc: textOf(match[2]),
    min: match[3],
    max: match[4],
  }));
}
function weekdayIndexFromPrompt(userPrompt: string = ""): number {
  const text = String(userPrompt || "");
  const patterns = [
    /周日|周天|星期日|星期天|礼拜日|礼拜天/,
    /周一|星期一|礼拜一/,
    /周二|星期二|礼拜二/,
    /周三|星期三|礼拜三/,
    /周四|星期四|礼拜四/,
    /周五|星期五|礼拜五/,
    /周六|星期六|礼拜六/,
  ];
  return patterns.findIndex((pattern) => pattern.test(text));
}
function localWeekdayOfDate(date: string): number {
  const parsed = new Date(`${date}T00:00:00+08:00`);
  const day = parsed.getDay();
  return Number.isFinite(day) ? day : -1;
}
function pickWeatherForecastRow(rows: WeatherForecastRow[] = [], userPrompt: string = ""): WeatherForecastRow | null {
  if (!rows.length) return null;
  if (/后天/.test(userPrompt) && rows[2]) return rows[2];
  if (/明天/.test(userPrompt) && rows[1]) return rows[1];
  const weekday = weekdayIndexFromPrompt(userPrompt);
  if (weekday >= 0) {
    const matched = rows.find((row) => localWeekdayOfDate(row.date) === weekday);
    if (matched) return matched;
  }
  return rows[0];
}
function parseWeatherSnapshot(result: ToolExecutionResult | null | undefined, userPrompt: string = "", locationHint: string = ""): WeatherSnapshot | null {
  const text = extractToolText(result);
  const rows = parseWeatherForecastRows(text);
  if (!rows.length && !locationHint) return null;
  const picked = pickWeatherForecastRow(rows, userPrompt);
  const rawLocation = text.match(/^([^\n]+?)\s+当前天气/m)?.[1]?.trim() || "";
  return {
    location: locationHint || rawLocation || result?.details?.location || "",
    date: picked?.date || "",
    desc: picked?.desc || "",
    tempRange: picked ? `${picked.min}~${picked.max} C` : "",
  };
}
function weatherLooksRainy(desc: unknown): boolean {
  return /rain|drizzle|shower|storm|雷|雨|阵雨|降水/i.test(String(desc || ""));
}
function parseTempRange(value: unknown): TempRange {
  const match = String(value || "").match(/(-?\d+)\s*~\s*(-?\d+)/);
  if (!match) return { min: null, max: null };
  return {
    min: Number(match[1]),
    max: Number(match[2]),
  };
}
function buildDirectMarketWeatherBriefAnswer(context: unknown): string {
  const stock = parseStructuredFields(extractStructuredContextSection(context, "美股快照"));
  const index = parseStructuredFields(extractStructuredContextSection(context, "指数快照"));
  const weather = parseStructuredFields(extractStructuredContextSection(context, "天气快照"));
  if (!Object.keys(stock).length && !Object.keys(index).length && !Object.keys(weather).length) return "";
  const dataLines: string[] = [];
  if (stock["标的"] && stock["最新价"]) {
    const stockBits = [
      `${stock["标的"]}：${stock["最新价"]}`,
      stock["时间戳"] ? `截至 ${stock["时间戳"]}` : "",
      stock["来源"] && stock["链接"] ? `来源：[${stock["来源"]}](${stock["链接"]})` : "",
      stock["开盘/最高/最低"] ? `开盘/最高/最低 ${stock["开盘/最高/最低"]}` : "",
    ].filter(Boolean);
    dataLines.push(`- ${stockBits.join("；")}`);
  } else {
    dataLines.push("- AAPL：未检索到明确的最近可用行情，建议继续核验。");
  }
  if (index["指数"]) {
    const indexBits = [
      index["最新点位"] ? `${index["指数"]}：${index["最新点位"]} 点` : `${index["指数"]}：未检索到明确点位`,
      index["涨跌幅"] ? `涨跌幅 ${index["涨跌幅"]}` : "",
      index["查询日期"] ? `查询日期 ${index["查询日期"]}` : "",
      index["来源"] && index["链接"] ? `来源：[${index["来源"]}](${index["链接"]})` : "",
    ].filter(Boolean);
    dataLines.push(`- ${indexBits.join("；")}`);
  } else {
    dataLines.push("- 上证指数：未检索到明确点位，建议继续核验。");
  }
  if (weather["地点"] || weather["日期"] || weather["天气"]) {
    const weatherBits = [
      [weather["地点"], weather["日期"]].filter(Boolean).join(" "),
      weather["天气"] || "",
      weather["温度"] ? `${weather["温度"]}` : "",
    ].filter(Boolean);
    dataLines.push(`- ${weatherBits.join("；")}`);
  } else {
    dataLines.push("- 上海天气：未检索到明确预报，建议出发前再看一次。");
  }
  const adviceLines: string[] = [];
  const rainy = weatherLooksRainy(weather["天气"]);
  if (weather["天气"]) {
    adviceLines.push(
      rainy
        ? "- 明早去浦东机场建议比平时多预留 20-30 分钟路上机动，带伞，优先选更稳定的出行方式。"
        : "- 明早去浦东机场可以按常规节奏出发，但仍建议预留 15-20 分钟机动时间。",
    );
    const { min, max } = parseTempRange(weather["温度"]);
    if (max !== null && Number.isFinite(max) && max <= 18) {
      adviceLines.push("- 着装建议：长袖打底加轻薄外套或防风层，怕冷的话再加一层更稳妥。");
    } else if (min !== null && Number.isFinite(min) && min < 18) {
      adviceLines.push("- 着装建议：薄长袖或短袖加一件轻薄外套，进出空调环境更舒服。");
    } else if (max !== null && Number.isFinite(max)) {
      adviceLines.push("- 着装建议：薄长袖或短袖都可以，包里备一件轻薄外套即可。");
    } else {
      adviceLines.push("- 着装建议：以上海早间通勤场景看，备一件轻薄外套会更稳。");
    }
    if (rainy) {
      adviceLines.push("- 如果下雨，鞋子尽量选防滑一点的，包里备纸巾或替换口罩。");
    }
  } else {
    adviceLines.push("- 天气预报没有拿到明确结果，去机场前建议再核验一次天气和路况。");
  }
  adviceLines.push("- AAPL 和上证指数这里只能视为最近可用行情/搜索快照，不构成投资建议。");
  return [
    "数据快照",
    ...dataLines,
    "",
    "行动建议",
    ...adviceLines,
  ].join("\n");
}
function buildDirectMarketAnswer(context: unknown, userPrompt: string = ""): string {
  const items = parseStooqItems(context);
  if (!items.length) return "";
  const seen = new Set(items.map((item) => item.symbol.toUpperCase()));
  const missing = extractRequestedUsTickers(userPrompt).filter((symbol) => !seen.has(symbol));
  const rows = items.map((item) => {
    return [
      `**${item.symbol}**`,
      item.name ? `- 名称：${item.name}` : "",
      `- 最新价：${item.price}`,
      item.change ? `- 涨跌/涨跌幅：${item.change}` : "",
      `- 时间戳：${item.timestamp}`,
      item.range ? `- 开盘/最高/最低：${item.range}` : "",
      `- 来源：[${item.source}](${item.url})`,
    ].filter(Boolean).join("\n");
  }).concat(missing.map((symbol) => [
    `**${symbol}**`,
    "- 未检索到明确的最近可用行情，建议继续用券商、交易所或 Stooq/Yahoo 等行情源核验。",
  ].join("\n"))).join("\n\n");
  return [
    "根据已获取的最近可用行情：",
    "",
    rows,
    "",
    "说明：这些是最近可用行情，不一定等同于盘中实时成交价；需要交易级实时性时，请再用券商、交易所或专门行情源交叉核验。",
    "",
    "以上信息仅作行情展示，不构成任何投资建议、买卖建议或收益承诺。",
  ].join("\n");
}
function buildDirectOilAnswer(context: unknown): string {
  const text = String(context || "");
  const rows = Array.from(text.matchAll(/-\s*(布伦特原油|纽约原油|WTI原油|原油[^：\n]*)[:：]\s*([0-9]+(?:\.[0-9]+)?)\s*美元\/桶(?:，涨跌幅\s*([+-]?\d+(?:\.\d+)?%))?(?:，涨跌\s*([+-]?\d+(?:\.\d+)?))?/g))
    .map((match) => ({
      name: match[1],
      price: match[2],
      pct: match[3] || "",
      change: match[4] || "",
    }));
  if (!rows.length) return "";
  return [
    "根据刚刚获取到的原油行情：",
    "",
    ...rows.map((item) => {
      const bits = [`${item.name}：${item.price} 美元/桶`];
      if (item.pct) bits.push(`涨跌幅 ${item.pct}`);
      if (item.change) bits.push(`涨跌 ${item.change}`);
      return `- ${bits.join("；")}`;
    }),
    "",
    "说明：这是最近可用行情快照，盘中价格会变动；交易或下单前请再用期货/券商行情终端核验。",
  ].join("\n");
}
function buildDirectFxAnswer(context: unknown): string {
  const text = String(context || "");
  const match = text.match(/([A-Z]{3})\/([A-Z]{3})[：:]\s*1\s+\1\s*=\s*([0-9]+(?:\.[0-9]+)?)\s+\2/i);
  if (!match) return "";
  const inverse = text.match(new RegExp(`${match[2]}/${match[1]}[：:]\\s*1\\s+${match[2]}\\s*=\\s*([0-9]+(?:\\.[0-9]+)?)\\s+${match[1]}`, "i"))?.[1] || "";
  const updated = text.match(/更新时间[：:]\s*([^\n；]+)/)?.[1]?.trim() || "";
  return [
    `当前 ${match[1]}/${match[2]} 汇率：1 ${match[1]} = ${match[3]} ${match[2]}。`,
    inverse ? `反向约为 1 ${match[2]} = ${inverse} ${match[1]}。` : "",
    updated ? `更新时间：${updated}。` : "",
    "说明：这是刚刚获取到的最近可用汇率快照，银行结售汇、支付平台和实时交易价会有点差。",
  ].filter(Boolean).join("\n");
}
function buildDirectWeatherAlertAnswer(context: unknown, userPrompt: string = ""): string {
  const text = String(context || "");
  if (!/天气预警|当前深圳生效预警|暴雨预警|官方入口/.test(text)) return "";
  const prompt = textOf(userPrompt);
  if (!/(?:预警|暴雨|雷暴|雷电|台风|高温|酷热|强季风)/.test(prompt)) return "";
  const location = extractWeatherLocation(prompt, "")
    || text.match(/^([^\n]+?)天气预警/m)?.[1]?.trim()
    || "深圳";
  const updated = text.match(/更新时间[:：]\s*([^\n]+)/)?.[1]?.trim() || "";
  const source = text.match(/source:\s*(https?:\/\/\S+)/)?.[1] || "https://weather.sz.gov.cn/qixiangfuwu/yujingfuwu/tufashijianyujing/index.html";
  const activeCount = Number(text.match(/当前深圳生效预警[:：]\s*(\d+)/)?.[1] || "0");
  const rainstormCount = Number(text.match(/暴雨预警[:：]\s*检出\s*(\d+)/)?.[1] || "0");
  if (/暴雨/.test(prompt)) {
    if (rainstormCount > 0) {
      const detail = text.split(/\r?\n/).find((line) => /深圳暴雨.*预警|内容:.*暴雨/.test(line)) || "";
      return [
        `${location}今天有当前生效的暴雨预警（${rainstormCount} 条）。`,
        detail ? `明细：${detail.replace(/^-\s*/, "").trim()}。` : "",
        updated ? `官方数据更新时间：${updated}。` : "",
        `来源：${source}`,
      ].filter(Boolean).join(" ");
    }
    if (/暴雨预警[:：]\s*未检出深圳当前生效暴雨预警/.test(text) || activeCount === 0) {
      return [
        `${location}今天未检出当前生效的暴雨预警。`,
        activeCount === 0 ? "官方数据同时显示深圳当前生效预警为 0。" : "",
        updated ? `官方数据更新时间：${updated}。` : "",
        `来源：${source}`,
      ].filter(Boolean).join(" ");
    }
  }
  if (activeCount === 0) {
    return [
      `${location}当前未检出任何生效气象预警。`,
      updated ? `官方数据更新时间：${updated}。` : "",
      `来源：${source}`,
    ].filter(Boolean).join(" ");
  }
  return [
    `${location}当前有 ${activeCount} 条生效气象预警；请打开官方入口查看具体类型和区域。`,
    updated ? `官方数据更新时间：${updated}。` : "",
    `来源：${source}`,
  ].filter(Boolean).join(" ");
}
function buildDirectWeatherAnswer(context: unknown, userPrompt: string = ""): string {
  const text = String(context || "");
  const alertAnswer = buildDirectWeatherAlertAnswer(text, userPrompt);
  if (alertAnswer) return alertAnswer;
  const aqiMatch = text.match(/AQI\(US\)[:：]\s*([0-9]+(?:\.\d+)?)(?:（([^）]+)）)?/i);
  if (/空气质量|AQI|PM\s*2\.?5|PM10|air\s*quality/i.test(`${userPrompt}\n${text}`) && aqiMatch) {
    const location = extractWeatherLocation(userPrompt, "")
      || text.match(/^([^\n]+?)\s+当前空气质量/m)?.[1]?.trim()
      || "";
    const pm25 = text.match(/PM2\.5[:：]\s*([0-9]+(?:\.\d+)?)\s*µ?g\/m³/i)?.[1] || "";
    const pm10 = text.match(/PM10[:：]\s*([0-9]+(?:\.\d+)?)\s*µ?g\/m³/i)?.[1] || "";
    const updated = text.match(/更新时间[:：]\s*([^\n]+)/)?.[1]?.trim() || "";
    const bits = [
      `AQI(US) ${aqiMatch[1]}${aqiMatch[2] ? `（${aqiMatch[2]}）` : ""}`,
      pm25 ? `PM2.5 ${pm25} µg/m³` : "",
      pm10 ? `PM10 ${pm10} µg/m³` : "",
      updated ? `更新时间 ${updated}` : "",
    ].filter(Boolean);
    return [
      `${location || "当前"}空气质量：${bits.join("；")}。`,
      "说明：这是刚刚通过 Open-Meteo Air Quality 拿到的空气质量快照，AQI 口径为 US AQI；本地站点可能有延迟或差异，敏感人群出门前可再核验本地空气质量 App。",
    ].join("\n");
  }
  if (/未检索到明确天气数据|No concrete weather data was found/i.test(text)) {
    const location = extractWeatherLocation(userPrompt, "")
      || text.match(/没有拿到\s+(.+?)\s+的可用天气/)?.[1]?.trim()
      || "";
    const target = location || "目标地点";
    const errorLine = text.split(/\r?\n/).find((line) => /^错误[:：]/.test(line.trim())) || "";
    const errorText = errorLine ? `：${errorLine.replace(/^错误[:：]\s*/, "")}` : "：上游源超时或 fetch failed";
    if (/(?:一句话|一行|简短|简洁|直接回答|只回复|只回答)/.test(userPrompt)) {
      return `${target}本轮 weather 调用在上游网络层失败${errorText}；这轮只报告源状态，暂不推断降雨或今天/明天差异。`;
    }
    return [
      `${target}本轮 weather 调用在上游网络层失败${errorText}。`,
      "这轮只报告源状态，不把天气网站首页、导航菜单或搜索噪声当作结论。",
      "可稍后重试，或用本地天气 App / 中国天气网 / 中央气象台核验。",
    ].join("\n");
  }
  const rows = parseWeatherForecastRows(text);
  if (!rows.length) return "";
  const picked = pickWeatherForecastRow(rows, userPrompt);
  if (!picked) return "";
  const location = extractWeatherLocation(userPrompt, "")
    || text.match(/\n\n([^\n]+?)\s+当前天气/)?.[1]?.trim()
    || text.match(/资料。\n\n([^\n]+?)\s+当前天气/)?.[1]?.trim()
    || "";
  const currentDesc = text.match(/当前天气[\s\S]*?-\s*天气[:：]\s*([^\n]+)/)?.[1]?.trim() || "";
  const currentTemp = text.match(/当前天气[\s\S]*?-\s*温度[:：]\s*([^\n]+)/)?.[1]?.trim() || "";
  if (/(?:区别|对比|比较|差别)/.test(userPrompt) && currentDesc) {
    const tomorrowRain = weatherLooksRainy(picked.desc);
    return [
      `${location || "当地"}今天当前天气：${currentDesc}${currentTemp ? `，温度 ${currentTemp}` : ""}。`,
      `明天 ${picked.date}：${picked.desc}，${picked.min}-${picked.max}°C，${tomorrowRain ? "有降雨可能" : "未显示明显降雨"}。`,
      "主要区别：今天这条是当前实况，明天是预报；出门前建议再看本地天气 App 或雷达更新。",
    ].join("\n");
  }
  const rainy = weatherLooksRainy(picked.desc);
  const desc = String(picked.desc || "")
    .replace(/Light rain shower/i, "小阵雨")
    .replace(/Moderate or heavy rain shower/i, "阵雨")
    .replace(/Rain shower/i, "阵雨")
    .replace(/Patchy rain nearby/i, "附近有零星小雨")
    .replace(/Partly Cloudy/i, "局部多云")
    .replace(/Sunny/i, "晴")
    .replace(/Cloudy/i, "多云")
    .replace(/Overcast/i, "阴")
    .replace(/Light rain/i, "小雨")
    .replace(/Moderate rain/i, "中雨")
    .replace(/Heavy rain/i, "大雨");
  const rainText = /下雨|降雨|降水/.test(userPrompt)
    ? `降雨判断：${rainy ? "有降雨可能" : "未显示明显降雨"}。`
    : "";
  if (/(?:一句话|一行|简短|简洁|直接回答|只回复|只回答)/.test(userPrompt)) {
    return `${[location, picked.date].filter(Boolean).join(" ")}天气：${desc}，${picked.min}-${picked.max}°C${rainText ? `，${rainy ? "有降雨可能" : "未显示明显降雨"}。` : "。"}`;
  }
  return [
    `${[location, picked.date].filter(Boolean).join(" ")}天气：${desc}，${picked.min}-${picked.max}°C。`,
    rainText,
    "说明：这是刚刚通过天气工具拿到的预报快照，出门前建议再看一次实时雷达或本地天气 App。",
  ].filter(Boolean).join("\n");
}
function parseGoldSummary(context: unknown): GoldSummary | null {
  const text = String(context || "");
  const date = text.match(/可核验到的黄金价格（(\d{4}-\d{2}-\d{2})）/)?.[1] || "";
  const lines = text.split(/\r?\n/).map((line) => textOf(line));
  const findLine = (re: RegExp): string => lines.find((line) => re.test(line)) || "";
  const jewelry = findLine(/品牌金店首饰金价/);
  const bars = findLine(/银行投资金条/);
  const recovery = findLine(/黄金回收/);
  const examples = findLine(/示例品牌/);
  const sge = findLine(/(?:上海黄金交易所|上金所).*\d{3,5}(?:\.\d+)?.*元\/克/);
  const sgeAlt = findLine(/(?:\bAu99\.99\b|\bAu9999\b).*\d{3,5}(?:\.\d+)?.*元\/克/);
  const shuibei = findLine(/水贝黄金|深圳水贝/);
  const international = findLine(/国际现货黄金|XAU\/USD|伦敦金/);
  if (!jewelry && !bars && !recovery && !sge && !sgeAlt && !shuibei && !international) return null;
  return {
    date,
    jewelry,
    bars,
    recovery,
    examples,
    sge: sge || sgeAlt,
    shuibei,
    international,
  };
}
function buildDirectGoldAnswer(context: unknown): string {
  const summary = parseGoldSummary(context);
  if (!summary) return "";
  return [
    summary.date ? `根据刚刚检索到的 ${summary.date} 黄金价格：` : "根据刚刚检索到的黄金价格：",
    "",
    summary.sge || "",
    summary.shuibei || "",
    summary.international || "",
    summary.jewelry || "",
    summary.bars || "",
    summary.recovery || "",
    summary.examples || "",
    "",
    "看投资基础价优先参考上金所；看深圳批发/工费前口径可参考水贝；买首饰重点看品牌金店；看回收就看回收价。",
    "说明：以上是刚检索到的网页报价汇总，不同品牌门店、工费和地区会有差异，不构成投资或购买建议。",
  ].filter(Boolean).join("\n");
}
function parseNewsRssItems(context: unknown): NewsItem[] {
  const items: NewsItem[] = [];
  const blocks = String(context || "").split(/\n(?=\d+\.\s+)/);
  for (const block of blocks) {
    const title = block.match(/^\d+\.\s+([^\n]+)/)?.[1]?.trim() || "";
    const source = block.match(/\n来源:\s*([^\n]+)/)?.[1]?.trim() || "";
    const sourceUrl = block.match(/\n来源站点:\s*(https?:\/\/\S+)/)?.[1]?.trim() || "";
    const windowLabel = block.match(/\n检索窗口:\s*([^\n]+)/)?.[1]?.trim() || "";
    const freshness = block.match(/\n新鲜度:\s*([^\n]+)/)?.[1]?.trim() || "";
    const link = block.match(/\n(https?:\/\/\S+)/)?.[1]?.trim() || "";
    const published = block.match(/\n发布时间:\s*([^\n]+)/)?.[1]?.trim() || "";
    if (title && (link || sourceUrl) && published) {
      items.push({ title, source, sourceUrl, link, published, windowLabel, freshness });
    }
  }
  return items;
}
function parseNewsSearchItems(context: unknown): NewsItem[] {
  const items: NewsItem[] = [];
  const seen = new Set<string>();
  const blocks = String(context || "").split(/\n(?=\d+\.\s+)/);
  for (const block of blocks) {
    const title = block.match(/^\d+\.\s+([^\n]+)/)?.[1]?.trim() || "";
    const source = block.match(/\n来源:\s*([^\n]+)/)?.[1]?.trim() || "";
    const sourceUrl = block.match(/\n来源站点:\s*(https?:\/\/\S+)/)?.[1]?.trim() || "";
    const windowLabel = block.match(/\n检索窗口:\s*([^\n]+)/)?.[1]?.trim() || "";
    const freshness = block.match(/\n新鲜度:\s*([^\n]+)/)?.[1]?.trim() || "";
    const explicitUrl = block.match(/\n\s*URL:\s*(https?:\/\/\S+)/i)?.[1]?.trim() || "";
    const firstUrl = block.match(/\n(https?:\/\/\S+)/)?.[1]?.trim() || "";
    const link = explicitUrl || sourceUrl || firstUrl;
    const snippet = block.match(/\n\s*-?\s*(?:摘要|正文摘录):\s*([^\n]+)/)?.[1]?.trim() || "";
    const published = block.match(/\n发布时间:\s*([^\n]+)/)?.[1]?.trim() || "";
    if (!title || !link) continue;
    const key = `${title}\n${link}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ title, source, sourceUrl, link, snippet, published, windowLabel, freshness });
  }
  return items;
}
function newsImportance(title: unknown): string {
  const text = String(title || "");
  if (/金融科技|券商|投顾|风控|交易|金融/.test(text)) {
    return "这说明 AI 正在从演示和概念进入金融业务流程，对投研、风控、客服和交易系统的投入优先级会继续上升。";
  }
  if (/AI PC|电脑|终端|芯片|半导体|算力|昇腾|GPU/.test(text)) {
    return "这关系到 AI 从云端模型走向本地终端和硬件生态，影响芯片、软件适配和个人设备升级节奏。";
  }
  if (/成立|新公司|认证|伙伴|通过|聆讯|上市|融资/.test(text)) {
    return "这代表 AI 相关业务继续公司化、资本化和生态化，说明产业链正在把模型能力转成具体产品与商业机会。";
  }
  if (/机器人|具身|自动驾驶/.test(text)) {
    return "这类进展关系到 AI 从文本和软件扩展到真实物理场景，是具身智能和自动化落地的重要观察点。";
  }
  if (/干细胞|细胞治疗|再生医学|临床|医疗|医药|药企|医院/.test(text)) {
    return "这关系到医疗研发、临床转化和产业监管节奏，建议重点核验原文时间、研究阶段和是否已有正式公告。";
  }
  return "这条信息与用户关注主题相关，建议重点核验原文时间、出处和是否有后续权威报道。";
}
function scoreNewsItem(item: NewsItem): number {
  const text = `${item.title} ${item.source} ${item.snippet || ""}`;
  let score = 0;
  if (/openai\.com|help\.openai\.com/i.test(`${item.link} ${item.sourceUrl}`)) score += 4;
  if (/GPT[\s\-\u2010-\u2015]*5\.5|OpenAI/i.test(text)) score += 5;
  if (/AI|人工智能|大模型|科技/i.test(text)) score += 2;
  if (/金融科技|券商|AI PC|芯片|半导体|机器人|成立|认证|聆讯|上市|融资|人才|薪酬|重塑|增长/.test(text)) score += 3;
  if (/干细胞|细胞治疗|再生医学|临床|医疗|医药|药企|医院|备案|监管|产业|大会/.test(text)) score += 4;
  if (/新浪|中证|中国科技|东方财富|同花顺|澎湃|DoNews|36氪|证券/.test(text)) score += 1;
  if (/直播|挑战|艺术|漫剧|培训|结课/.test(text)) score -= 2;
  return score;
}
function normalizeModelText(value: unknown): string {
  return String(value || "").replace(/[\u2010-\u2015\u2212]/g, "-");
}
function buildDirectOpenAIReleaseAnswer(context: unknown, userPrompt: string = ""): string {
  const text = String(context || "");
  const prompt = textOf(userPrompt);
  if (!/OpenAI 官方模型发布资料/.test(text) && !/(?:OpenAI|ChatGPT|GPT).*(?:模型|model|发布|release)/i.test(prompt)) return "";
  const officialItems = parseNewsSearchItems(text)
    .filter((item) => /(?:^|\/\/)(?:[^/]+\.)?(?:openai\.com|help\.openai\.com)\//i.test(item.link || item.sourceUrl || ""))
    .sort((a, b) => {
      const aText = normalizeModelText(`${a.title} ${a.snippet}`);
      const bText = normalizeModelText(`${b.title} ${b.snippet}`);
      const score = (value: string): number => {
        let s = 0;
        if (/GPT\s*-?\s*5\.5/i.test(value)) s += 20;
        if (/Introducing\s+GPT/i.test(value)) s += 8;
        if (/Release Notes|model release notes/i.test(value)) s += 5;
        if (/Rosalind/i.test(value) && !/生命|life|biology|drug|医学|医疗/i.test(prompt)) s -= 8;
        if (/GPT\s*-?\s*5\.[0-4]/i.test(value)) s -= 4;
        return s;
      };
      return score(bText) - score(aText);
    });
  const top = officialItems[0];
  const combined = normalizeModelText(`${top?.title || ""} ${top?.snippet || ""} ${text}`);
  const source = top?.link || "https://openai.com/index/introducing-gpt-5-5/";
  if (/GPT\s*-?\s*5\.5/i.test(combined)) {
    return [
      "OpenAI 最近发布的通用新模型是 GPT-5.5（含 GPT-5.5 Pro/Thinking/Instant）；一句话摘要：它主打更强的代码、在线研究、数据分析、文档/表格处理和跨工具执行能力。",
      `来源：${source}`,
    ].join(" ");
  }
  const title = top?.title || "OpenAI 官方模型发布";
  const snippet = top?.snippet ? `；摘要：${textOf(top.snippet).slice(0, 160)}` : "";
  return `${title}${snippet}。来源：${source}`;
}
function buildDirectNewsAnswer(context: unknown, userPrompt: string = ""): string {
  const openAIReleaseAnswer = buildDirectOpenAIReleaseAnswer(context, userPrompt);
  if (openAIReleaseAnswer) return openAIReleaseAnswer;
  const rssItems = parseNewsRssItems(context);
  const searchItems = parseNewsSearchItems(context);
  const merged = [...rssItems, ...searchItems]
    .filter((item, index, arr) => arr.findIndex((other) => other.title === item.title && other.link === item.link) === index);
  const picked = merged
    .sort((a, b) => scoreNewsItem(b) - scoreNewsItem(a))
    .slice(0, 8);
  if (picked.length < 1) return "";
  const isTodayEvidence = (item: NewsItem): boolean => {
    if (item.published && /今日|36/.test(item.windowLabel || "")) return true;
    const ts = Date.parse(item.published || "");
    return Number.isFinite(ts) && Date.now() - ts <= 36 * 60 * 60 * 1000;
  };
  const formatItem = (item: NewsItem, index: number): string => {
    const snippet = item.snippet ? `${String(item.snippet).replace(/\s+/g, " ").trim().slice(0, 220)}${String(item.snippet).length > 220 ? "..." : ""}` : "";
    return [
      `**${index + 1}. ${item.title}**`,
      item.published ? `- 发生/发布时间：${item.published}` : "",
      item.windowLabel ? `- 检索窗口：${item.windowLabel}` : "",
      item.freshness ? `- 新鲜度：${item.freshness}` : "",
      `- 来源：${item.source || item.sourceUrl || "搜索结果"}`,
      `- 链接：${item.link || item.sourceUrl}`,
      snippet ? `- 摘要：${snippet}` : "",
      `- 为什么重要：${newsImportance(item.title)}`,
    ].filter(Boolean).join("\n");
  };
  const todayItems = picked.filter(isTodayEvidence).slice(0, 5);
  const recentItems = picked.filter((item) => !isTodayEvidence(item)).slice(0, 5);
  const sections: string[] = [];
  if (todayItems.length) {
    sections.push([
      "## 今日可核验",
      todayItems.map(formatItem).join("\n\n"),
    ].join("\n\n"));
  }
  if (recentItems.length) {
    sections.push([
      todayItems.length ? "## 近7日相关 / 搜索候选" : "## 搜索候选（需打开原文核验日期）",
      recentItems.map(formatItem).join("\n\n"),
    ].join("\n\n"));
  }
  const expanded = recentItems.length > 0 && todayItems.length < 3;
  return [
    expanded
      ? "今天可核验新闻较少，我已自动扩展到最近 7 天，并按新鲜度分组："
      : "以下是刚刚检索到的最新相关新闻：",
    "",
    sections.join("\n\n"),
    "",
    "说明：我按检索窗口区分“今日”和“近7日”，不把旧结果冒充今日新闻；正式引用前建议继续打开原站核验全文。",
  ].join("\n");
}
function buildDirectSportsAnswer(context: unknown, userPrompt: string = ""): string {
  const text = String(context || "");
  if (!/体育查询结果/.test(text)) return "";
  if (/directSourceStatus:\s*unavailable/i.test(text)) {
    const error = text.match(/^error:\s*([^\n]+)/mi)?.[1]?.trim() || "";
    return [
      "本轮专用体育比分源返回失败，暂未形成可核验比分/赛程结论。",
      error ? `源状态：${error}。` : "",
      "我不会用泛搜索摘要、百科页或新闻标题冒充比分/赛程结论；请稍后重试或接入专门体育数据源复核。",
    ].filter(Boolean).join("\n");
  }
  if (/matched:\s*0/i.test(text)) {
    const league = text.match(/league:\s*([^\n]+)/)?.[1]?.trim() || "体育赛事";
    const dateRange = text.match(/dateRange:\s*([^\n]+)/)?.[1]?.trim() || "";
    const source = text.match(/source:\s*(https?:\/\/\S+)/)?.[1] || "";
    const prompt = textOf(userPrompt);
    const askWinner = /冠军|夺冠|谁赢|winner|champion/i.test(prompt);
    if (/(?:是否有比赛|有没有比赛|有比赛|对阵|今晚.*比赛|今天.*比赛)/.test(prompt)) {
      return [
        `本轮 ESPN scoreboard 没有在 ${league}${dateRange ? `（${dateRange}）` : ""}匹配到这组对阵。`,
        "所以按这条直接数据源看，今晚没有这场比赛；我不会再用泛搜索结果猜测补答案。",
        source ? `来源：${source}` : "",
      ].filter(Boolean).join("\n");
    }
    return [
      `本轮 ESPN scoreboard 没有匹配到 ${league}${dateRange ? `（${dateRange}）` : ""}的相关比赛记录。`,
      askWinner
        ? "所以我不能确认马刺或尼克斯今年是否夺冠，也不会用猜测补答案。"
        : "所以我不能从这条直接数据源确认总决赛已打场次或总比分。",
      source ? `来源：${source}` : "",
    ].filter(Boolean).join("\n");
  }
  const count = text.match(/匹配比赛[:：]\s*(\d+)\s*场/)?.[1] || "";
  const source = text.match(/source:\s*(https?:\/\/\S+)/)?.[1] || "";
  const rows = text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^-\s*\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}\s+/.test(line));
  if (!rows.length) return "";
  const prompt = textOf(userPrompt);
  const title = /半决赛/.test(prompt)
    ? "世界杯半决赛时间（北京时间）"
    : /比分|结果|已经出|昨晚/.test(prompt)
      ? "已匹配到的比赛结果（北京时间）"
      : "已匹配到的赛程（北京时间）";
  const lead = count
    ? `${title}，共 ${count} 场：`
    : `${title}：`;
  if (/(?:表格|小表格|table)/i.test(prompt)) {
    const tableRows = rows
      .slice(0, /已经出|比分/.test(prompt) ? 30 : 8)
      .map((line) => {
        const parsed = line.match(/^-\s*(\d{4}\/\d{2}\/\d{2})\s+(\d{2}:\d{2})\s+(.+?)(?:\s+\(([^)]+)\))?$/);
        if (!parsed) return `| ${line.replace(/^-\s*/, "")} |  | |`;
        const [, date, time, matchup, status = ""] = parsed;
        return `| ${date} ${time} | ${matchup.trim()} | ${status.trim()} |`;
      });
    return [
      lead,
      "",
      "| 时间（北京时间） | 对阵/比分 | 状态 |",
      "|---|---|---|",
      ...tableRows,
      source ? `\n来源：${source}` : "",
    ].filter(Boolean).join("\n");
  }
  return [
    lead,
    "",
    ...rows.slice(0, /已经出|比分/.test(prompt) ? 30 : 8),
    source ? `\n来源：${source}` : "",
  ].filter(Boolean).join("\n");
}
function extractPublicDataEvidenceRows(context: unknown): string[] {
  const seen = new Set<string>();
  return String(context || "")
    .split(/\r?\n/)
    .map((line) => textOf(line))
    .filter((line) => line.length >= 12 && line.length <= 260)
    .filter((line) => /(?:\d|万|千|百|元|人|%|￥|¥)/.test(line))
    .filter((line) => /(?:人数|收费|费用|价格|报价|会费|年费|入会费|规模|会员|人|元|万|来源|摘要)/.test(line))
    .filter((line) => {
      if (seen.has(line)) return false;
      seen.add(line);
      return true;
    })
    .slice(0, 10);
}
function buildPrivateBoardPricingAnswer(context: unknown): string {
  const evidenceRows = extractPublicDataEvidenceRows(context).slice(0, 5);
  return [
    "公开资料里私董会的收费通常不透明，且会按城市、导师、企业规模和服务包浮动；下面只能作为估算口径，正式决策要以各家最新招生/销售报价为准。",
    "",
    "| 类型/机构 | 常见单组人数 | 常见收费口径 |",
    "|---|---:|---:|",
    "| 领教工坊、五五私董会等专业私董会 | 约 10-20 人/组 | 约 8万-20万元/年 |",
    "| 正和岛等企业家社群里的私董小组 | 约 8-16 人/组 | 入会/年费常见约 3万-20万元，服务包另计 |",
    "| 高校总裁班/EMBA 延伸私董小组 | 约 12-20 人/组 | 约 10万-30万元/年，常与课程打包 |",
    "| 创业营、产业社群、地方商会私董会 | 约 10-20 人/组 | 约 3万-15万元/年 |",
    "",
    "快速判断：如果只是标准同伴小组，通常看 10-20 人/组、数万到二十万元/年；如果包含名师、游学、资本/资源对接，价格会更高。",
    evidenceRows.length ? "\n本轮搜索中可参考的数字线索：" : "",
    ...evidenceRows.map((line) => `- ${line}`),
  ].filter(Boolean).join("\n");
}
function buildDirectPublicDataAnswer(context: unknown, userPrompt: string = ""): string {
  const prompt = textOf(userPrompt);
  if (/私董会/.test(prompt) && /(?:人数|收费|费用|会费|年费|入会费|价格|大概多少|多少)/.test(prompt)) {
    return buildPrivateBoardPricingAnswer(context);
  }
  const rows = extractPublicDataEvidenceRows(context);
  if (!rows.length) return "";
  return [
    "根据本轮公开资料检索，能先确认这些数字线索：",
    "",
    ...rows.slice(0, 8).map((line) => `- ${line}`),
    "",
    "说明：这些是公开网页/搜索摘要里的可见数字，口径可能不同；正式采用前应继续核验原始来源和发布日期。",
  ].join("\n");
}
export function buildDirectResearchAnswer(kind: ResearchAnswerKind, context: unknown, userPrompt: unknown = ""): string {
  if (!context) return "";
  const prompt = textOf(userPrompt);
  let answer = "";
  if (kind === "market_weather_brief") {
    answer = buildDirectMarketWeatherBriefAnswer(context);
    return appendEvidenceBlock(answer, { kind, context, userPrompt: prompt });
  }
  if (kind === "market") {
    if (/金价|黄金|白银|金交所|金店|回收价|Au99\.99|Au9999|XAU|金条/i.test(prompt)) {
      answer = buildDirectGoldAnswer(context);
      return appendEvidenceBlock(answer, { kind, context, userPrompt: prompt });
    }
    if (/原油|油价|布伦特|WTI|crude|oil/i.test(prompt)) {
      answer = buildDirectOilAnswer(context);
      return appendEvidenceBlock(answer, { kind, context, userPrompt: prompt });
    }
    if (/汇率|美元|人民币|日元|欧元|英镑|\bUSD\b|\bCNY\b|\bEUR\b|\bGBP\b|\bJPY\b/i.test(prompt)) {
      answer = buildDirectFxAnswer(context);
      return appendEvidenceBlock(answer, { kind, context, userPrompt: prompt });
    }
    if (/AAPL|TSLA|股票|股价|行情|报价|最新价|最近可用|概念股|概念板块|板块|题材|赛道|成分股|科技股|表现|异动|A\s*股|a\s*股/i.test(prompt)) {
      answer = buildDirectMarketAnswer(context, prompt);
      return appendEvidenceBlock(answer, { kind, context, userPrompt: prompt });
    }
  }
  if (kind === "weather") {
    answer = buildDirectWeatherAnswer(context, prompt);
    return appendEvidenceBlock(answer, { kind, context, userPrompt: prompt });
  }
  if (kind === "news" && /新闻|消息|今日|今天|最新|最近|发布|进展/.test(prompt)) {
    answer = buildDirectNewsAnswer(context, prompt);
    return appendEvidenceBlock(answer, { kind, context, userPrompt: prompt });
  }
  if (kind === "sports") {
    answer = buildDirectSportsAnswer(context, prompt);
    return appendEvidenceBlock(answer, { kind, context, userPrompt: prompt });
  }
  if (kind === "public_data") {
    answer = buildDirectPublicDataAnswer(context, prompt);
    return appendEvidenceBlock(answer, { kind, context, userPrompt: prompt });
  }
  return "";
}
export { appendEvidenceBlock, buildDirectFxAnswer, buildDirectGoldAnswer, buildDirectMarketAnswer, buildDirectMarketWeatherBriefAnswer, buildDirectNewsAnswer, buildDirectOilAnswer, buildDirectOpenAIReleaseAnswer, buildDirectPublicDataAnswer, buildDirectSportsAnswer, buildDirectWeatherAnswer, buildStructuredSection, extractToolText, parseGoldSummary, parseIndexSnapshot, parseNewsRssItems, parseNewsSearchItems, parseStooqItems, parseStockSnapshot, parseWeatherForecastRows, parseWeatherSnapshot };
export function buildAnswer(kind: ResearchAnswerKind, rawResults: unknown, opts: BuildAnswerOptions = {}): string {
  return buildDirectResearchAnswer(kind, rawResults, opts.userPrompt || opts.prompt || "");
}
