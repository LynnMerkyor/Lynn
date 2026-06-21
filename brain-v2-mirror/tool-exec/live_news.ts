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

function openAIReleaseFallback(raw) {
  return [
    '【OpenAI 官方模型发布资料】',
    '查询：' + raw,
    '说明：官方搜索超时后使用稳定官方链接候选；回答需以原页面为准。',
    '',
    '1. Introducing GPT-5.5 - OpenAI',
    '来源: openai.com',
    'URL: https://openai.com/index/introducing-gpt-5-5/',
    '摘要: GPT-5.5 and GPT-5.5 Pro are available in ChatGPT and Codex, with stronger coding, online research, data analysis, document and spreadsheet work, software operation, and tool-use capabilities.',
    '',
    '2. Model Release Notes | OpenAI Help Center',
    '来源: help.openai.com',
    'URL: https://help.openai.com/en/articles/9624314-model-release-notes',
    '摘要: GPT-5.5 Instant Update (May 28, 2026) improves response style and quality in ChatGPT and the API.',
  ].join('\n');
}

export async function liveNews(query, { log, webSearchFn } = {}) {
  const raw = compactLine(query);
  if (!raw) return JSON.stringify({ error: 'empty query' });
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
          '- https://openai.com/index/introducing-gpt-5-5/',
          '- https://help.openai.com/en/articles/9624314-model-release-notes',
        ].join('\n');
      }
    } catch {
      // Use stable official URL candidates below.
    }
    return openAIReleaseFallback(raw);
  }

  const windows = [
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
      rows.push('【搜索：' + value.q + '】\n' + text.slice(0, 1300) + (text.length > 1300 ? '\n...（已截断）' : ''));
      if (rows.length >= 2) break;
    }
    if (rows.length) {
      sections.push('## ' + win.label + '\n新鲜度：搜索候选，原文日期需要核验；近 7 天结果不等同于今天发生。\n' + rows.join('\n\n'));
    }
  }
  if (!sections.length) {
    log && log('info', 'tool-exec/live_news', 'no results for: ' + raw);
    return JSON.stringify({ error: 'no news results' });
  }
  log && log('info', 'tool-exec/live_news', 'success: ' + sections.length + ' window sections');
  return [
    '【实时新闻扩展检索】',
    '查询：' + raw,
    '说明：国内默认不依赖 Google News RSS；已自动扩展到 今日/最近36小时、最近3天、最近7天 三个窗口。部分结果可能需要打开原文核验日期。',
    '',
    sections.join('\n\n---\n\n'),
  ].join('\n');
}
