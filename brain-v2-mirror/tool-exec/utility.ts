// @ts-nocheck
// Brain v2 · utility tools
// Keep this module self-contained so the mirrored brain-v2 tree can run tests
// outside the production /opt/lobster-brain directory.
import { fetchSportsScoreboardEvidence } from '../../shared/sports-scoreboard.js';

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
    const fmt = (value, digits = 6) => {
      const n = Number(value);
      if (!Number.isFinite(n)) return String(value || '').trim();
      return n.toFixed(digits).replace(/(?:\.0+|(\.\d*?)0+)$/, '$1');
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
      const bits = [`${meta.label}: 1 ${meta.base} = ${fmt(rate)} ${meta.quote}`];
      if (meta.showHundred) bits.push(`100 ${meta.base} ≈ ${fmt(rate * 100, 4)} ${meta.quote}`);
      if (Number.isFinite(pct)) bits.push(`涨跌幅 ${pct >= 0 ? '+' : ''}${fmt(pct, 4)}%`);
      if (Number.isFinite(change)) bits.push(`涨跌 ${change >= 0 ? '+' : ''}${fmt(change, 6)}`);
      if (updated) bits.push(`更新: ${updated}`);
      results.push(bits.join('；'));
    }
    return results.length ? '【实时汇率】\n' + results.join('\n') : JSON.stringify({ error: '汇率查询失败' });
  } catch (e) {
    return JSON.stringify({ error: e.message || '汇率查询失败' });
  }
}

export async function sportsScore(query) {
  const q = String(query || '');
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
