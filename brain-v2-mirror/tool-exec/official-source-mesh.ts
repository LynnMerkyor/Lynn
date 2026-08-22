// @ts-nocheck
// Brain v2 · internal official-source mesh
//
// This is deliberately not exposed as another model tool. It is an internal
// intent router used by web_search (and selected existing realtime tools) to
// fetch first-party or institutional structured data before generic search.

const SOURCE_TIMEOUT_MS = Number(process.env.OFFICIAL_SOURCE_TIMEOUT_MS || 6500);

function compact(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function stripMarkup(value) {
  return compact(decodeEntities(String(value || '').replace(/<[^>]+>/g, ' ')));
}

function timeoutSignal(ms = SOURCE_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, clear: () => clearTimeout(timer) };
}

async function fetchJson(url, opts = {}) {
  const timeout = timeoutSignal(opts.timeoutMs);
  try {
    const headers = {
      Accept: 'application/json',
      'User-Agent': 'LynnBrain/0.86 official-source-mesh',
      ...(opts.headers || {}),
    };
    const resp = await fetch(url, { headers, signal: timeout.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } finally {
    timeout.clear();
  }
}

async function fetchText(url, opts = {}) {
  const timeout = timeoutSignal(opts.timeoutMs);
  try {
    const headers = {
      Accept: opts.accept || 'text/plain, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5',
      'User-Agent': 'LynnBrain/0.86 official-source-mesh',
      ...(opts.headers || {}),
    };
    const resp = await fetch(url, { headers, signal: timeout.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.text();
  } finally {
    timeout.clear();
  }
}

function sourceResult(provider, query, items, summary) {
  const usable = (Array.isArray(items) ? items : []).filter((item) => (
    compact(item?.title) && compact(item?.url) && compact(item?.snippet)
  ));
  const text = compact(summary);
  if (!usable.length || !text) return null;
  return {
    provider,
    query,
    items: usable,
    summary: text,
    sources: [{ name: provider, ok: true, items: usable, summary: text }],
  };
}

function isoDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

// ── USGS earthquakes ────────────────────────────────────────────────

function isEarthquakeQuery(query) {
  return /地震|震级|震中|余震|earthquake|seismic/i.test(query);
}

const CHINA_EARTHQUAKE_LOCATION_HINTS = [
  '北京', '天津', '上海', '重庆', '河北', '山西', '辽宁', '吉林', '黑龙江', '江苏', '浙江', '安徽', '福建', '江西', '山东',
  '河南', '湖北', '湖南', '广东', '海南', '四川', '贵州', '云南', '陕西', '甘肃', '青海', '台湾', '内蒙古', '广西', '西藏',
  '宁夏', '新疆', '香港', '澳门', '广州', '深圳', '成都', '杭州', '南京', '武汉', '西安', '苏州', '厦门', '青岛', '大连',
];

function earthquakeLocationHint(query) {
  return CHINA_EARTHQUAKE_LOCATION_HINTS.find((name) => String(query || '').includes(name)) || '';
}

async function lookupCencEarthquakes(query) {
  if (!isEarthquakeQuery(query)) return null;
  const url = 'https://data.earthquake.cn/datashare/report.shtml?PAGEID=earthquake_subao&gdbsTokenId=null';
  const html = await fetchText(url, { accept: 'text/html,application/xhtml+xml' });
  const rows = [...String(html || '').matchAll(/<tr id="earthquake_subao_guid_catalog_tr_\d+"[\s\S]*?<\/tr>/gi)].map((match) => {
    const values = [...match[0].matchAll(/class=['"]cls-data-content-list['"]>([\s\S]*?)<\/div>/gi)].map((m) => stripMarkup(m[1]));
    if (values.length < 8) return null;
    return {
      index: values[0],
      time: values[1],
      longitude: values[2],
      latitude: values[3],
      depthKm: values[4],
      magnitude: values[5],
      place: values[6],
      type: values[7],
    };
  }).filter(Boolean);
  if (!rows.length) throw new Error('CENC catalog parse returned no rows');
  const hint = earthquakeLocationHint(query);
  const selected = (hint ? rows.filter((row) => row.place.includes(hint)) : rows).slice(0, 8);
  if (hint && !selected.length) {
    const summary = `中国地震台网速报目录当前首页未检出震中位置包含“${hint}”的记录；这只是当前目录页证据缺口，不能单独证明没有地震。`;
    return sourceResult('cenc_official', query, [{
      title: `中国地震台网速报目录 · ${hint}匹配 0 条`,
      url,
      snippet: summary,
    }], summary);
  }
  const items = selected.map((row) => ({
    title: `M${row.magnitude} ${row.place}`,
    url,
    snippet: `北京时间=${row.time}; magnitude=${row.magnitude}; place=${row.place}; longitude=${row.longitude}; latitude=${row.latitude}; depth_km=${row.depthKm}; type=${row.type}`,
  }));
  const summary = `中国地震台网速报目录${hint ? `（地点匹配：${hint}）` : ''}：${items.map((item) => item.title).join(' | ')}`;
  return sourceResult('cenc_official', query, items, summary);
}

async function lookupUsgsEarthquakes(query) {
  if (!isEarthquakeQuery(query)) return null;
  const url = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_week.geojson';
  const data = await fetchJson(url);
  const rows = (Array.isArray(data?.features) ? data.features : []).slice(0, 8).map((feature) => {
    const p = feature?.properties || {};
    return {
      title: `M${Number(p.mag).toFixed(1)} ${compact(p.place) || 'earthquake'}`,
      url: compact(p.url) || url,
      snippet: [
        `magnitude=${p.mag}`,
        `place=${compact(p.place)}`,
        p.time ? `time=${isoDate(p.time)}` : '',
        p.tsunami ? 'tsunami_flag=1' : '',
        p.alert ? `alert=${p.alert}` : '',
      ].filter(Boolean).join('; '),
    };
  });
  const summary = rows.length
    ? `USGS significant-earthquake feed (past 7 days, generated ${isoDate(data?.metadata?.generated)}): ${rows.map((row) => row.title).join(' | ')}`
    : 'USGS significant-earthquake feed currently contains no events for the past 7 days.';
  return sourceResult('usgs_official', query, rows.length ? rows : [{
    title: 'USGS real-time earthquake feeds',
    url,
    snippet: summary,
  }], summary);
}

// ── NASA EONET natural events ───────────────────────────────────────

function isNaturalEventQuery(query) {
  return /山火|森林火灾|火山|飓风|台风|洪水|冰山|自然灾害|wildfire|volcano|hurricane|cyclone|flood|natural disaster/i.test(query)
    && /今天|现在|当前|最近|实时|最新|活跃|today|current|recent|latest|active|open/i.test(query);
}

async function lookupNasaEonet(query) {
  if (!isNaturalEventQuery(query)) return null;
  const url = 'https://eonet.gsfc.nasa.gov/api/v3/events?status=open&limit=12';
  const data = await fetchJson(url);
  const rows = (Array.isArray(data?.events) ? data.events : []).slice(0, 8).map((event) => {
    const category = (Array.isArray(event?.categories) ? event.categories : []).map((v) => compact(v?.title)).filter(Boolean).join(', ');
    const geometry = (Array.isArray(event?.geometry) ? event.geometry : []).at(-1) || {};
    const officialSource = (Array.isArray(event?.sources) ? event.sources : []).find((v) => compact(v?.url));
    return {
      title: compact(event?.title) || 'NASA EONET event',
      url: compact(event?.link) || compact(officialSource?.url) || url,
      snippet: [category ? `category=${category}` : '', geometry?.date ? `updated=${geometry.date}` : '', compact(event?.description)].filter(Boolean).join('; '),
    };
  });
  if (!rows.length) return null;
  return sourceResult('nasa_eonet_official', query, rows, `NASA EONET currently lists ${rows.length} matching open-event candidates in this response: ${rows.map((row) => row.title).join(' | ')}`);
}

// ── GitHub repository / issue metadata ──────────────────────────────

function parseGitHubTarget(query) {
  const match = String(query || '').match(/https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/issues\/(\d+))?/i);
  if (!match) return null;
  return { owner: match[1], repo: match[2].replace(/\.git$/i, ''), issue: match[3] || '' };
}

function githubHeaders() {
  const token = compact(process.env.GITHUB_TOKEN || process.env.GH_TOKEN);
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function lookupGitHub(query) {
  const target = parseGitHubTarget(query);
  if (!target) return null;
  const root = `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
  if (target.issue) {
    const issue = await fetchJson(`${root}/issues/${target.issue}`, { headers: githubHeaders() });
    if (!issue?.html_url || issue?.pull_request) return null;
    const snippet = [
      `state=${issue.state}`,
      `created=${issue.created_at}`,
      `updated=${issue.updated_at}`,
      `comments=${issue.comments}`,
      compact(issue.body).slice(0, 500),
    ].filter(Boolean).join('; ');
    return sourceResult('github_official_api', query, [{ title: `#${issue.number} ${compact(issue.title)}`, url: issue.html_url, snippet }], `GitHub issue #${issue.number} is ${issue.state}; updated ${issue.updated_at}; comments ${issue.comments}.`);
  }

  if (/issue|问题|工单/i.test(query)) {
    const issues = await fetchJson(`${root}/issues?state=all&sort=created&direction=desc&per_page=8`, { headers: githubHeaders() });
    const rows = (Array.isArray(issues) ? issues : []).filter((item) => !item?.pull_request).slice(0, 5).map((issue) => ({
      title: `#${issue.number} ${compact(issue.title)}`,
      url: issue.html_url,
      snippet: `state=${issue.state}; created=${issue.created_at}; updated=${issue.updated_at}; comments=${issue.comments}`,
    }));
    if (!rows.length) return null;
    return sourceResult('github_official_api', query, rows, `GitHub official API returned ${rows.length} recent issues for ${target.owner}/${target.repo}.`);
  }

  const repo = await fetchJson(root, { headers: githubHeaders() });
  if (!repo?.html_url) return null;
  const snippet = [
    `stars=${repo.stargazers_count}`,
    `forks=${repo.forks_count}`,
    `open_issues=${repo.open_issues_count}`,
    `default_branch=${repo.default_branch}`,
    `updated=${repo.updated_at}`,
    `pushed=${repo.pushed_at}`,
    compact(repo.description),
  ].filter(Boolean).join('; ');
  return sourceResult('github_official_api', query, [{ title: repo.full_name, url: repo.html_url, snippet }], `GitHub repository ${repo.full_name}: ${repo.stargazers_count} stars, ${repo.forks_count} forks, ${repo.open_issues_count} open issues; pushed ${repo.pushed_at}.`);
}

// ── npm / PyPI / Hugging Face package and model metadata ────────────

function explicitPackageName(query, ecosystem) {
  const text = String(query || '');
  if (ecosystem === 'npm') {
    const url = text.match(/npmjs\.com\/package\/(@[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+|[A-Za-z0-9_.-]+)/i)?.[1];
    const named = text.match(/\bnpm(?:\s*包|\s*package)?\s+(@[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+|[A-Za-z0-9_.-]+)/i)?.[1];
    return url || named || '';
  }
  const url = text.match(/pypi\.org\/project\/([A-Za-z0-9_.-]+)/i)?.[1];
  const named = text.match(/\b(?:pypi|pip)(?:\s*包|\s*package)?\s+([A-Za-z0-9_.-]+)/i)?.[1];
  return url || named || '';
}

async function lookupNpm(query) {
  const name = explicitPackageName(query, 'npm');
  if (!name || /^(?:最新|版本|包|package|latest|version)$/i.test(name)) return null;
  const encoded = encodeURIComponent(name);
  const url = `https://registry.npmjs.org/${encoded}/latest`;
  const data = await fetchJson(url);
  if (!data?.name || !data?.version) return null;
  const page = `https://www.npmjs.com/package/${data.name}`;
  const snippet = [`version=${data.version}`, `license=${data.license || ''}`, `node=${data.engines?.node || ''}`, compact(data.description)].filter(Boolean).join('; ');
  return sourceResult('npm_official_registry', query, [{ title: `${data.name} ${data.version}`, url: page, snippet }], `npm registry latest metadata: ${data.name}@${data.version}.`);
}

async function lookupPyPi(query) {
  const name = explicitPackageName(query, 'pypi');
  if (!name || /^(?:最新|版本|包|package|latest|version)$/i.test(name)) return null;
  const url = `https://pypi.org/pypi/${encodeURIComponent(name)}/json`;
  const data = await fetchJson(url);
  const info = data?.info || {};
  if (!info.name || !info.version) return null;
  const page = info.package_url || `https://pypi.org/project/${info.name}/`;
  const snippet = [`version=${info.version}`, `requires_python=${info.requires_python || ''}`, `license=${compact(info.license).slice(0, 80)}`, compact(info.summary)].filter(Boolean).join('; ');
  return sourceResult('pypi_official_api', query, [{ title: `${info.name} ${info.version}`, url: page, snippet }], `PyPI official metadata: ${info.name} ${info.version}.`);
}

function parseHuggingFaceRepo(query) {
  const match = String(query || '').match(/https?:\/\/(?:www\.)?huggingface\.co\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/i);
  if (!match || ['api', 'datasets', 'spaces'].includes(match[1].toLowerCase())) return null;
  return `${match[1]}/${match[2]}`;
}

async function lookupHuggingFace(query) {
  const repo = parseHuggingFaceRepo(query);
  if (!repo) return null;
  const url = `https://huggingface.co/api/models/${repo}`;
  const data = await fetchJson(url);
  if (!data?.id) return null;
  const page = `https://huggingface.co/${data.id}`;
  const siblings = Array.isArray(data.siblings) ? data.siblings : [];
  const snippet = [
    `downloads=${data.downloads ?? ''}`,
    `likes=${data.likes ?? ''}`,
    `private=${!!data.private}`,
    `lastModified=${data.lastModified || ''}`,
    `pipeline_tag=${data.pipeline_tag || ''}`,
    `files=${siblings.length}`,
    `sha=${data.sha || ''}`,
  ].filter(Boolean).join('; ');
  return sourceResult('huggingface_official_api', query, [{ title: data.id, url: page, snippet }], `Hugging Face Hub metadata for ${data.id}: ${data.downloads ?? 0} downloads, ${data.likes ?? 0} likes, ${siblings.length} files; last modified ${data.lastModified || 'unknown'}.`);
}

// ── arXiv paper metadata ────────────────────────────────────────────

function parseArxivId(query) {
  return String(query || '').match(/(?:arxiv\.org\/(?:abs|pdf)\/|\barXiv\s*[:：]?\s*)(\d{4}\.\d{4,5})(?:v\d+)?/i)?.[1] || '';
}

function xmlTag(xml, tag) {
  return stripMarkup(String(xml || '').match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))?.[1] || '');
}

async function lookupArxiv(query) {
  const id = parseArxivId(query);
  if (!id) return null;
  const apiUrl = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`;
  const xml = await fetchText(apiUrl, { accept: 'application/atom+xml, application/xml;q=0.9' });
  const entry = String(xml || '').match(/<entry>([\s\S]*?)<\/entry>/i)?.[1] || '';
  const title = xmlTag(entry, 'title');
  if (!title) return null;
  const published = xmlTag(entry, 'published');
  const updated = xmlTag(entry, 'updated');
  const summaryText = xmlTag(entry, 'summary').slice(0, 900);
  const authors = [...entry.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi)].map((m) => stripMarkup(m[1])).filter(Boolean).slice(0, 12);
  const page = `https://arxiv.org/abs/${id}`;
  const snippet = [`arXiv=${id}`, `published=${published}`, `updated=${updated}`, authors.length ? `authors=${authors.join(', ')}` : '', summaryText].filter(Boolean).join('; ');
  return sourceResult('arxiv_official_api', query, [{ title, url: page, snippet }], `arXiv ${id}: ${title}. Published ${published}; authors ${authors.join(', ')}. Abstract: ${summaryText}`);
}

// ── World Bank and WHO institutional statistics ────────────────────

const COUNTRY_CODES = [
  [/中国|China/i, ['CHN', 'China']], [/美国|United States|USA/i, ['USA', 'United States']],
  [/日本|Japan/i, ['JPN', 'Japan']], [/德国|Germany/i, ['DEU', 'Germany']],
  [/法国|France/i, ['FRA', 'France']], [/英国|United Kingdom|Britain/i, ['GBR', 'United Kingdom']],
  [/印度|India/i, ['IND', 'India']], [/巴西|Brazil/i, ['BRA', 'Brazil']],
  [/俄罗斯|Russia/i, ['RUS', 'Russia']], [/韩国|South Korea|Korea/i, ['KOR', 'South Korea']],
  [/加拿大|Canada/i, ['CAN', 'Canada']], [/澳大利亚|Australia/i, ['AUS', 'Australia']],
];

const WB_INDICATORS = [
  [/人口|population/i, ['SP.POP.TOTL', 'population']],
  [/人均\s*GDP|GDP\s*per\s*capita/i, ['NY.GDP.PCAP.CD', 'GDP per capita (current US$)']],
  [/GDP|国内生产总值|经济总量/i, ['NY.GDP.MKTP.CD', 'GDP (current US$)']],
  [/通胀|消费者价格|CPI|inflation/i, ['FP.CPI.TOTL.ZG', 'inflation, consumer prices (annual %)']],
  [/失业率|unemployment/i, ['SL.UEM.TOTL.ZS', 'unemployment (% of labor force)']],
  [/预期寿命|人均寿命|life expectancy/i, ['SP.DYN.LE00.IN', 'life expectancy at birth']],
  [/二氧化碳|碳排放|CO2/i, ['EN.GHG.CO2.MT.CE.AR5', 'CO2 emissions']],
];

function matchCountry(query) {
  return COUNTRY_CODES.find(([pattern]) => pattern.test(query))?.[1] || null;
}

function matchWorldBankIndicator(query) {
  return WB_INDICATORS.find(([pattern]) => pattern.test(query))?.[1] || null;
}

function formatStatValue(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value ?? '');
  if (Math.abs(n) >= 1e12) return `${(n / 1e12).toFixed(3)} trillion`;
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(3)} billion`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(3)} million`;
  return Number.isInteger(n) ? String(n) : n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

async function lookupWorldBank(query) {
  const country = matchCountry(query);
  const indicator = matchWorldBankIndicator(query);
  if (!country || !indicator) return null;
  const [code, countryName] = country;
  const [indicatorCode, indicatorName] = indicator;
  const url = `https://api.worldbank.org/v2/country/${code}/indicator/${indicatorCode}?format=json&mrv=1`;
  const data = await fetchJson(url);
  const row = Array.isArray(data?.[1]) ? data[1][0] : null;
  if (!row || row.value == null) return null;
  const page = `https://data.worldbank.org/indicator/${indicatorCode}?locations=${code}`;
  const snippet = `country=${countryName}; indicator=${row.indicator?.value || indicatorName}; period=${row.date}; value=${row.value}; lastupdated=${data?.[0]?.lastupdated || ''}`;
  return sourceResult('world_bank_official_api', query, [{ title: `${countryName} · ${row.indicator?.value || indicatorName}`, url: page, snippet }], `World Bank latest available observation: ${countryName}, ${row.indicator?.value || indicatorName}, ${row.date} = ${formatStatValue(row.value)}. Dataset updated ${data?.[0]?.lastupdated || 'unknown'}.`);
}

async function lookupWhoLifeExpectancy(query) {
  const country = matchCountry(query);
  if (!country || !/预期寿命|人均寿命|life expectancy/i.test(query)) return null;
  const [code, countryName] = country;
  const filter = encodeURIComponent(`SpatialDim eq '${code}' and Dim1 eq 'SEX_BTSX'`);
  const url = `https://ghoapi.azureedge.net/api/WHOSIS_000001?$filter=${filter}&$orderby=TimeDim%20desc&$top=1`;
  const data = await fetchJson(url);
  const row = Array.isArray(data?.value) ? data.value[0] : null;
  if (!row || row.NumericValue == null) return null;
  const page = 'https://www.who.int/data/gho/data/indicators/indicator-details/GHO/life-expectancy-at-birth-(years)';
  const snippet = `country=${countryName}; year=${row.TimeDim}; value=${row.NumericValue}; interval=${row.Value || ''}; updated=${row.Date || ''}`;
  return sourceResult('who_official_api', query, [{ title: `${countryName} · WHO life expectancy at birth`, url: page, snippet }], `WHO latest returned both-sex life expectancy observation for ${countryName}: ${Number(row.NumericValue).toFixed(1)} years (${row.TimeDim}; ${row.Value || 'interval unavailable'}).`);
}

function mergeResults(query, results) {
  const usable = (Array.isArray(results) ? results : []).filter(Boolean);
  if (!usable.length) return null;
  const items = [];
  const seen = new Set();
  const sources = [];
  for (const result of usable) {
    for (const item of result.items || []) {
      const key = [compact(item?.url), compact(item?.title)].filter(Boolean).join(':')
        || [compact(item?.title), compact(item?.snippet)].filter(Boolean).join(':');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      items.push(item);
    }
    sources.push(...(result.sources || []));
  }
  const provider = usable.map((result) => result.provider).join('+');
  const summary = usable.map((result) => result.summary).filter(Boolean).join('\n');
  return { provider, query, items, summary, sources };
}

export async function lookupOfficialSources(query, { log } = {}) {
  const q = compact(query);
  if (!q) return null;

  const adapters = [
    ['cenc_official', lookupCencEarthquakes],
    ['usgs_official', lookupUsgsEarthquakes],
    ['nasa_eonet_official', lookupNasaEonet],
    ['github_official_api', lookupGitHub],
    ['npm_official_registry', lookupNpm],
    ['pypi_official_api', lookupPyPi],
    ['huggingface_official_api', lookupHuggingFace],
    ['arxiv_official_api', lookupArxiv],
    ['world_bank_official_api', lookupWorldBank],
    ['who_official_api', lookupWhoLifeExpectancy],
  ];

  const selected = adapters.filter(([, fn]) => {
    if (fn === lookupCencEarthquakes) return isEarthquakeQuery(q);
    if (fn === lookupUsgsEarthquakes) return isEarthquakeQuery(q);
    if (fn === lookupNasaEonet) return isNaturalEventQuery(q);
    if (fn === lookupGitHub) return !!parseGitHubTarget(q);
    if (fn === lookupNpm) return !!explicitPackageName(q, 'npm');
    if (fn === lookupPyPi) return !!explicitPackageName(q, 'pypi');
    if (fn === lookupHuggingFace) return !!parseHuggingFaceRepo(q);
    if (fn === lookupArxiv) return !!parseArxivId(q);
    if (fn === lookupWorldBank) return !!matchCountry(q) && !!matchWorldBankIndicator(q);
    if (fn === lookupWhoLifeExpectancy) return !!matchCountry(q) && /预期寿命|人均寿命|life expectancy/i.test(q);
    return false;
  });
  if (!selected.length) return null;

  const settled = await Promise.all(selected.map(async ([name, fn]) => {
    try {
      const value = await fn(q);
      return { name, value };
    } catch (error) {
      log && log('warn', `tool-exec/official-source-mesh ${name} failed: ${error?.message || String(error)}`);
      return { name, value: null };
    }
  }));
  const result = mergeResults(q, settled.map((entry) => entry.value));
  if (result) log && log('info', `tool-exec/official-source-mesh q=${q} provider=${result.provider} items=${result.items.length}`);
  return result;
}

export const __testing__ = {
  earthquakeLocationHint,
  explicitPackageName,
  isEarthquakeQuery,
  isNaturalEventQuery,
  matchCountry,
  matchWorldBankIndicator,
  parseArxivId,
  parseGitHubTarget,
  parseHuggingFaceRepo,
};
