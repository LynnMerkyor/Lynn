// @ts-nocheck
// Brain v2 · tool-exec/live_news
// 多窗口扩展新闻检索 (今日/3天/7天) - 调用 web_search 子工具
// Ported from brain v1 server.js (lines 4832-4977)

function compactLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function todayCnText() {
  try {
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const obj = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    return obj.year + '年' + obj.month + '月' + obj.day + '日';
  } catch {
    const d = new Date(Date.now() + 8 * 3600 * 1000);
    return d.getUTCFullYear() + '年' + String(d.getUTCMonth() + 1).padStart(2, '0') + '月' + String(d.getUTCDate()).padStart(2, '0') + '日';
  }
}

function todayDateParts() {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const obj = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    return { year: obj.year, month: obj.month, day: obj.day };
  } catch {
    const d = new Date(Date.now() + 8 * 3600 * 1000);
    return {
      year: String(d.getUTCFullYear()),
      month: String(d.getUTCMonth() + 1).padStart(2, '0'),
      day: String(d.getUTCDate()).padStart(2, '0'),
    };
  }
}

function todayDatePattern() {
  const { year, month, day } = todayDateParts();
  const m = String(Number(month));
  const d = String(Number(day));
  return new RegExp([
    year + '[-/年]\\s*0?' + m + '[-/月]\\s*0?' + d + '(?:日)?',
    '0?' + m + '月\\s*0?' + d + '日',
    '0?' + m + '[-/]0?' + d,
  ].join('|'));
}

function isStrictSameDayNewsQuery(query) {
  const text = compactLine(query);
  if (!/(?:今天|今日|当前|现在|实时|latest|today|current)/i.test(text)) return false;
  return /(?:新闻|消息|更新|动态|热点|进展|news|update)/i.test(text);
}

function buildExpansionQueries(query, days) {
  const raw = compactLine(String(query || '').replace(/(?:昨晚|昨夜|昨天|昨日|前天|前晚|前日|今早|今晨|今晚|今夜|凌晨|清晨|早间|晚间|刚刚|刚才|方才|此前|日前|早些时候|稍早|yesterday)/gi, ' '));
  const core = compactLine(raw.replace(/(?:请|帮我|查一下|查查|搜索|查询|全网|今天|今日|最新|新闻|有什么|哪些|一下)/g, ' ')) || raw;
  const dateText = todayCnText();
  const windowText = Number(days) <= 1 ? '今日 最新' : '近' + days + '天 最新';
  const queries = [
    raw + ' ' + windowText + ' 消息 新闻',
    core + ' ' + dateText + ' ' + windowText + ' 新闻',
  ];
  if (/干细胞|细胞治疗|再生医学|临床|医疗|医药|医院|药企/i.test(raw)) {
    queries.push(core + ' 细胞治疗 临床研究 产业 政策 进展 ' + windowText);
    queries.push(core + ' 再生医学 医院 药企 备案 ' + windowText);
  } else if (/AI|人工智能|大模型|模型|芯片|半导体|机器人|科技/i.test(raw)) {
    queries.push(core + ' 行业 公司 产品 发布 ' + windowText);
  } else {
    queries.push(core + ' 进展 影响 来源 ' + windowText);
  }
  return [...new Set(queries.map(compactLine).filter(Boolean))].slice(0, 3);
}

function isOpenAIModelReleaseQuery(query) {
  const text = compactLine(query);
  if (!/(?:OpenAI|ChatGPT|GPT|Codex)/i.test(text)) return false;
  if (!/(?:模型|model|发布|release|新模型|最新|最近|recent|latest)/i.test(text)) return false;
  return !/(?:怎么用|API\s*key|报错|配置|价格|pricing|账单|billing)/i.test(text);
}

function isMarketMovementLookup(query) {
  const text = compactLine(query);
  if (!/(?:A\s*股|a\s*股|A股|a股|沪深|上证|深证|创业板|股市|行情|异动|板块|涨跌|领涨|领跌|指数)/i.test(text)) return false;
  return !/(?:新闻|消息|政策|监管|公告|舆情|发布会|news|policy|announcement)/i.test(text);
}

function openAIReleaseFallback(raw) {
  return [
    '【OpenAI 官方模型发布资料】',
    '查询：' + raw,
    '说明：官方搜索超时后只提供官方入口候选；不得把候选链接解读为已确认的新模型。',
    '',
    '1. OpenAI News',
    '来源: openai.com',
    'URL: https://openai.com/news/',
    '摘要: OpenAI 官方新闻入口；具体最近发布的新模型必须以页面原文为准。',
    '',
    '2. Model Release Notes | OpenAI Help Center',
    '来源: help.openai.com',
    'URL: https://help.openai.com/en/articles/9624314-model-release-notes',
    '摘要: OpenAI 帮助中心模型发布说明；如本轮未抓到具体条目，应明确证据不足。',
    '',
    '3. OpenAI API model docs',
    '来源: platform.openai.com',
    'URL: https://platform.openai.com/docs/models',
    '摘要: OpenAI API 官方模型列表；具体可用模型以原页面为准。',
  ].join('\n');
}

export async function liveNews(query, { log, webSearchFn } = {}) {
  const raw = compactLine(query);
  if (!raw) return JSON.stringify({ error: 'empty query' });
  if (isMarketMovementLookup(raw)) {
    return [
      '【实时新闻扩展检索】',
      '查询：' + raw,
      '状态：market_lookup_misroute',
      '说明：这是股市行情/盘面异动问题，不适合用 live_news 三窗口新闻扩展；请改用 stock_market 获取指数、板块或行情快照，避免新闻搜索拖慢或引入旧日期内容。',
    ].join('\n');
  }
  if (typeof webSearchFn !== 'function') {
    return JSON.stringify({ error: 'live_news 需要注入 webSearchFn' });
  }
  if (isOpenAIModelReleaseQuery(raw)) {
    const q = 'site:openai.com OpenAI latest model release GPT model 2026';
    try {
      const text = compactLine(await webSearchFn(q));
      if (text) {
        log && log('info', 'tool-exec/live_news', 'openai release fast path');
        return [
          '【OpenAI 官方模型发布资料】',
          '查询：' + raw,
          '说明：已走 OpenAI 官方域名快路径，避免通用新闻三窗口扩展。',
          '',
          '【搜索：' + q + '】',
          text.slice(0, 2600) + (text.length > 2600 ? '\n...（已截断）' : ''),
          '',
          '官方链接候选：',
          '- https://openai.com/news/',
          '- https://help.openai.com/en/articles/9624314-model-release-notes',
          '- https://platform.openai.com/docs/models',
        ].join('\n');
      }
    } catch {
      // Use stable official URL candidates below.
    }
    return openAIReleaseFallback(raw);
  }

  const strictSameDay = isStrictSameDayNewsQuery(raw);
  const currentDatePattern = todayDatePattern();
  const windows = strictSameDay
    ? [{ days: 1, label: '今日/最近36小时' }]
    : [
        { days: 1, label: '今日/最近36小时' },
        { days: 3, label: '最近3天' },
        { days: 7, label: '最近7天' },
      ];
  const sections = [];
  for (const win of windows) {
    const qs = buildExpansionQueries(raw, win.days);
    const jobs = qs.map((q) =>
      webSearchFn(q)
        .then((text) => ({ q, text }))
        .catch((err) => ({ q, text: '', error: err && err.message })),
    );
    const settled = await Promise.allSettled(jobs);
    const rows = [];
    for (const item of settled) {
      const value = item.status === 'fulfilled' ? item.value : null;
      const text = compactLine(value && value.text);
      if (!text) continue;
      if (strictSameDay && !currentDatePattern.test(text)) continue;
      rows.push('【搜索：' + value.q + '】\n' + text.slice(0, 1300) + (text.length > 1300 ? '\n...（已截断）' : ''));
      if (rows.length >= 2) break;
    }
    if (rows.length) {
      sections.push('## ' + win.label + '\n新鲜度：搜索候选，原文日期需要核验；近 7 天结果不等同于今天发生。\n' + rows.join('\n\n'));
    }
  }
  if (!sections.length) {
    if (strictSameDay) {
      log && log('info', 'tool-exec/live_news', 'no same-day results for: ' + raw);
      return [
        '【实时新闻扩展检索】',
        '查询：' + raw,
        '状态：no_same_day_evidence',
        '日期：' + todayCnText(),
        '说明：未查到日期明确匹配今天的可靠新闻更新；为避免把旧日期内容冒充“今天”，本次不展开最近3天/最近7天背景清单。',
        '最终回答要求：直接说明未查到今天的可靠更新；不要列出旧日期新闻、背景新闻或传闻清单。',
      ].join('\n');
    }
    log && log('info', 'tool-exec/live_news', 'no results for: ' + raw);
    return JSON.stringify({ error: 'no news results' });
  }
  log && log('info', 'tool-exec/live_news', 'success: ' + sections.length + ' window sections');
  return [
    '【实时新闻扩展检索】',
    '查询：' + raw,
    '说明：国内默认不依赖 Google News RSS；已自动扩展到 今日/最近36小时、最近3天、最近7天 三个窗口。部分结果可能需要打开原文核验日期。',
    '新鲜度规则：如果用户问“今天/今日/当前/最新”，最终回答只可把今日/最近36小时且日期明确匹配的来源当作结论；近3天/近7天内容只能作为背景。没有同日证据时，请直接说“未查到今天的可靠更新”，不要展开旧日期新闻清单。',
    '',
    sections.join('\n\n---\n\n'),
  ].join('\n');
}
