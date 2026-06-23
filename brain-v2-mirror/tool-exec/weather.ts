// @ts-nocheck
// Brain v2 · tool-exec/weather
// wttr.in 免费 API + web_search fallback
const CITY_EN_MAP = {
  '北京': 'Beijing', '上海': 'Shanghai', '广州': 'Guangzhou', '深圳': 'Shenzhen',
  '深圳南山': 'Shenzhen', '深圳福田': 'Shenzhen', '深圳罗湖': 'Shenzhen', '深圳宝安': 'Shenzhen',
  '杭州': 'Hangzhou', '成都': 'Chengdu', '重庆': 'Chongqing', '武汉': 'Wuhan',
  '南京': 'Nanjing', '天津': 'Tianjin', '苏州': 'Suzhou', '西安': "Xi'an",
  '长沙': 'Changsha', '沈阳': 'Shenyang', '青岛': 'Qingdao', '大连': 'Dalian',
  '厦门': 'Xiamen', '郑州': 'Zhengzhou', '东莞': 'Dongguan', '佛山': 'Foshan',
  '合肥': 'Hefei', '昆明': 'Kunming', '哈尔滨': 'Harbin', '济南': 'Jinan',
  '福州': 'Fuzhou', '珠海': 'Zhuhai', '无锡': 'Wuxi', '温州': 'Wenzhou',
  '宁波': 'Ningbo', '贵阳': 'Guiyang', '南宁': 'Nanning', '太原': 'Taiyuan',
  '石家庄': 'Shijiazhuang', '乌鲁木齐': 'Urumqi', '兰州': 'Lanzhou', '海口': 'Haikou',
  '三亚': 'Sanya', '拉萨': 'Lhasa', '香港': 'Hong Kong', '澳门': 'Macau', '台北': 'Taipei',
};

const CITY_GEO_MAP = {
  '北京': { latitude: 39.9042, longitude: 116.4074, timezone: 'Asia/Shanghai', name: '北京' },
  '上海': { latitude: 31.2304, longitude: 121.4737, timezone: 'Asia/Shanghai', name: '上海' },
  '广州': { latitude: 23.1291, longitude: 113.2644, timezone: 'Asia/Shanghai', name: '广州' },
  '深圳': { latitude: 22.5431, longitude: 114.0579, timezone: 'Asia/Shanghai', name: '深圳' },
  '杭州': { latitude: 30.2741, longitude: 120.1551, timezone: 'Asia/Shanghai', name: '杭州' },
  '成都': { latitude: 30.5728, longitude: 104.0668, timezone: 'Asia/Shanghai', name: '成都' },
  '重庆': { latitude: 29.5630, longitude: 106.5516, timezone: 'Asia/Shanghai', name: '重庆' },
  '武汉': { latitude: 30.5928, longitude: 114.3055, timezone: 'Asia/Shanghai', name: '武汉' },
  '南京': { latitude: 32.0603, longitude: 118.7969, timezone: 'Asia/Shanghai', name: '南京' },
  '天津': { latitude: 39.3434, longitude: 117.3616, timezone: 'Asia/Shanghai', name: '天津' },
};

function isAirQualityQuery(value) {
  return /空气质量|空气污染|AQI|PM\s*2\.?5|PM10|雾霾|霾|air\s*quality|pollution/i.test(String(value || ''));
}

function isWeatherAlertQuery(value) {
  return /天气预警|预警|暴雨|雷暴|雷电|台风|高温|强季风|alert|warning|rainstorm/i.test(String(value || ''));
}

function compactLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function extractJsonObjectFromJsVariable(body, variableName) {
  const text = String(body || '');
  const escaped = variableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const raw = text.match(new RegExp(`var\\s+${escaped}\\s*=\\s*([\\s\\S]*?)\\s*;\\s*\\}?\\s*catch`, 'i'))?.[1]
    || text.match(new RegExp(`var\\s+${escaped}\\s*=\\s*([\\s\\S]*?)\\s*;`, 'i'))?.[1]
    || '';
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function formatAlarmEntry(entry, prefix = '深圳') {
  const type = compactLine(entry?.alarmType);
  const color = compactLine(entry?.alarmColor);
  const date = compactLine(entry?.date);
  const area = compactLine(entry?.alarmArea);
  const str = compactLine(entry?.str);
  const title = [prefix, type, color ? `${color}预警` : '预警'].filter(Boolean).join('');
  return [
    `- ${title}`,
    date ? `  发布时间: ${date}` : '',
    area ? `  发布区域: ${area}` : '',
    str ? `  内容: ${str}` : '',
  ].filter(Boolean).join('\n');
}

async function fetchShenzhenWeatherAlert(location, query = '') {
  const safeLocation = compactLine(location || '深圳');
  const url = 'https://weather.121.com.cn/data_cache/szWeather/alarm/szAlarm.js';
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 7000);
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'lobster-brain-v2/ShenzhenWeatherAlert' },
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error(`weather.121.com.cn ${resp.status}`);
    const body = await resp.text();
    const updated = body.match(/@cdate:([^*]+)\*\//)?.[1]?.trim() || '';
    const data = extractJsonObjectFromJsVariable(body, 'SZ121_AlarmInfo');
    if (!data) throw new Error('unable to parse SZ121_AlarmInfo');
    const subAlarm = Array.isArray(data.subAlarm) ? data.subAlarm : [];
    const sshzqAlarm = Array.isArray(data.sshzqAlarm) ? data.sshzqAlarm : [];
    const wantsRainstorm = /暴雨|rainstorm/i.test(query);
    const current = subAlarm.filter((entry) => {
      if (!wantsRainstorm) return true;
      return /暴雨/.test(`${entry?.alarmType || ''}${entry?.str || ''}`);
    });
    const alarmInfo = compactLine(data.alarmInfo);
    const alarmSSInfo = compactLine(data.alarmSSInfo);
    return [
      `${safeLocation}天气预警（深圳市气象局/深圳天气 121 数据缓存）`,
      'provider: weather.121.com.cn',
      `source: ${url}`,
      updated ? `更新时间: ${updated}` : '',
      `当前深圳生效预警: ${subAlarm.length}`,
      wantsRainstorm
        ? (current.length ? `暴雨预警: 检出 ${current.length} 条当前生效暴雨预警` : '暴雨预警: 未检出深圳当前生效暴雨预警')
        : '',
      '',
      current.length ? '当前生效预警明细:' : '当前生效预警明细: 无',
      ...current.map((entry) => formatAlarmEntry(entry, '深圳')),
      '',
      alarmInfo ? `最近深圳解除/说明: ${alarmInfo}` : '',
      alarmSSInfo ? `深汕特别合作区解除/说明: ${alarmSSInfo}` : '',
      `深汕当前生效预警: ${sshzqAlarm.length}`,
      '官方入口: https://weather.sz.gov.cn/qixiangfuwu/yujingfuwu/tufashijianyujing/index.html',
    ].filter(Boolean).join('\n');
  } finally {
    clearTimeout(timeout);
  }
}

function resolveDisplayCity(value) {
  const text = String(value || '').trim();
  const known = Object.keys(CITY_EN_MAP)
    .sort((a, b) => b.length - a.length)
    .find((city) => text.includes(city));
  if (known) return known;
  const match = text.match(/([\u4e00-\u9fa5A-Za-z .-]{2,24}?)(?:今天|今日|明天|现在|实时)?(?:的)?(?:空气质量|空气污染|AQI|PM\s*2\.?5|PM10|雾霾|霾|天气|气温|预报)/i);
  if (match?.[1]) {
    const cleaned = match[1]
      .replace(/^(?:查一下|查询|看看|告诉我|请问|今天|今日|现在|实时)\s*/i, '')
      .trim();
    if (cleaned) return cleaned;
  }
  return text || '北京';
}

function airQualityLevelText(aqi) {
  const n = Number(aqi);
  if (!Number.isFinite(n)) return '';
  if (n <= 50) return '优';
  if (n <= 100) return '良';
  if (n <= 150) return '对敏感人群不健康';
  if (n <= 200) return '不健康';
  if (n <= 300) return '很不健康';
  return '危险';
}

async function resolveGeo(displayCity, queryCity) {
  if (CITY_GEO_MAP[displayCity]) return CITY_GEO_MAP[displayCity];
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 5000);
  try {
    const params = new URLSearchParams({
      name: queryCity || displayCity || 'Beijing',
      count: '1',
      language: 'zh',
      format: 'json',
    });
    const resp = await fetch('https://geocoding-api.open-meteo.com/v1/search?' + params.toString(), {
      headers: { 'User-Agent': 'lobster-brain-v2/0.0' },
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error('open-meteo geocode ' + resp.status);
    const data = await resp.json();
    const geo = data.results?.[0];
    if (!geo?.latitude || !geo?.longitude) throw new Error('open-meteo geocode empty');
    return {
      latitude: geo.latitude,
      longitude: geo.longitude,
      timezone: geo.timezone || 'Asia/Shanghai',
      name: geo.name || displayCity,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchOpenMeteoAirQuality(displayCity, queryCity) {
  const geo = await resolveGeo(displayCity, queryCity);
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 7000);
  try {
    const params = new URLSearchParams({
      latitude: String(geo.latitude),
      longitude: String(geo.longitude),
      current: 'us_aqi,pm2_5,pm10,ozone,nitrogen_dioxide',
      timezone: geo.timezone || 'Asia/Shanghai',
    });
    const url = 'https://air-quality-api.open-meteo.com/v1/air-quality?' + params.toString();
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'lobster-brain-v2/0.0' },
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error('open-meteo air quality ' + resp.status);
    const data = await resp.json();
    const current = data.current || {};
    if (!Number.isFinite(Number(current.us_aqi)) && !Number.isFinite(Number(current.pm2_5))) {
      throw new Error('open-meteo air quality empty');
    }
    const aqi = current.us_aqi;
    const level = airQualityLevelText(aqi);
    return [
      '【' + (geo.name || displayCity) + '当前空气质量】',
      Number.isFinite(Number(aqi)) ? '- AQI(US): ' + aqi + (level ? '（' + level + '）' : '') : '',
      Number.isFinite(Number(current.pm2_5)) ? '- PM2.5: ' + current.pm2_5 + ' µg/m³' : '',
      Number.isFinite(Number(current.pm10)) ? '- PM10: ' + current.pm10 + ' µg/m³' : '',
      Number.isFinite(Number(current.ozone)) ? '- O3: ' + current.ozone + ' µg/m³' : '',
      Number.isFinite(Number(current.nitrogen_dioxide)) ? '- NO2: ' + current.nitrogen_dioxide + ' µg/m³' : '',
      current.time ? '- 更新时间: ' + current.time : '',
      '- provider: open-meteo-air-quality',
      '- source: ' + url,
      '说明: AQI 口径为 US AQI。',
    ].filter(Boolean).join('\n');
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchWttr(displayCity, queryCity) {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 8000);
  try {
    const resp = await fetch('https://wttr.in/' + encodeURIComponent(queryCity) + '?format=j1&lang=zh', {
      headers: { 'User-Agent': 'lobster-brain-v2/0.0' },
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error('wttr.in ' + resp.status);
    const data = await resp.json();
    const cur = data.current_condition?.[0];
    if (!cur) throw new Error('no current condition');

    const weatherText = cur.lang_zh?.[0]?.value || cur.weatherDesc?.[0]?.value || '未知';
    let summary = '【' + displayCity + '实时天气】\n';
    summary += '🌡 温度:' + cur.temp_C + '°C(体感 ' + cur.FeelsLikeC + '°C)\n';
    summary += '☁ 天气:' + weatherText + '\n';
    summary += '💧 湿度:' + cur.humidity + '%\n';
    summary += '🌬 风:' + cur.winddir16Point + ' ' + cur.windspeedKmph + 'km/h\n';
    summary += '👁 能见度:' + cur.visibility + 'km\n';
    summary += '☔ 降水:' + cur.precipMM + 'mm';
    if (cur.uvIndex && cur.uvIndex !== '0') summary += '\n☀ 紫外线指数:' + cur.uvIndex;

    if (data.weather?.length) {
      summary += '\n\n【未来天气预报】';
      for (const day of data.weather.slice(0, 3)) {
        const w = day.hourly?.[4]?.lang_zh?.[0]?.value || '未知';
        summary += '\n📅 ' + day.date + ':' + w + ',' + day.mintempC + '~' + day.maxtempC + '°C';
      }
    }
    return summary;
  } finally {
    clearTimeout(timeout);
  }
}

export async function weather(city, { log, webSearchFn } = {}) {
  const rawCity = String(city || '').trim() || '北京';
  const displayCity = resolveDisplayCity(rawCity);
  const queryCity = CITY_EN_MAP[displayCity] || displayCity;
  if (isWeatherAlertQuery(rawCity) && /深圳|深汕/.test(rawCity + displayCity)) {
    try {
      const r = await fetchShenzhenWeatherAlert(displayCity || '深圳', rawCity);
      log && log('info', 'tool-exec/weather alert OK ' + displayCity);
      return r;
    } catch (e) {
      log && log('warn', 'tool-exec/weather alert fail ' + displayCity + ': ' + e.message);
      return [
        '【深圳天气预警】',
        '未检索到明确天气预警数据。',
        '已尝试深圳市气象局 121 预警数据源，但这次没有拿到当前生效预警字段。',
        '- provider: weather.121.com.cn',
        '- source: https://weather.121.com.cn/data_cache/szWeather/alarm/szAlarm.js',
        '官方入口: https://weather.sz.gov.cn/qixiangfuwu/yujingfuwu/tufashijianyujing/index.html',
      ].join('\n');
    }
  }
  if (isAirQualityQuery(rawCity)) {
    try {
      const r = await fetchOpenMeteoAirQuality(displayCity, queryCity);
      log && log('info', 'tool-exec/weather air quality OK ' + displayCity);
      return r;
    } catch (e) {
      log && log('warn', 'tool-exec/weather air quality fail ' + displayCity + ': ' + e.message);
      return [
        '【' + displayCity + '空气质量】',
        '未检索到明确空气质量数据。',
        '已尝试 Open-Meteo Air Quality，但这次没有拿到 AQI 或 PM2.5 字段。',
      ].join('\n');
    }
  }
  try {
    const r = await fetchWttr(displayCity, queryCity);
    log && log('info', 'tool-exec/weather wttr OK ' + displayCity);
    return r;
  } catch (e) {
    log && log('warn', 'tool-exec/weather wttr fail ' + displayCity + ': ' + e.message);
    if (webSearchFn) {
      try {
        const fb = await webSearchFn(displayCity + ' 今天天气 温度 降水概率 实时 中央气象台');
        if (fb) return fb;
      } catch (we) {
        log && log('warn', 'tool-exec/weather web_search fallback fail: ' + we.message);
      }
    }
    return JSON.stringify({ error: 'weather lookup failed: wttr down + no search fallback' });
  }
}

export const __testing__ = { CITY_EN_MAP };
