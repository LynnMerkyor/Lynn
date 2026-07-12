// @ts-nocheck
// Brain v2 · tool-exec dispatcher
// 服务端工具注册表 + 调度器
// 16 个 server tool: web_search + 5 utility + 8 ported + 5 newly ported (stock_market/live_news/stock_research/create_report/create_pptx)
import { webSearch } from './web_search.js';
import { exchangeRate, sportsScore, expressTracking, calendar, unitConvert } from './utility.js';
import { webFetch } from './web_fetch.js';
import { createArtifact } from './create_artifact.js';
import { createPdf } from './create_pdf.js';
import { weather } from './weather.js';
import { parallelResearch } from './parallel_research.js';
import { stockMarket } from './stock_market.js';
import { liveNews } from './live_news.js';
import { stockResearch } from './stock_research.js';
import { createReport } from './create_report.js';
import { createPptx } from './create_pptx.js';
// V0.83+:外部工具族(akshare/飞书/高德/IMAP…)统一经 MCP 桥接入,不再逐个扩 switch。
import { executeMcpTool, getMcpToolDefs, isMcpTool } from './mcp-proxy.js';

// ── server-side tool definitions(给 model 看的 schema)─────
export const SERVER_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web only when the user explicitly asks to look up, verify, cite, or obtain current external information. Do not use for timeless writing, planning, brainstorming, explanations, Lynn-internal UX copy, or ordinary travel itinerary drafting.',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'Search query (any language)' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Fetch the content of a given URL and extract text. Useful for reading articles, docs, API responses. Pair with web_search.',
      parameters: { type: 'object', properties: { url: { type: 'string' }, max_length: { type: 'number', description: 'default 8000' } }, required: ['url'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'weather',
      description: 'Get current weather, weather alerts, and 3-day forecast for a city.',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string', description: 'City name in Chinese or English' },
          query: { type: 'string', description: 'Original weather question, especially for alerts/warnings' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'exchange_rate',
      description: 'Get real-time forex/currency exchange rates (USD/EUR/GBP/JPY/HKD etc to CNY).',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'Currency query e.g. 美元汇率' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'express_tracking',
      description: 'Track express/courier package delivery status by tracking number.',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'Tracking number' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'sports_score',
      description: 'Get live or recent sports scores and results (football, basketball, tennis, F1, etc).',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'Sports query' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calendar',
      description: 'Get date info, holidays, day-of-week, date calculations, countdown to events.',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'Date query' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'unit_convert',
      description: 'Convert units: temperature, length, weight, area, volume.',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'Value with unit e.g. 100公里' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_artifact',
      description: 'Create a rich content preview (HTML page, code snippet, or markdown document).',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['html', 'code', 'markdown'] },
          title: { type: 'string' },
          content: { type: 'string' },
          language: { type: 'string', description: 'Programming language (only for type=code)' },
        },
        required: ['type', 'title', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_pdf',
      description: 'Generate a professional PDF document with cover page, headings, tables, callouts.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          author: { type: 'string' },
          type: { type: 'string', enum: ['report', 'proposal', 'analysis', 'general'] },
          accent: { type: 'string', description: 'Accent color hex' },
          content: { type: 'array', items: { type: 'object' } },
        },
        required: ['title', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'stock_market',
      description: 'Get stock/commodity prices and market data (A-shares, US stocks, HK stocks, gold, oil, crypto, forex).',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'Stock or commodity query' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'live_news',
      description: 'Get latest breaking news on a topic. Returns recent headlines and summaries (今日/3天/7天 三窗口). Do not use for stock/index/market movement or A-share anomaly questions; use stock_market for those.',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'News topic to search for' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'stock_research',
      description: 'Comprehensive A-share research from Tushare Pro: 60-day price history, key financials (8 quarters), income statement, top-10 shareholders, valuation. Call before create_report for real data. A-shares only (SH/SZ/BJ).',
      parameters: { type: 'object', properties: { code: { type: 'string', description: 'Stock code with exchange suffix, e.g. 688629.SH or 000001.SZ' }, name: { type: 'string', description: 'Company name (for display)' } }, required: ['code'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_report',
      description: 'Generate a professional HTML report/page from JSON (title + sections[]). Use when the user explicitly asks for a report, preview/export page, or to turn existing results/data/tables/rankings/charts into an image/long image/PNG/HTML visualization. This is deterministic local Chromium/Electron HTML→PNG rendering, not AI text-to-image; creative illustrations belong to generate_image/flux. Provide real content, not shell reports. Each section = {title, type, ...type-specific fields}. By type: metrics -> metrics:[{label,value,change,direction:up|down|neutral}] (KPI cards); text -> content (string) or blocks:[{heading,text}]; table -> headers:[str] + rows:[[str]]; verdict -> items:[{period,range,note}] (prediction cards); warning -> content (alert text).',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          tag: { type: 'string' },
          subtitle: { type: 'string' },
          date: { type: 'string' },
          sections: { type: 'array', description: 'Section objects; shape per the description above', items: { type: 'object' } },
          disclaimer: { type: 'string' },
        },
        required: ['title', 'sections'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_pptx',
      description: 'Generate a PowerPoint (.pptx). slides[] = each {title, layout, body, notes}. layout: title | content (default) | section | two_column. In body, lines starting with "-" are bullets; for two_column split the two columns with "|||". Returns a download URL.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          author: { type: 'string' },
          slides: { type: 'array', description: 'Slide objects; shape per the description above', items: { type: 'object' } },
        },
        required: ['title', 'slides'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'parallel_research',
      description: '并行调用多个查询工具,一轮拿回所有结果。用于多源对比 / 多角度调研。比串行调用快 N 倍——优先在 N≥2 多源场景使用。',
      parameters: {
        type: 'object',
        properties: {
          queries: {
            type: 'array', minItems: 2, maxItems: 8,
            items: {
              type: 'object',
              properties: {
                tool: { type: 'string', enum: ['web_search', 'stock_market', 'weather', 'live_news', 'sports_score', 'exchange_rate', 'calendar', 'unit_convert', 'express_tracking'] },
                args: { type: 'object' },
                label: { type: 'string' },
              },
              required: ['tool', 'args'],
            },
          },
        },
        required: ['queries'],
      },
    },
  },
];

export const SERVER_TOOL_NAMES = new Set(SERVER_TOOLS.map(t => t.function.name));

// ── dispatcher ────────────────────────────────────────────
export async function executeServerTool(name, argsStr, { log } = {}) {
  if (!SERVER_TOOL_NAMES.has(name)) {
    if (isMcpTool(name)) {
      let mcpArgs;
      try { mcpArgs = typeof argsStr === 'string' ? JSON.parse(argsStr || '{}') : (argsStr || {}); }
      catch { return JSON.stringify({ error: 'invalid tool args (not JSON): ' + String(argsStr).slice(0, 200) }); }
      return executeMcpTool(name, mcpArgs, { log });
    }
    return JSON.stringify({ error: 'tool not handled by brain server: ' + name });
  }
  let args;
  try { args = typeof argsStr === 'string' ? JSON.parse(argsStr || '{}') : (argsStr || {}); }
  catch { return JSON.stringify({ error: 'invalid tool args (not JSON): ' + String(argsStr).slice(0, 200) }); }
  try {
    switch (name) {
      case 'web_search':       return (await webSearch(args.query || '', { log })) || JSON.stringify({ error: 'no results' });
      case 'web_fetch':        return await webFetch(args.url || '', args.max_length || 8000, { log });
      case 'weather':          return await weather(args.query || args.city || args.location || '北京', { log, webSearchFn: (q) => webSearch(q, { log }) });
      case 'exchange_rate':    return await exchangeRate(args.query || '');
      case 'express_tracking': return await expressTracking(args.query || '');
      case 'sports_score':     return await sportsScore(args.query || '');
      case 'calendar':         return calendar(args.query || '');
      case 'unit_convert':     return unitConvert(args.query || '');
      case 'create_artifact':  return await createArtifact(args, { log });
      case 'create_pdf':       return await createPdf(args, { log });
      case 'stock_market':     return await stockMarket(args.query || '', { log, webSearchFn: (q) => webSearch(q, { log }) });
      case 'live_news':        return await liveNews(args.query || '', { log, webSearchFn: (q) => webSearch(q, { log }) });
      case 'stock_research':   return await stockResearch(args, { log });
      case 'create_report':    return await createReport(args, { log });
      case 'create_pptx':      return await createPptx(args, { log });
      case 'parallel_research': return await parallelResearch(args, { log, dispatchFn: (subName, subArgs) => executeServerTool(subName, subArgs, { log }) });
      default: return JSON.stringify({ error: 'unhandled tool: ' + name });
    }
  } catch (e) {
    log && log('warn', 'tool-exec/' + name + ' failed: ' + (e.message || String(e)));
    return JSON.stringify({ error: e.message || String(e) });
  }
}

export function isServerTool(name) {
  return SERVER_TOOL_NAMES.has(name) || isMcpTool(name);
}

// Heavy, rarely-needed document generators. Their full JSON schemas cost ~600 tok, but a
// plain text/coding turn never needs them. We inject them only when the conversation shows
// explicit document intent (users who want these almost always say so), so the capability
// is preserved on the turns that actually need it while the common path stays lean.
export const GATED_TOOLS = new Set(['create_report', 'create_pptx', 'create_pdf', 'create_artifact']);

const DOC_INTENT_RE = new RegExp([
  // zh: a create-verb followed (within one clause) by a document object — the gap
  // covers connectors/measure-words like 成/个/一份/详细的 ("做成PPT", "做一份详细的报告").
  '(生成|制作|做|帮我做|给我做|帮我生成|导出|搞|整理|写|画|出)[^。!?,;，；\\n]{0,8}(报告|研报|分析报告|ppt|pptx|幻灯片?|演示文稿|演示|海报|pdf|artifact|预览)',
  // zh: deterministic result/data visualization export. This is NOT AI text-to-image;
  // it should route to HTML/report/artifact tools that can be rendered/exported as PNG.
  '(结果|数据|表格|榜单|图表|看板|赛程|行情)[^。!?,;，；\\n]{0,16}(出成|生成|导出|输出|做成|制成)[^。!?,;，；\\n]{0,8}(图片|长图|png|PNG|HTML|html|可视化)',
  '(出成|导出|输出|做成)[^。!?,;，；\\n]{0,8}(图片|长图|png|PNG)',
  // zh: strong standalone format words
  '研报|演示文稿|幻灯片|pptx',
  // en: a create-verb followed by a document object
  '\\b(create|generate|make|build|export|produce|draft|write)\\b[^\\n]{0,24}\\b(report|presentation|pptx?|powerpoint|slides?|slide\\s*deck|deck|pdf|artifact)\\b',
  // en: deterministic result/data/table/chart export to image or HTML
  '\\b(results?|data|tables?|rankings?|charts?|dashboard|schedule|market)\\b[^\\n]{0,40}\\b(image|long\\s*image|png|html|visuali[sz]ation)\\b',
  '\\b(export|render|turn|convert)\\b[^\\n]{0,40}\\b(image|long\\s*image|png|html)\\b',
  // en: strong standalone format words
  '\\b(pptx|powerpoint)\\b',
].join('|'), 'i');

// Does the recent conversation explicitly ask to generate a document / deck / PDF / artifact?
export function wantsGatedTools(messages) {
  if (!Array.isArray(messages)) return false;
  const text = messages
    .filter(m => m && m.role === 'user')
    .slice(-3)
    .map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''))
    .join('\n');
  return DOC_INTENT_RE.test(text);
}

const INTERNAL_LYNN_UX_RE = /(?:\bLynn\b|Session\s*Map|工作地图|右侧工作台|左侧会话列表|会话\s*digest|Huge\s*节点|从此分支|数字徽标|状态文案|验收标准|信息架构|tooltip|长会话|7GB|卡死|健康检查|搜索结果|伪相关|证据优先|搜索\s*Agent|工具链|聊天工具链|复核模型|主模型|结论冲突|产品上怎么展示|CLI\s*和\s*GUI|共用内核|回归测试矩阵|Vitest|beforeEach|React\s+useMemo|Electron\s+主进程|前端组件|业务规则)/i;
const UX_COPY_OR_DESIGN_RE = /(?:写|改写|给|设计|拟定|生成|整理|规整|避免什么|解释|为什么|怎么|展示|判断|检查|矩阵|流程|规则|策略|用途|例子|文案|按钮|tooltip|状态|标签|验收标准|信息架构|草案|伪代码|copy|wording|label)/i;
const EXPLICIT_EXTERNAL_LOOKUP_RE = /(?:(?<!检)(?<!复)查|查询|搜索(?!结果|\s*Agent)|检索|访问|打开|联网|来源|官网|官方|最新|实时|下载页|Gitee|GitHub|release|版本号|look\s*up|search|visit|fetch|source|official|latest|current)/i;
const INTERNAL_SEARCH_FAILURE_RE = /(?:三次|多次|几次)?搜索(?:都)?没(?:有)?结果|搜索失败|工具成功但最后可能空答/i;
const CODE_SNIPPET_TOOL_SUPPRESS_RE = /(?:写|给|提供|生成|解释).{0,40}(?:TypeScript|JavaScript|Node\.?js|CSS|bash|shell|zod|Electron|React|useMemo|Vitest|JSON\s*schema|IPC\s*handler|函数|schema|伪代码|布局|beforeEach|命令|行数|wc|find)/i;
const CODE_EXECUTION_RE = /(?:运行|执行|帮我跑|实际跑|检查|验证|写入|保存到|创建文件|改文件|run|execute|write\s+to|save\s+to|create\s+file)/i;
const DIRECT_SPORTS_SCORE_RE = /(?=.*(?:世界杯|世足|FIFA|NBA|足球|篮球|网球|F1|体育))(?=.*(?:赛程|比分|赛果|几场|对阵|比赛|夺冠|预测|score|fixture|match|predict))/i;
const DIRECT_STOCK_MARKET_RE = /(?=.*(?:指数|股票|股价|行情|金价|黄金|原油|基金|汇率|加密货币|比特币|stock|market|index|gold|oil|fund|forex|crypto))(?=.*(?:点位|多少|最新|行情|涨跌|收盘|现在|价格|股价|报价|quote|price|level))/i;
const STOCK_TICKER_RE = /\b[A-Z]{2,6}\b/;
const STOCK_QUOTE_INTENT_RE = /(?:点位|多少|最新|行情|涨跌|收盘|现在|价格|股价|报价|quote|price|level)/i;
const DIRECT_AIR_QUALITY_RE = /空气质量|空气污染|AQI|PM\s*2\.?5|PM10|雾霾|霾|air\s*quality|pollution/i;
const DIRECT_WEATHER_RE = /(?:天气|下雨|降雨|雨吗|气温|温度|预警|暴雨|雷暴|雷电|台风|weather|forecast|rain|alert|warning)/i;
const OFFICIAL_MODEL_RELEASE_RE = /(?:(?:OpenAI|ChatGPT|GPT|Claude|Anthropic).{0,32}(?:模型|model|发布|release|新模型|最新|最近|recent|latest|公开|代)|(?:模型|model|发布|release|新模型|最新|最近|recent|latest|公开|代).{0,32}(?:OpenAI|ChatGPT|GPT|Claude|Anthropic))/i;
const EXPLICIT_NO_TOOL_RE = /(?:不要|别|禁止|无需|不需要)(?:再)?(?:调用|使用|用|开启|触发)?[^。！？!?,，\n]{0,8}(?:任何)?(?:工具|联网|搜索|检索)|(?:without|do\s+not|don't|dont|no)\s+(?:use|using|call|calling)?\s*(?:any\s+)?(?:tools?|web|search)/i;

function latestUserText(messages) {
  if (!Array.isArray(messages)) return '';
  const message = messages.filter(m => m && m.role === 'user').slice(-1)[0];
  return message ? (typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '')) : '';
}

export function shouldSuppressToolsForCurrentTurn(messages) {
  return EXPLICIT_NO_TOOL_RE.test(latestUserText(messages));
}

export function shouldSuppressWebToolsForInternalLynnUx(messages) {
  if (!Array.isArray(messages)) return false;
  const text = messages
    .filter(m => m && m.role === 'user')
    .slice(-1)
    .map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''))
    .join('\n');
  const explicitExternalLookup = EXPLICIT_EXTERNAL_LOOKUP_RE.test(text) && !/\brelease\s+manifest\b/i.test(text);
  if (CODE_SNIPPET_TOOL_SUPPRESS_RE.test(text) && !CODE_EXECUTION_RE.test(text) && !explicitExternalLookup) {
    return true;
  }
  if (INTERNAL_SEARCH_FAILURE_RE.test(text) && UX_COPY_OR_DESIGN_RE.test(text)) {
    return true;
  }
  return INTERNAL_LYNN_UX_RE.test(text) && UX_COPY_OR_DESIGN_RE.test(text) && !explicitExternalLookup;
}

export function shouldPreferSportsScoreTool(messages) {
  if (!Array.isArray(messages)) return false;
  if (shouldSuppressToolsForCurrentTurn(messages)) return false;
  const text = messages
    .filter(m => m && m.role === 'user')
    .slice(-1)
    .map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''))
    .join('\n');
  return DIRECT_SPORTS_SCORE_RE.test(text);
}

export function shouldPreferStockMarketTool(messages) {
  if (!Array.isArray(messages)) return false;
  if (shouldSuppressToolsForCurrentTurn(messages)) return false;
  const text = messages
    .filter(m => m && m.role === 'user')
    .slice(-1)
    .map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''))
    .join('\n');
  return DIRECT_STOCK_MARKET_RE.test(text)
    || (STOCK_TICKER_RE.test(text) && STOCK_QUOTE_INTENT_RE.test(text));
}

export function shouldPreferWeatherTool(messages) {
  if (!Array.isArray(messages)) return false;
  if (shouldSuppressToolsForCurrentTurn(messages)) return false;
  const text = messages
    .filter(m => m && m.role === 'user')
    .slice(-1)
    .map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''))
    .join('\n');
  return DIRECT_AIR_QUALITY_RE.test(text) || DIRECT_WEATHER_RE.test(text);
}

export function shouldPreferOfficialModelSearchTool(messages) {
  if (!Array.isArray(messages)) return false;
  if (shouldSuppressToolsForCurrentTurn(messages)) return false;
  const text = messages
    .filter(m => m && m.role === 'user')
    .slice(-1)
    .map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''))
    .join('\n');
  return OFFICIAL_MODEL_RELEASE_RE.test(text);
}

const INHERENTLY_LIVE_LOOKUP_RE = /(?:天气|气温|下雨|降雨|空气质量|AQI|比分|赛程|股价|金价|行情|汇率|快递.{0,8}(?:状态|到哪|进度)|新闻|weather|forecast|air\s*quality|score|fixture|stock\s*price|gold\s*price|exchange\s*rate|tracking|news)/i;
const EXTERNAL_EVIDENCE_TOOL_NAMES = new Set([
  'web_search',
  'web_fetch',
  'weather',
  'exchange_rate',
  'express_tracking',
  'sports_score',
  'stock_market',
  'live_news',
  'stock_research',
  'parallel_research',
]);

export function shouldExposeExternalEvidenceTools(messages) {
  if (!Array.isArray(messages)) return false;
  if (shouldSuppressToolsForCurrentTurn(messages)) return false;
  const text = messages
    .filter(m => m && m.role === 'user')
    .slice(-1)
    .map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''))
    .join('\n');
  return EXPLICIT_EXTERNAL_LOOKUP_RE.test(text)
    || INHERENTLY_LIVE_LOOKUP_RE.test(text)
    || shouldPreferSportsScoreTool(messages)
    || shouldPreferStockMarketTool(messages)
    || shouldPreferWeatherTool(messages)
    || shouldPreferOfficialModelSearchTool(messages);
}

function policyToolName(name) {
  return String(name || '').trim().toLowerCase().replace(/-/g, '_');
}

// Merge serverTools into a client-provided tools array (de-dup by name).
// When `messages` is provided, the GATED_TOOLS document generators are injected only on
// explicit document intent; when `messages` is omitted, all server tools are injected
// (back-compat for non-chat callers and tests).
export function mergeWithServerTools(clientTools, messages) {
  const allowGated = messages === undefined ? true : wantsGatedTools(messages);
  const allowExternalEvidence = messages === undefined ? true : shouldExposeExternalEvidenceTools(messages);
  const list = (Array.isArray(clientTools) ? clientTools : []).filter((tool) => {
    const name = policyToolName(tool?.function?.name);
    if (!name) return true;
    if (!allowGated && GATED_TOOLS.has(name)) return false;
    if (!allowExternalEvidence && EXTERNAL_EVIDENCE_TOOL_NAMES.has(name)) return false;
    return true;
  });
  const seen = new Set(list.filter(t => t?.function?.name).map(t => policyToolName(t.function.name)));
  const suppressInternalReasoningTools = messages !== undefined && shouldSuppressWebToolsForInternalLynnUx(messages);
  const preferSportsScore = messages !== undefined && shouldPreferSportsScoreTool(messages);
  const preferStockMarket = messages !== undefined && shouldPreferStockMarketTool(messages);
  const preferWeather = messages !== undefined && shouldPreferWeatherTool(messages);
  const preferOfficialModelSearch = messages !== undefined && shouldPreferOfficialModelSearchTool(messages);
  for (const st of SERVER_TOOLS) {
    if (seen.has(policyToolName(st.function.name))) continue;
    if (!allowGated && GATED_TOOLS.has(st.function.name)) continue;
    if (!allowExternalEvidence && EXTERNAL_EVIDENCE_TOOL_NAMES.has(st.function.name)) continue;
    if (suppressInternalReasoningTools) continue;
    if (preferSportsScore && ['web_search', 'web_fetch', 'live_news', 'calendar', 'parallel_research'].includes(st.function.name)) continue;
    if (preferStockMarket && ['web_search', 'web_fetch', 'live_news', 'calendar', 'parallel_research'].includes(st.function.name)) continue;
    if (preferWeather && ['web_search', 'web_fetch', 'live_news', 'calendar', 'parallel_research'].includes(st.function.name)) continue;
    if (preferOfficialModelSearch && ['web_fetch', 'live_news', 'parallel_research', 'calendar'].includes(st.function.name)) continue;
    list.push(st);
  }
  // MCP 工具(akshare 等):同步快照注入;预热未完时为空,下一回合自然出现。
  if (!suppressInternalReasoningTools && allowExternalEvidence) {
    for (const mt of getMcpToolDefs()) {
      if (seen.has(policyToolName(mt.function.name))) continue;
      list.push(mt);
    }
  }
  return list;
}
