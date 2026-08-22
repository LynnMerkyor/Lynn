// @ts-nocheck
// Brain v2 · tool-exec/weather
// CMA official weather + Open-Meteo + wttr.in, with validated web-search fallback.
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

function weatherCodeText(code) {
  const value = Number(code);
  if (value === 0) return '晴';
  if ([1, 2].includes(value)) return '多云';
  if (value === 3) return '阴';
  if ([45, 48].includes(value)) return '雾';
  if ([51, 53, 55, 56, 57].includes(value)) return '毛毛雨';
  if ([61, 63, 65, 66, 67].includes(value)) return '雨';
  if ([71, 73, 75, 77].includes(value)) return '雪';
  if ([80, 81, 82].includes(value)) return '阵雨';
  if ([85, 86].includes(value)) return '阵雪';
  if ([95, 96, 99].includes(value)) return '雷暴';
  return '未知';
}

function weatherSearchFallbackText(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    const parsed = JSON.parse(text);
    if (parsed?.ok === false || parsed?.error) return '';
  } catch {
    // Normal search output is text rather than JSON.
  }
  const hasMeasure = /-?\d+(?:\.\d+)?\s*(?:°\s*C|°C|℃|度|mm|毫米|%)/i.test(text);
  const hasWeatherState = /晴|多云|阴|雨|雪|雾|霾|雷|温度|气温|降水|湿度|weather|forecast|rain|snow|temperature/i.test(text);
  return hasMeasure && hasWeatherState ? text : '';
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

function cleanWeatherLocationCandidate(value) {
  return compactLine(value)
    .replace(/^(?:嗯|呃|啊|请问|请|帮我|麻烦|给我|替我|查一下|查下|查查|查询|查|搜一下|搜索|看看|看一下|看下|告诉我|用工具)\s*/gi, '')
    .replace(/^(?:今天|今日|明天|后天|今晚|今夜|明早|现在|实时|未来\d*天)\s*/gi, '')
    .replace(/\s*(?:今天|今日|明天|后天|今晚|今夜|明早|现在|实时|未来\d*天|白天|早上|上午|下午|晚上|夜间|夜里)\s*$/gi, '')
    .replace(/\s*(?:的)?(?:天气|气温|温度|预报|多少度|几度|weather|forecast|temperature)\s*$/gi, '')
    .replace(/(?:呢|吗|如何|怎么样|please)$/gi, '')
    .replace(/[，,。？?、:：；;]/g, '')
    .trim();
}

function resolveDisplayCity(value) {
  const text = compactLine(value);
  const district = text.match(/(?:今天|今日|明天|后天|今晚|今夜|明早|现在|实时)?\s*([\u4e00-\u9fa5]{2,20}(?:区|县|旗))(?:今天|今日|明天|后天|今晚|今夜|明早)?(?:会不会|会|是否|有没有|要不要)?(?:的)?(?:下雨|降雨|降水|下雪|降雪|天气|气温|温度|预报|预警)/i);
  if (district?.[1]) {
    const cleaned = cleanWeatherLocationCandidate(district[1]);
    if (cleaned) return cleaned;
  }
  const known = Object.keys(CITY_EN_MAP)
    .sort((a, b) => b.length - a.length)
    .find((city) => text.includes(city));
  if (known) return known;

  const rainOrTemp = text.match(/(?:今天|今日|明天|后天|今晚|今夜|明早|现在|实时)?\s*([\u4e00-\u9fa5A-Za-z .-]{2,32}?)(?:今天|今日|明天|后天|今晚|今夜|明早)?(?:会不会|会|是否|有没有|要不要)?(?:下雨|降雨|降水|下雪|降雪|温度|气温|多少度|几度|预警|暴雨|雷暴|雷电|台风|高温|酷热|强季风)/i);
  if (rainOrTemp?.[1]) {
    const cleaned = cleanWeatherLocationCandidate(rainOrTemp[1]);
    if (cleaned) return cleaned;
  }

  const zhWeather = text.match(/(?:明天|今天|后天|今晚|今夜|未来\d*天|未来)?\s*([\u4e00-\u9fa5A-Za-z .-]{2,32}?)(?:的)?(?:天气|气温|预报|预警)/i);
  if (zhWeather?.[1]) {
    const cleaned = cleanWeatherLocationCandidate(zhWeather[1]);
    if (cleaned) return cleaned;
  }

  const enAfter = text.match(/(?:weather|forecast|rain|temperature)\s+(?:in|for)\s+([A-Za-z .-]{2,40}?)(?:\s+(?:today|tomorrow|tonight))?$/i);
  const enBefore = text.match(/([A-Za-z .-]{2,40}?)(?:'s)?\s+(?:weather|forecast|rain|temperature)(?:\s+(?:today|tomorrow|tonight))?/i);
  const english = enAfter?.[1] || enBefore?.[1];
  if (english) {
    const cleaned = cleanWeatherLocationCandidate(english);
    if (cleaned) return cleaned;
  }

  return cleanWeatherLocationCandidate(text) || '北京';
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
  const knownParent = Object.keys(CITY_EN_MAP)
    .sort((a, b) => b.length - a.length)
    .find((city) => displayCity.startsWith(city));
  if (knownParent && CITY_GEO_MAP[knownParent]) return CITY_GEO_MAP[knownParent];
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 5000);
  try {
    const params = new URLSearchParams({
      name: (knownParent || displayCity || queryCity || 'Beijing').replace(/[市区县旗]$/u, ''),
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

async function fetchCmaWeather(displayCity, queryCity, rawQuery = '') {
  const parentCity = Object.keys(CITY_EN_MAP)
    .sort((a, b) => b.length - a.length)
    .find((city) => displayCity.startsWith(city));
  const lookupCity = parentCity || displayCity;
  const searchCtrl = new AbortController();
  const searchTimeout = setTimeout(() => searchCtrl.abort(), 5000);
  let station;
  try {
    const params = new URLSearchParams({ q: lookupCity || queryCity || '北京', limit: '10' });
    const resp = await fetch('https://weather.cma.cn/api/autocomplete?' + params.toString(), {
      headers: { 'User-Agent': 'Mozilla/5.0 Lynn/Brain-v2', Referer: 'https://weather.cma.cn/' },
      signal: searchCtrl.signal,
    });
    if (!resp.ok) throw new Error('cma autocomplete ' + resp.status);
    const data = await resp.json();
    const candidates = Array.isArray(data.data) ? data.data : [];
    const rows = candidates.map((item) => String(item || '').split('|'));
    const normalizedLookup = String(lookupCity || '').replace(/[市区县]$/u, '');
    const normalizedQuery = String(queryCity || '').toLowerCase();
    const exact = rows.find((parts) => {
      const name = String(parts[1] || '');
      const pinyin = String(parts[2] || '').toLowerCase();
      return name === lookupCity || name.replace(/[市区县]$/u, '') === normalizedLookup || (normalizedQuery && pinyin === normalizedQuery);
    });
    station = exact?.[0];
    if (!station || !/^[A-Za-z0-9]+$/.test(station)) throw new Error('cma station empty');
  } finally {
    clearTimeout(searchTimeout);
  }

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 7000);
  try {
    const url = 'https://weather.cma.cn/api/weather/view?stationid=' + encodeURIComponent(station);
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 Lynn/Brain-v2', Referer: 'https://weather.cma.cn/' },
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error('cma weather ' + resp.status);
    const payload = await resp.json();
    const data = payload?.data || {};
    const now = data.now || {};
    const daily = Array.isArray(data.daily) ? data.daily.slice(0, 3) : [];
    if (!Number.isFinite(Number(now.temperature)) && !daily.length) throw new Error('cma weather empty');
    const location = data.location?.name || lookupCity || displayCity;
    const today = daily[0];
    const tomorrow = daily[1];
    const target = /明天|tomorrow/i.test(rawQuery) && tomorrow
      ? `查询重点: 明天 ${tomorrow.date}，白天${tomorrow.dayText || '未知'}，夜间${tomorrow.nightText || '未知'}，${tomorrow.low}~${tomorrow.high}°C`
      : /今晚|今夜|tonight/i.test(rawQuery) && today
        ? `查询重点: 今晚 ${today.date}，${today.nightText || '未知'}，最低 ${today.low}°C`
        : '';
    return [
      `【${location}天气（中国气象局）】`,
      'provider: cma',
      `source: ${url}`,
      location !== displayCity ? `请求地点: ${displayCity}（采用 ${location} 国家站/市级预报）` : '',
      data.lastUpdate ? `更新时间: ${data.lastUpdate}` : '',
      target,
      Number.isFinite(Number(now.temperature)) ? `🌡 温度: ${now.temperature}°C${Number.isFinite(Number(now.feelst)) ? `（体感 ${now.feelst}°C）` : ''}` : '',
      Number.isFinite(Number(now.humidity)) ? `💧 湿度: ${now.humidity}%` : '',
      now.windDirection || Number.isFinite(Number(now.windSpeed)) ? `🌬 风: ${now.windDirection || ''} ${Number.isFinite(Number(now.windSpeed)) ? `${now.windSpeed}m/s` : ''}`.trim() : '',
      Number.isFinite(Number(now.precipitation)) ? `☔ 当前降水: ${now.precipitation}mm` : '',
      Array.isArray(data.alarm) && data.alarm.length ? `⚠ 当前预警: ${data.alarm.map((item) => compactLine(item?.title)).filter(Boolean).join('；')}` : '⚠ 当前预警: 无',
      daily.length ? '\n【未来天气预报】' : '',
      ...daily.map((day) => `📅 ${day.date}: 白天${day.dayText || '未知'} / 夜间${day.nightText || '未知'}, ${day.low}~${day.high}°C`),
    ].filter(Boolean).join('\n');
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchOpenMeteoWeather(displayCity, queryCity, rawQuery = '') {
  const geo = await resolveGeo(displayCity, queryCity);
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 7000);
  try {
    const params = new URLSearchParams({
      latitude: String(geo.latitude),
      longitude: String(geo.longitude),
      current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,precipitation,wind_speed_10m',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max',
      timezone: geo.timezone || 'Asia/Shanghai',
      forecast_days: '3',
    });
    const url = 'https://api.open-meteo.com/v1/forecast?' + params.toString();
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'lobster-brain-v2/0.0' },
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error('open-meteo weather ' + resp.status);
    const data = await resp.json();
    const current = data.current || {};
    const daily = data.daily || {};
    if (!Number.isFinite(Number(current.temperature_2m)) || !Array.isArray(daily.time)) {
      throw new Error('open-meteo weather empty');
    }
    const rows = daily.time.slice(0, 3).map((date, index) => ({
      date,
      state: weatherCodeText(daily.weather_code?.[index]),
      low: daily.temperature_2m_min?.[index],
      high: daily.temperature_2m_max?.[index],
      rain: daily.precipitation_probability_max?.[index],
      precipitation: daily.precipitation_sum?.[index],
    }));
    const targetRow = /明天|tomorrow/i.test(rawQuery) ? rows[1] : rows[0];
    const target = /明天|tomorrow/i.test(rawQuery) && targetRow
      ? `查询重点: 明天 ${targetRow.date}，${targetRow.state}，${targetRow.low}~${targetRow.high}°C，最高降水概率 ${targetRow.rain ?? '未知'}%`
      : /今晚|今夜|tonight/i.test(rawQuery) && targetRow
        ? `查询重点: 今晚参考 ${targetRow.date} 日预报，${targetRow.state}，最高降水概率 ${targetRow.rain ?? '未知'}%`
        : '';
    return [
      `【${geo.name || displayCity}天气（Open-Meteo）】`,
      'provider: open-meteo',
      `source: ${url}`,
      current.time ? `更新时间: ${current.time}` : '',
      target,
      `🌡 温度: ${current.temperature_2m}°C${Number.isFinite(Number(current.apparent_temperature)) ? `（体感 ${current.apparent_temperature}°C）` : ''}`,
      Number.isFinite(Number(current.relative_humidity_2m)) ? `💧 湿度: ${current.relative_humidity_2m}%` : '',
      Number.isFinite(Number(current.wind_speed_10m)) ? `🌬 风速: ${current.wind_speed_10m}km/h` : '',
      Number.isFinite(Number(current.precipitation)) ? `☔ 当前降水: ${current.precipitation}mm` : '',
      '\n【未来天气预报】',
      ...rows.map((day) => `📅 ${day.date}: ${day.state}, ${day.low}~${day.high}°C, 最高降水概率 ${day.rain ?? '未知'}%, 降水量 ${day.precipitation ?? '未知'}mm`),
    ].filter(Boolean).join('\n');
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchWttr(displayCity, queryCity) {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 8000);
  try {
    const url = 'https://wttr.in/' + encodeURIComponent(queryCity) + '?format=j1&lang=zh';
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'lobster-brain-v2/0.0' },
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error('wttr.in ' + resp.status);
    const data = await resp.json();
    const cur = data.current_condition?.[0];
    if (!cur) throw new Error('no current condition');

    const weatherText = cur.lang_zh?.[0]?.value || cur.weatherDesc?.[0]?.value || '未知';
    let summary = '【' + displayCity + '实时天气】\n';
    summary += 'provider: wttr.in\n';
    summary += 'source: ' + url + '\n';
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
  const providers = [
    { name: 'cma', run: () => fetchCmaWeather(displayCity, queryCity, rawCity) },
    { name: 'open-meteo', run: () => fetchOpenMeteoWeather(displayCity, queryCity, rawCity) },
    { name: 'wttr.in', run: () => fetchWttr(displayCity, queryCity) },
  ];
  let lastErrors = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const result = await Promise.any(providers.map((provider) => provider.run()
        .then((text) => ({ provider: provider.name, text }))
        .catch((error) => { throw new Error(`${provider.name}: ${error?.message || String(error)}`); })));
      log && log('info', `tool-exec/weather ${result.provider} OK ${displayCity} attempt=${attempt}`);
      return result.text;
    } catch (error) {
      lastErrors = error instanceof AggregateError ? error.errors.map((item) => item?.message || String(item)) : [error?.message || String(error)];
      log && log('warn', `tool-exec/weather direct sources fail ${displayCity} attempt=${attempt}: ${lastErrors.join('; ')}`);
      if (attempt === 1) await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  if (webSearchFn) {
    try {
      const rawFallback = await webSearchFn(`site:weather.cma.cn ${displayCity} ${rawCity} 温度 降水 天气预报`);
      const fallback = weatherSearchFallbackText(rawFallback);
      if (fallback) {
        log && log('info', 'tool-exec/weather validated web_search fallback OK ' + displayCity);
        return `【天气搜索兜底（待核验）】\n${fallback}`;
      }
      log && log('warn', 'tool-exec/weather rejected unusable web_search fallback ' + displayCity);
    } catch (error) {
      log && log('warn', 'tool-exec/weather web_search fallback fail: ' + (error?.message || String(error)));
    }
  }
  return JSON.stringify({
    ok: false,
    error: 'all weather sources failed',
    location: displayCity,
    sources: ['cma', 'open-meteo', 'wttr.in'],
    details: lastErrors,
  });
}

export const __testing__ = { CITY_EN_MAP, resolveDisplayCity, weatherSearchFallbackText, weatherCodeText };
