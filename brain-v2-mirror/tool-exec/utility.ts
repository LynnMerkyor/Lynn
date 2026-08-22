// @ts-nocheck
// Brain v2 · utility tools
// Keep this module self-contained so the mirrored brain-v2 tree can run tests
// outside the production /opt/lobster-brain directory.
import { fetchSportsScoreboardEvidence } from '../../shared/sports-scoreboard.js';

function compact(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function resolveFxCodes(query) {
  const pairs = {
    '美元': 'USDCNY',
    '欧元': 'EURCNY',
    '英镑': 'GBPCNY',
    '日元': 'JPYCNY',
    '港币': 'HKDCNY',
    '港元': 'HKDCNY',
    '澳元': 'AUDCNY',
    '加元': 'CADCNY',
    '瑞郎': 'CHFCNY',
    '韩元': 'KRWCNY',
    '新加坡': 'SGDCNY',
    '泰铢': 'THBCNY',
  };
  const explicit = compact(query).toUpperCase().match(/\b([A-Z]{3})\s*[\/-]?\s*([A-Z]{3})\b/);
  if (explicit) return [`${explicit[1]}${explicit[2]}`];
  const codes = [];
  for (const [name, code] of Object.entries(pairs)) {
    if (String(query || '').includes(name) && !codes.includes(code)) codes.push(code);
  }
  return codes.length ? codes : ['USDCNY', 'EURCNY', 'GBPCNY', 'JPYCNY', 'HKDCNY'];
}

function formatFxNumber(value, digits = 6) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value || '').trim();
  return n.toFixed(digits).replace(/(?:\.0+|(\.\d*?)0+)$/, '$1');
}

async function fetchSinaExchangeRates(codes) {
  const sinaList = codes.map((c) => 'fx_s' + c.toLowerCase()).join(',');
  const resp = await fetch('http://hq.sinajs.cn/list=' + sinaList, {
    headers: { Referer: 'https://finance.sina.com.cn' },
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) throw new Error('Sina FX HTTP ' + resp.status);
  const text = await resp.text();
  const results = [];
  const metaMap = {
    usdcny: { label: '美元/人民币', base: '美元', quote: '人民币' },
    eurcny: { label: '欧元/人民币', base: '欧元', quote: '人民币' },
    gbpcny: { label: '英镑/人民币', base: '英镑', quote: '人民币' },
    jpycny: { label: '日元/人民币', base: '日元', quote: '人民币', showHundred: true },
    hkdcny: { label: '港币/人民币', base: '港币', quote: '人民币' },
    audcny: { label: '澳元/人民币', base: '澳元', quote: '人民币' },
    cadcny: { label: '加元/人民币', base: '加元', quote: '人民币' },
    chfcny: { label: '瑞郎/人民币', base: '瑞郎', quote: '人民币' },
    krwcny: { label: '韩元/人民币', base: '韩元', quote: '人民币', showHundred: true },
    sgdcny: { label: '新加坡元/人民币', base: '新加坡元', quote: '人民币' },
    thbcny: { label: '泰铢/人民币', base: '泰铢', quote: '人民币' },
  };
  for (const line of text.split('\n')) {
    const m = line.match(/var hq_str_fx_s(\w+)="([^"]+)"/);
    if (!m) continue;
    const d = m[2].split(',');
    if (d.length < 2) continue;
    const key = String(m[1] || '').toLowerCase();
    const meta = metaMap[key] || { label: key.toUpperCase(), base: key.slice(0, 3).toUpperCase(), quote: key.slice(3).toUpperCase() };
    const rate = Number(d[1]);
    if (!Number.isFinite(rate)) continue;
    const pct = Number(d[10]);
    const change = Number(d[11]);
    const updated = [d[17], d[0]].filter(Boolean).join(' ').trim();
    const bits = [`${meta.label}: 1 ${meta.base} = ${formatFxNumber(rate)} ${meta.quote}`];
    if (meta.showHundred) bits.push(`100 ${meta.base} ≈ ${formatFxNumber(rate * 100, 4)} ${meta.quote}`);
    if (Number.isFinite(pct)) bits.push(`涨跌幅 ${pct >= 0 ? '+' : ''}${formatFxNumber(pct, 4)}%`);
    if (Number.isFinite(change)) bits.push(`涨跌 ${change >= 0 ? '+' : ''}${formatFxNumber(change, 6)}`);
    if (updated) bits.push(`更新: ${updated}`);
    results.push(bits.join('；'));
  }
  if (!results.length) throw new Error('Sina FX empty result');
  return `【市场汇率快照】\nprovider: sina_fx\nsource: https://finance.sina.com.cn/forex/\n${results.join('\n')}`;
}

async function fetchEcbExchangeRates(codes) {
  const currencies = [...new Set(codes.flatMap((code) => [code.slice(0, 3), code.slice(3, 6)]).filter((code) => code && code !== 'EUR'))];
  if (!currencies.length) return '';
  const key = currencies.join('+');
  const url = `https://data-api.ecb.europa.eu/service/data/EXR/D.${key}.EUR.SP00.A?lastNObservations=1&format=csvdata`;
  const resp = await fetch(url, {
    headers: { Accept: 'text/csv', 'User-Agent': 'LynnBrain/0.86 ECB-reference-rates' },
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) throw new Error('ECB FX HTTP ' + resp.status);
  const text = await resp.text();
  const lines = text.trim().split(/\r?\n/);
  const header = (lines.shift() || '').split(',');
  const currencyIndex = header.indexOf('CURRENCY');
  const dateIndex = header.indexOf('TIME_PERIOD');
  const valueIndex = header.indexOf('OBS_VALUE');
  if (currencyIndex < 0 || dateIndex < 0 || valueIndex < 0) throw new Error('ECB FX CSV schema mismatch');
  const byCurrency = new Map([['EUR', { value: 1, date: '' }]]);
  for (const line of lines) {
    const cols = line.split(',');
    const currency = compact(cols[currencyIndex]).toUpperCase();
    const value = Number(cols[valueIndex]);
    if (!currency || !Number.isFinite(value)) continue;
    byCurrency.set(currency, { value, date: compact(cols[dateIndex]) });
  }
  const results = [];
  for (const code of codes) {
    const base = code.slice(0, 3).toUpperCase();
    const quote = code.slice(3, 6).toUpperCase();
    const baseRow = byCurrency.get(base);
    const quoteRow = byCurrency.get(quote);
    if (!baseRow || !quoteRow) continue;
    const rate = quoteRow.value / baseRow.value;
    const date = quoteRow.date || baseRow.date;
    results.push(`${base}/${quote}: 1 ${base} = ${formatFxNumber(rate)} ${quote}${date ? `；参考日期 ${date}` : ''}`);
  }
  if (!results.length) throw new Error('ECB FX pair unavailable');
  return `【ECB 官方参考汇率（日度，非实时成交价）】\nprovider: ecb_official\nsource: ${url}\n${results.join('\n')}`;
}

export async function exchangeRate(query) {
  const codes = resolveFxCodes(query);
  const [sina, ecb] = await Promise.allSettled([
    fetchSinaExchangeRates(codes),
    fetchEcbExchangeRates(codes),
  ]);
  const sections = [sina, ecb].filter((entry) => entry.status === 'fulfilled' && compact(entry.value)).map((entry) => entry.value);
  if (sections.length) {
    return `${sections.join('\n\n')}\n\n口径说明：市场快照用于观察当前报价；ECB 为欧洲央行每个工作日发布的官方参考汇率，不能替代银行结售汇或实时成交价。`;
  }
  const errors = [sina, ecb].map((entry) => entry.status === 'rejected' ? compact(entry.reason?.message || entry.reason) : '').filter(Boolean);
  return JSON.stringify({ error: '汇率查询失败', sources: ['sina_fx', 'ecb_official'], details: errors });
}

function beijingDate(offsetDays = 0) {
  const shifted = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(shifted);
}

function ymdOffset(ymd, offsetDays) {
  const [year, month, day] = String(ymd || '').split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + offsetDays, 12, 0, 0));
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : ymd;
}

function beijingYmdFromInstant(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function sportsTargetDate(query) {
  if (/后天|day after tomorrow/i.test(query)) return beijingDate(2);
  if (/明天|明日|tomorrow/i.test(query)) return beijingDate(1);
  if (/昨天|昨日|昨晚|yesterday/i.test(query)) return beijingDate(-1);
  return beijingDate(0);
}

function beijingDateTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return compact(value);
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date).replace(/\//g, '-');
}

async function fetchMlbOfficialScore(query) {
  if (!/(?:\bMLB\b|美国职业棒球|美职棒|大联盟)/i.test(query)) return '';
  const date = sportsTargetDate(query);
  const startDate = ymdOffset(date, -1);
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=${startDate}&endDate=${date}&hydrate=team`;
  const resp = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'LynnBrain/0.86 MLB-official' },
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) throw new Error('MLB Stats API HTTP ' + resp.status);
  const data = await resp.json();
  const games = (Array.isArray(data?.dates) ? data.dates : [])
    .flatMap((entry) => Array.isArray(entry?.games) ? entry.games : [])
    .filter((game) => beijingYmdFromInstant(game?.gameDate) === date);
  const lines = games.slice(0, 20).map((game) => {
    const away = compact(game?.teams?.away?.team?.name || game?.teams?.away?.team?.abbreviation || 'Away');
    const home = compact(game?.teams?.home?.team?.name || game?.teams?.home?.team?.abbreviation || 'Home');
    const awayScore = game?.teams?.away?.score;
    const homeScore = game?.teams?.home?.score;
    const completed = /Final|Completed/i.test(compact(game?.status?.abstractGameState) + ' ' + compact(game?.status?.detailedState));
    const score = completed || Number.isFinite(Number(awayScore)) || Number.isFinite(Number(homeScore))
      ? `${away} ${awayScore ?? '-'}-${homeScore ?? '-'} ${home}`
      : `${away} vs ${home}`;
    return `- ${beijingDateTime(game?.gameDate)} ${score} (${compact(game?.status?.detailedState) || 'Scheduled'})`;
  });
  return [
    '体育查询结果 (MLB official Stats API)',
    'provider: mlb_official',
    'league: Major League Baseball',
    `source: ${url}`,
    `北京时间查询日期: ${date}`,
    `matched: ${lines.length}`,
    ...(lines.length ? lines : ['- 该日期未返回 MLB 比赛。']),
  ].join('\n');
}

async function fetchNhlOfficialScore(query) {
  if (!/(?:\bNHL\b|国家冰球联盟|北美冰球|冰球联盟)/i.test(query)) return '';
  const date = sportsTargetDate(query);
  const urls = [ymdOffset(date, -1), date].map((value) => `https://api-web.nhle.com/v1/score/${value}`);
  const responses = await Promise.all(urls.map(async (url) => {
    const resp = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'LynnBrain/0.86 NHL-official' },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) throw new Error('NHL API HTTP ' + resp.status);
    return await resp.json();
  }));
  const seen = new Set();
  const games = responses.flatMap((data) => Array.isArray(data?.games) ? data.games : []).filter((game) => {
    if (beijingYmdFromInstant(game?.startTimeUTC) !== date) return false;
    const key = String(game?.id || `${game?.startTimeUTC}:${game?.awayTeam?.abbrev}:${game?.homeTeam?.abbrev}`);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const lines = games.slice(0, 20).map((game) => {
    const away = compact(game?.awayTeam?.abbrev || game?.awayTeam?.commonName?.default || 'Away');
    const home = compact(game?.homeTeam?.abbrev || game?.homeTeam?.commonName?.default || 'Home');
    const terminal = /FINAL|OFF/i.test(compact(game?.gameState));
    const hasScore = terminal || Number.isFinite(Number(game?.awayTeam?.score)) || Number.isFinite(Number(game?.homeTeam?.score));
    const score = hasScore
      ? `${away} ${game?.awayTeam?.score ?? '-'}-${game?.homeTeam?.score ?? '-'} ${home}`
      : `${away} vs ${home}`;
    return `- ${beijingDateTime(game?.startTimeUTC)} ${score} (${compact(game?.gameState) || 'FUT'})`;
  });
  return [
    '体育查询结果 (NHL official API)',
    'provider: nhl_official',
    'league: National Hockey League',
    `source: ${urls.join(' | ')}`,
    `北京时间查询日期: ${date}`,
    `matched: ${lines.length}`,
    ...(lines.length ? lines : ['- 该日期未返回 NHL 比赛。']),
  ].join('\n');
}

export async function sportsScore(query) {
  const q = String(query || '');
  const officialAttempts = await Promise.allSettled([
    fetchMlbOfficialScore(q),
    fetchNhlOfficialScore(q),
  ]);
  const official = officialAttempts
    .filter((entry) => entry.status === 'fulfilled' && compact(entry.value))
    .map((entry) => entry.value);
  if (official.length) return official.join('\n\n');
  try {
    const result = await fetchSportsScoreboardEvidence(q);
    if (result) return result.text;
    return JSON.stringify({
      directSourceStatus: 'unavailable',
      query: q,
      guidance: '暂未识别到可直连的体育联赛数据源；不会用泛搜索摘要冒充比分、赛果或赛程。',
    });
  } catch (e) {
    return JSON.stringify({
      directSourceStatus: 'unavailable',
      query: q,
      error: e.message || 'ESPN scoreboard lookup failed',
      guidance: '专用体育数据源本轮不可用；不会用泛搜索摘要冒充比分、赛果或赛程。',
    });
  }
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

const CHINA_HOLIDAYS_2026 = [
  { name: '元旦', holiday: '1月1日至3日，共3天', workdays: '1月4日（周日）上班' },
  { name: '春节', holiday: '2月15日至23日，共9天', workdays: '2月14日（周六）、2月28日（周六）上班' },
  { name: '清明节', holiday: '4月4日至6日，共3天', workdays: '无额外调休上班日' },
  { name: '劳动节', holiday: '5月1日至5日，共5天', workdays: '5月9日（周六）上班' },
  { name: '端午节', holiday: '6月19日至21日，共3天', workdays: '无额外调休上班日' },
  { name: '中秋节', holiday: '9月25日至27日，共3天', workdays: '无额外调休上班日' },
  { name: '国庆节', holiday: '10月1日至7日，共7天', workdays: '9月20日（周日）、10月10日（周六）上班' },
];

const CHINA_HOLIDAY_2026_SOURCE = 'https://www.gov.cn/zhengce/content/202511/content_7047090.htm';

function officialChinaHoliday2026(query) {
  const q = compact(query);
  if (!/放假|假期|节假日|调休|上班|元旦|春节|清明|劳动节|五一|端午|中秋|国庆/i.test(q)) return '';
  const requestedYear = q.match(/20\d{2}/)?.[0] || '2026';
  if (requestedYear !== '2026') return '';
  const aliases = { 五一: '劳动节', 清明: '清明节', 国庆: '国庆节' };
  const named = CHINA_HOLIDAYS_2026.find((entry) => q.includes(entry.name))
    || Object.entries(aliases).map(([alias, name]) => q.includes(alias) ? CHINA_HOLIDAYS_2026.find((entry) => entry.name === name) : null).find(Boolean);
  const rows = named ? [named] : CHINA_HOLIDAYS_2026;
  return [
    '【2026 年中国法定节假日安排（国务院办公厅）】',
    'provider: gov_cn_official',
    `source: ${CHINA_HOLIDAY_2026_SOURCE}`,
    ...rows.map((entry) => `- ${entry.name}：${entry.holiday}；${entry.workdays}`),
    '说明：以上为国务院办公厅公布的全国安排；单位内部值班和个人年休假不在此口径内。',
  ].join('\n');
}

export function calendar(query) {
  const officialHoliday = officialChinaHoliday2026(query);
  if (officialHoliday) return officialHoliday;
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
