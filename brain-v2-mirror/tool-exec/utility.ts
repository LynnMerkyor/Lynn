// @ts-nocheck
// Brain v2 · utility tools
// Keep this module self-contained so the mirrored brain-v2 tree can run tests
// outside the production /opt/lobster-brain directory.

export async function exchangeRate(query) {
  try {
    const pairs = {
      '美元': 'USDCNY',
      '欧元': 'EURCNY',
      '英镑': 'GBPCNY',
      '日元': 'JPYCNY',
      '港币': 'HKDCNY',
      '澳元': 'AUDCNY',
      '加元': 'CADCNY',
      '瑞郎': 'CHFCNY',
      '韩元': 'KRWCNY',
      '新加坡': 'SGDCNY',
      '泰铢': 'THBCNY',
    };
    let codes = [];
    for (const [name, code] of Object.entries(pairs)) {
      if (String(query || '').includes(name)) codes.push(code);
    }
    if (!codes.length) codes = ['USDCNY', 'EURCNY', 'GBPCNY', 'JPYCNY', 'HKDCNY'];

    const sinaList = codes.map((c) => 'fx_s' + c.toLowerCase()).join(',');
    const resp = await fetch('http://hq.sinajs.cn/list=' + sinaList, {
      headers: { Referer: 'https://finance.sina.com.cn' },
      signal: AbortSignal.timeout(8000),
    });
    const text = await resp.text();
    const results = [];
    const nameMap = {
      usdcny: '美元/人民币',
      eurcny: '欧元/人民币',
      gbpcny: '英镑/人民币',
      jpycny: '日元/人民币(100)',
      hkdcny: '港币/人民币',
      audcny: '澳元/人民币',
      cadcny: '加元/人民币',
      chfcny: '瑞郎/人民币',
      krwcny: '韩元/人民币(100)',
      sgdcny: '新加坡元/人民币',
      thbcny: '泰铢/人民币',
    };
    for (const line of text.split('\n')) {
      const m = line.match(/var hq_str_fx_s(\w+)="([^"]+)"/);
      if (!m) continue;
      const d = m[2].split(',');
      if (d.length < 8) continue;
      const name = nameMap[m[1]] || m[1];
      results.push(`${name}: ${d[1]} (${parseFloat(d[5]) >= 0 ? '+' : ''}${d[5]}%) 更新: ${d[0]}`);
    }
    return results.length ? '【实时汇率】\n' + results.join('\n') : JSON.stringify({ error: '汇率查询失败' });
  } catch (e) {
    return JSON.stringify({ error: e.message || '汇率查询失败' });
  }
}

export async function sportsScore(query) {
  const q = String(query || '');
  const league = resolveEspnLeague(q);
  if (!league) {
    return JSON.stringify({
      status: 'no_direct_source',
      query: q,
      guidance: '暂未识别到可直连的体育联赛数据源,请改用 web_search 检索 赛事+比分/赛果/赛程 等关键词,并以来源页面为准。',
    });
  }

  const range = resolveSportsDateRange(q, league);
  const url = `https://site.api.espn.com/apis/site/v2/sports/${league.path}/scoreboard?limit=950&dates=${range.start}-${range.end}`;
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'lobster-brain-v2/0.0' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return JSON.stringify({ error: `ESPN scoreboard HTTP ${resp.status}`, source: url });
    const data = await resp.json();
    const events = Array.isArray(data?.events) ? data.events : [];
    const rows = filterSportsRows(events.map(formatEspnEvent).filter(Boolean), q, range);
    const scoreRows = rows.filter((row) => row.completed && /\d+\s*[-–—:：比]\s*\d+/.test(row.line));
    const wantsScores = /(比分|赛果|结果|已出|已经|完赛|score|result|final)/i.test(q);
    const selected = (wantsScores ? scoreRows : rows).slice(-24);
    if (!selected.length) {
      return JSON.stringify({
        status: 'no_score_events',
        query: q,
        provider: 'espn_scoreboard',
        source: url,
        dateRange: `${range.start}-${range.end}`,
        events: rows.length,
      });
    }
    return [
      `provider: espn_scoreboard`,
      `league: ${league.label}`,
      `source: ${url}`,
      `dateRange: ${range.start}-${range.end}`,
      '',
      ...selected.map((row) => `- ${row.line}`),
    ].join('\n');
  } catch (e) {
    return JSON.stringify({ error: e.message || 'ESPN scoreboard lookup failed', source: url });
  }
}

function resolveEspnLeague(query) {
  const q = String(query || '');
  if (/(世界杯|FIFA|World Cup|fifa\.world)/i.test(q)) {
    return { label: 'FIFA World Cup', path: 'soccer/fifa.world', tournamentStart: '2026-06-11', tournamentEnd: '2026-07-19' };
  }
  if (/\bNBA\b|总决赛|尼克斯|马刺|湖人|勇士|凯尔特人/i.test(q)) {
    return { label: 'NBA', path: 'basketball/nba' };
  }
  return null;
}

function beijingYmd(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const pick = (type) => parts.find((part) => part.type === type)?.value || '';
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

function ymdCompact(ymd) {
  return String(ymd || '').replace(/-/g, '');
}

function addDaysYmd(ymd, days) {
  const date = new Date(`${ymd}T00:00:00+08:00`);
  date.setUTCDate(date.getUTCDate() + days);
  return beijingYmd(date);
}

function resolveSportsDateRange(query, league) {
  const q = String(query || '');
  const today = beijingYmd();
  if (league?.label === 'FIFA World Cup') {
    if (/(半决赛|准决赛|semifinal|semi-final|semi final)/i.test(q)) {
      return { start: '20260714', end: '20260715' };
    }
    if (/(决赛|final)/i.test(q) && !/(半决赛|semifinal|semi-final|semi final)/i.test(q)) {
      return { start: '20260719', end: '20260719' };
    }
    if (/(已出|已经|比分|赛果|结果|完赛|score|result)/i.test(q)) {
      return { start: ymdCompact(league.tournamentStart), end: ymdCompact(today) };
    }
  }
  if (/(昨晚|昨天|昨日|yesterday)/i.test(q)) {
    return { start: ymdCompact(addDaysYmd(today, -1)), end: ymdCompact(today) };
  }
  if (/(明天|明日|tomorrow)/i.test(q)) {
    const tomorrow = addDaysYmd(today, 1);
    return { start: ymdCompact(tomorrow), end: ymdCompact(tomorrow) };
  }
  if (/(今晚|今夜|今天|今日|today|tonight)/i.test(q)) {
    return { start: ymdCompact(today), end: ymdCompact(addDaysYmd(today, 1)) };
  }
  return { start: ymdCompact(addDaysYmd(today, -7)), end: ymdCompact(addDaysYmd(today, 1)) };
}

function formatEspnEvent(event) {
  const competition = event?.competitions?.[0];
  const competitors = Array.isArray(competition?.competitors) ? competition.competitors : [];
  if (!competition || competitors.length < 2) return null;
  const home = competitors.find((item) => item.homeAway === 'home') || competitors[0];
  const away = competitors.find((item) => item.homeAway === 'away') || competitors.find((item) => item !== home) || competitors[1];
  const homeName = home?.team?.displayName || home?.team?.shortDisplayName || 'Home';
  const awayName = away?.team?.displayName || away?.team?.shortDisplayName || 'Away';
  const homeScore = home?.score ?? '';
  const awayScore = away?.score ?? '';
  const status = event?.status?.type || competition?.status?.type || {};
  const completed = Boolean(status.completed);
  const statusText = status.shortDetail || status.detail || status.name || '';
  const date = new Date(event?.date || Date.now());
  const dateText = formatBeijingDateTime(date);
  const localParts = beijingDateTimeParts(date);
  const score = completed && homeScore !== '' && awayScore !== '' ? `${homeScore}-${awayScore}` : 'vs';
  return {
    completed,
    localYmd: localParts.ymd,
    localHour: localParts.hour,
    line: `${dateText} ${homeName} ${score} ${awayName}${statusText ? ` (${statusText})` : ''}`,
  };
}

function filterSportsRows(rows, query, range) {
  const q = String(query || '');
  const today = beijingYmd();
  const tomorrow = addDaysYmd(today, 1);
  const yesterday = addDaysYmd(today, -1);
  if (/(今晚|今夜|tonight)/i.test(q)) {
    return rows.filter((row) => (row.localYmd === today && row.localHour >= 18) || row.localYmd === tomorrow);
  }
  if (/(今天|今日|today)/i.test(q)) {
    return rows.filter((row) => row.localYmd === today);
  }
  if (/(昨晚|昨天|昨日|yesterday)/i.test(q)) {
    return rows.filter((row) => (row.localYmd === yesterday && row.localHour >= 18) || (row.localYmd === today && row.localHour <= 12));
  }
  const start = compactToYmd(range.start);
  const end = compactToYmd(range.end);
  return rows.filter((row) => row.localYmd >= start && row.localYmd <= end);
}

function formatBeijingDateTime(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return String(value || '');
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function beijingDateTimeParts(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const pick = (type) => parts.find((part) => part.type === type)?.value || '';
  return { ymd: `${pick('year')}-${pick('month')}-${pick('day')}`, hour: Number(pick('hour') || 0) };
}

function compactToYmd(value) {
  const raw = String(value || '');
  if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  return raw;
}

export async function expressTracking(query) {
  try {
    const numMatch = String(query || '').match(/[A-Za-z0-9]{10,20}/);
    if (!numMatch) return JSON.stringify({ error: '请提供快递单号（10-20位字母数字）' });
    const num = numMatch[0];

    const resp = await fetch('https://www.kuaidi100.com/autonumber/autoComNum?resultv2=1&text=' + num, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000),
    });
    const data = await resp.json();
    const carrier = data.auto?.[0]?.comCode;
    if (!carrier) return JSON.stringify({ error: '无法识别快递公司，请确认单号' });

    const trackResp = await fetch('https://www.kuaidi100.com/query?type=' + carrier + '&postid=' + num, {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.kuaidi100.com/' },
      signal: AbortSignal.timeout(8000),
    });
    const trackData = await trackResp.json();
    if (trackData.data && trackData.data.length) {
      const lines = trackData.data.slice(0, 5).map((d) => d.time + ' ' + d.context);
      return '【快递追踪: ' + num + '】\n快递公司: ' + (trackData.com || carrier) + '\n状态: ' + (trackData.state === '3' ? '已签收' : '运输中') + '\n' + lines.join('\n');
    }
    return JSON.stringify({ error: '暂无物流信息' });
  } catch (e) {
    return JSON.stringify({ error: e.message });
  }
}

export function calendar(query) {
  const now = new Date();
  const info = {
    today: now.toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      weekday: 'long',
      timeZone: 'Asia/Shanghai',
    }),
    weekOfYear: Math.ceil((now - new Date(now.getFullYear(), 0, 1)) / 86400000 / 7),
    dayOfYear: Math.ceil((now - new Date(now.getFullYear(), 0, 1)) / 86400000),
    daysInMonth: new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate(),
    isWeekend: now.getDay() === 0 || now.getDay() === 6,
  };

  const dateMatch = String(query || '').match(/(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})/);
  let targetText = '';
  if (dateMatch) {
    const target = new Date(dateMatch[1], dateMatch[2] - 1, dateMatch[3]);
    const diff = Math.round((target - now) / 86400000);
    targetText = '\n\n' + (diff > 0 ? `距离目标日期还有 ${diff} 天` : diff < 0 ? `目标日期已过去 ${Math.abs(diff)} 天` : '就是今天');
  }

  return `【日历信息】\n今天: ${info.today}\n本年第 ${info.weekOfYear} 周，第 ${info.dayOfYear} 天\n本月共 ${info.daysInMonth} 天\n${info.isWeekend ? '今天是周末' : '今天是工作日'}${targetText}`;
}

export function unitConvert(query) {
  const conversions = {
    '摄氏': (v) => ({ result: v * 9 / 5 + 32, unit: '华氏度(°F)' }),
    '华氏': (v) => ({ result: (v - 32) * 5 / 9, unit: '摄氏度(°C)' }),
    '公里': (v) => ({ result: v * 0.6214, unit: '英里' }),
    '英里': (v) => ({ result: v * 1.6093, unit: '公里' }),
    '米': (v) => ({ result: v * 3.2808, unit: '英尺' }),
    '英尺': (v) => ({ result: v * 0.3048, unit: '米' }),
    '厘米': (v) => ({ result: v * 0.3937, unit: '英寸' }),
    '英寸': (v) => ({ result: v * 2.54, unit: '厘米' }),
    '公斤': (v) => ({ result: v * 2.2046, unit: '磅' }),
    '磅': (v) => ({ result: v * 0.4536, unit: '公斤' }),
    '斤': (v) => ({ result: v * 0.5, unit: '公斤' }),
    '盎司': (v) => ({ result: v * 28.3495, unit: '克' }),
    '平方米': (v) => ({ result: v * 10.7639, unit: '平方英尺' }),
    '亩': (v) => ({ result: v * 666.67, unit: '平方米' }),
    '公顷': (v) => ({ result: v * 15, unit: '亩' }),
    '升': (v) => ({ result: v * 0.2642, unit: '加仑' }),
    '加仑': (v) => ({ result: v * 3.7854, unit: '升' }),
  };

  const numMatch = String(query || '').match(/([\d.]+)\s*(摄氏|华氏|公里|英里|米|英尺|厘米|英寸|公斤|磅|斤|盎司|平方米|亩|公顷|升|加仑)/);
  if (!numMatch) return '请提供数值和单位，如"100公里"、"37.5摄氏"、"150磅"';

  const value = parseFloat(numMatch[1]);
  const unit = numMatch[2];
  const fn = conversions[unit];
  if (!fn) return '不支持的单位: ' + unit;

  const r = fn(value);
  return `【单位换算】\n${value} ${unit} = ${r.result.toFixed(4)} ${r.unit}`;
}
