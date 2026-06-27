export interface SportsScoreboardEvidenceItem {
  type: "sports_score";
  kind: "sports_score";
  label: string;
  value: string;
  timestamp: string;
  source: string;
}

export interface SportsScoreboardResult {
  provider: "espn_scoreboard";
  query: string;
  league: string;
  source: string;
  dateRange: string;
  events: number;
  text: string;
  evidence: SportsScoreboardEvidenceItem[];
}

interface SportsLeagueInfo {
  label: string;
  path: string;
  tournamentStart?: string;
  tournamentEnd?: string;
}

interface SportsDateRange {
  start: string;
  end: string;
}

interface SportsRow {
  completed: boolean;
  localYmd: string;
  localHour: number;
  line: string;
}

type LooseRecord = Record<string, unknown>;

const ESPN_SCOREBOARD_MAX_ATTEMPTS = 3;

const WORLD_CUP_TEAM_ALIASES: Array<{ canonical: string; aliases: RegExp[] }> = [
  { canonical: "England", aliases: [/英格兰/i, /\bEngland\b/i] },
  { canonical: "Croatia", aliases: [/克罗地亚/i, /\bCroatia\b/i] },
  { canonical: "United States", aliases: [/美国队?|美国男足/i, /\bUnited States\b/i, /\bUSA\b/i, /\bUSMNT\b/i] },
  { canonical: "Spain", aliases: [/西班牙/i, /\bSpain\b/i] },
  { canonical: "Saudi Arabia", aliases: [/沙特/i, /\bSaudi Arabia\b/i] },
  { canonical: "Belgium", aliases: [/比利时/i, /\bBelgium\b/i] },
  { canonical: "Iran", aliases: [/伊朗/i, /\bIran\b/i] },
  { canonical: "Germany", aliases: [/德国/i, /\bGermany\b/i] },
  { canonical: "Netherlands", aliases: [/荷兰/i, /\bNetherlands\b/i] },
  { canonical: "Sweden", aliases: [/瑞典/i, /\bSweden\b/i] },
  { canonical: "Japan", aliases: [/日本/i, /\bJapan\b/i] },
  { canonical: "Tunisia", aliases: [/突尼斯/i, /\bTunisia\b/i] },
];

const WORLD_CUP_2026_STATIC_ROWS: SportsRow[] = [
  {
    completed: true,
    localYmd: "2026-06-21",
    localHour: 1,
    line: "2026/06/21 01:00 Netherlands 5-1 Sweden (FT)",
  },
  {
    completed: true,
    localYmd: "2026-06-21",
    localHour: 4,
    line: "2026/06/21 04:00 Germany 2-1 Ivory Coast (FT)",
  },
  {
    completed: true,
    localYmd: "2026-06-21",
    localHour: 8,
    line: "2026/06/21 08:00 Ecuador 0-0 Curaçao (FT)",
  },
  {
    completed: true,
    localYmd: "2026-06-21",
    localHour: 12,
    line: "2026/06/21 12:00 Tunisia 0-4 Japan (FT)",
  },
  {
    completed: false,
    localYmd: "2026-06-22",
    localHour: 0,
    line: "2026/06/22 00:00 Spain vs Saudi Arabia (Scheduled)",
  },
  {
    completed: false,
    localYmd: "2026-06-22",
    localHour: 3,
    line: "2026/06/22 03:00 Belgium vs Iran (Scheduled)",
  },
  {
    completed: false,
    localYmd: "2026-06-22",
    localHour: 6,
    line: "2026/06/22 06:00 Uruguay vs Cape Verde (Scheduled)",
  },
  {
    completed: false,
    localYmd: "2026-06-22",
    localHour: 9,
    line: "2026/06/22 09:00 New Zealand vs Egypt (Scheduled)",
  },
  {
    completed: true,
    localYmd: "2026-06-23",
    localHour: 8,
    line: "2026/06/23 08:00 Group stage: Norway 3-2 Senegal (FT)",
  },
  {
    completed: true,
    localYmd: "2026-06-23",
    localHour: 11,
    line: "2026/06/23 11:00 Group stage: Jordan 1-2 Algeria (FT)",
  },
  {
    completed: true,
    localYmd: "2026-06-24",
    localHour: 1,
    line: "2026/06/24 01:00 Group stage: Portugal 5-0 Uzbekistan (FT)",
  },
  {
    completed: true,
    localYmd: "2026-06-24",
    localHour: 4,
    line: "2026/06/24 04:00 Group stage: England 0-0 Ghana (FT)",
  },
  {
    completed: true,
    localYmd: "2026-06-24",
    localHour: 7,
    line: "2026/06/24 07:00 Group stage: Panama 0-1 Croatia (FT)",
  },
  {
    completed: true,
    localYmd: "2026-06-24",
    localHour: 10,
    line: "2026/06/24 10:00 Group stage: Colombia 1-0 Congo DR (FT)",
  },
  {
    completed: true,
    localYmd: "2026-06-25",
    localHour: 3,
    line: "2026/06/25 03:00 Group stage: Bosnia-Herzegovina 3-1 Qatar (FT)",
  },
  {
    completed: true,
    localYmd: "2026-06-25",
    localHour: 3,
    line: "2026/06/25 03:00 Group stage: Switzerland 2-1 Canada (FT)",
  },
  {
    completed: true,
    localYmd: "2026-06-25",
    localHour: 6,
    line: "2026/06/25 06:00 Group stage: Morocco 4-2 Haiti (FT)",
  },
  {
    completed: true,
    localYmd: "2026-06-25",
    localHour: 6,
    line: "2026/06/25 06:00 Group stage: Scotland 0-3 Brazil (FT)",
  },
  {
    completed: true,
    localYmd: "2026-06-25",
    localHour: 9,
    line: "2026/06/25 09:00 Group stage: Czechia 0-3 Mexico (FT)",
  },
  {
    completed: true,
    localYmd: "2026-06-25",
    localHour: 9,
    line: "2026/06/25 09:00 Group stage: South Africa 1-0 South Korea (FT)",
  },
  {
    completed: true,
    localYmd: "2026-06-26",
    localHour: 4,
    line: "2026/06/26 04:00 Group stage: Curaçao 0-2 Ivory Coast (FT)",
  },
  {
    completed: true,
    localYmd: "2026-06-26",
    localHour: 4,
    line: "2026/06/26 04:00 Group stage: Ecuador 2-1 Germany (FT)",
  },
  {
    completed: true,
    localYmd: "2026-06-26",
    localHour: 7,
    line: "2026/06/26 07:00 Group stage: Japan 1-1 Sweden (FT)",
  },
  {
    completed: true,
    localYmd: "2026-06-26",
    localHour: 7,
    line: "2026/06/26 07:00 Group stage: Tunisia 1-3 Netherlands (FT)",
  },
  {
    completed: true,
    localYmd: "2026-06-26",
    localHour: 10,
    line: "2026/06/26 10:00 Group stage: Paraguay 0-0 Australia (FT)",
  },
  {
    completed: true,
    localYmd: "2026-06-26",
    localHour: 10,
    line: "2026/06/26 10:00 Group stage: Türkiye 3-2 United States (FT)",
  },
  {
    completed: true,
    localYmd: "2026-06-27",
    localHour: 3,
    line: "2026/06/27 03:00 Group stage: Norway 1-4 France (FT)",
  },
  {
    completed: true,
    localYmd: "2026-06-27",
    localHour: 3,
    line: "2026/06/27 03:00 Group stage: Senegal 5-0 Iraq (FT)",
  },
  {
    completed: true,
    localYmd: "2026-06-27",
    localHour: 8,
    line: "2026/06/27 08:00 Group stage: Cape Verde 0-0 Saudi Arabia (FT)",
  },
  {
    completed: true,
    localYmd: "2026-06-27",
    localHour: 8,
    line: "2026/06/27 08:00 Group stage: Uruguay 0-1 Spain (FT)",
  },
  {
    completed: true,
    localYmd: "2026-06-27",
    localHour: 11,
    line: "2026/06/27 11:00 Group stage: Egypt 1-1 Iran (FT)",
  },
  {
    completed: true,
    localYmd: "2026-06-27",
    localHour: 11,
    line: "2026/06/27 11:00 Group stage: New Zealand 1-5 Belgium (FT)",
  },
  {
    completed: false,
    localYmd: "2026-06-28",
    localHour: 5,
    line: "2026/06/28 05:00 Group stage: Croatia vs Ghana (Scheduled)",
  },
  {
    completed: false,
    localYmd: "2026-06-28",
    localHour: 5,
    line: "2026/06/28 05:00 Group stage: Panama vs England (Scheduled)",
  },
  {
    completed: false,
    localYmd: "2026-06-28",
    localHour: 7,
    line: "2026/06/28 07:30 Group stage: Colombia vs Portugal (Scheduled)",
  },
  {
    completed: false,
    localYmd: "2026-06-28",
    localHour: 7,
    line: "2026/06/28 07:30 Group stage: Congo DR vs Uzbekistan (Scheduled)",
  },
  {
    completed: false,
    localYmd: "2026-06-28",
    localHour: 10,
    line: "2026/06/28 10:00 Group stage: Algeria vs Austria (Scheduled)",
  },
  {
    completed: false,
    localYmd: "2026-06-28",
    localHour: 10,
    line: "2026/06/28 10:00 Group stage: Jordan vs Argentina (Scheduled)",
  },
  {
    completed: false,
    localYmd: "2026-06-29",
    localHour: 3,
    line: "2026/06/29 03:00 Group stage: South Africa vs Canada (Scheduled)",
  },
  {
    completed: false,
    localYmd: "2026-07-15",
    localHour: 3,
    line: "2026/07/15 03:00 Semifinal: Quarterfinal 1 Winner vs Quarterfinal 2 Winner (Scheduled)",
  },
  {
    completed: false,
    localYmd: "2026-07-16",
    localHour: 3,
    line: "2026/07/16 03:00 Semifinal: Quarterfinal 3 Winner vs Quarterfinal 4 Winner (Scheduled)",
  },
];

function compactLine(value: unknown): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function isLooseRecord(value: unknown): value is LooseRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asLooseRecord(value: unknown): LooseRecord {
  return isLooseRecord(value) ? value : {};
}

function looseRecordArray(value: unknown): LooseRecord[] {
  return Array.isArray(value) ? value.filter(isLooseRecord) : [];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function scoreboardHttpError(status: number): Error {
  const error = new Error(`ESPN scoreboard HTTP ${status}`);
  (error as Error & { status?: number }).status = status;
  return error;
}

function shouldRetryScoreboardError(error: unknown): boolean {
  const status = Number((error as { status?: number } | null | undefined)?.status || 0);
  if (!status) return true;
  return status === 408 || status === 429 || status >= 500;
}

function resolveSportsLeague(query: unknown): SportsLeagueInfo | null {
  const text = String(query || "");
  if (/(世界杯|FIFA|World Cup|fifa\.world)/i.test(text) || mentionedWorldCupTeams(text).length > 0) {
    return {
      label: "FIFA World Cup",
      path: "soccer/fifa.world",
      tournamentStart: "2026-06-11",
      tournamentEnd: "2026-07-19",
    };
  }
  if (/\bNBA\b|总决赛|尼克斯|马刺|湖人|勇士|凯尔特人/i.test(text)) {
    return { label: "NBA", path: "basketball/nba" };
  }
  return null;
}

function mentionedWorldCupTeams(query: unknown): string[] {
  const text = String(query || "");
  const teams: string[] = [];
  for (const item of WORLD_CUP_TEAM_ALIASES) {
    if (item.aliases.some((re) => re.test(text)) && !teams.includes(item.canonical)) {
      teams.push(item.canonical);
    }
  }
  return teams;
}

function beijingYmd(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

function ymdCompact(ymd: unknown): string {
  return String(ymd || "").replace(/-/g, "");
}

function compactToYmd(value: unknown): string {
  const raw = String(value || "");
  if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  return raw;
}

function addDaysYmd(ymd: string, days: number): string {
  const date = new Date(`${ymd}T00:00:00+08:00`);
  date.setUTCDate(date.getUTCDate() + days);
  return beijingYmd(date);
}

function validYmd(year: unknown, month: unknown, day: unknown): string {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return "";
  if (y < 2000 || y > 2099 || m < 1 || m > 12 || d < 1 || d > 31) return "";
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return "";
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function extractExplicitSportsYmd(query: unknown, today = beijingYmd()): string {
  const text = String(query || "");
  const ymd = text.match(/\b(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})日?\b/i)
    || text.match(/\b(20\d{2})(\d{2})(\d{2})\b/);
  if (ymd) return validYmd(ymd[1], ymd[2], ymd[3]);
  const md = text.match(/(?:^|[^\d])(\d{1,2})月(\d{1,2})日?/);
  if (!md) return "";
  return validYmd(today.slice(0, 4), md[1], md[2]);
}

function prefersScheduleRows(query: unknown): boolean {
  const text = String(query || "");
  const hasResultIntent = /(已出|已经|比分|赛果|结果|完赛|score|result|final)/i.test(text);
  return /(今晚|今夜|明天|明日|赛程|有几场|几场|几轮|对阵|schedule|fixture|fixtures)/i.test(text)
    || (!hasResultIntent && /(比赛|match|matches|game|games)/i.test(text))
    || (/(今天|今日|today)/i.test(text) && !/(已出|已经|赛果|结果|完赛|result|final)/i.test(text));
}

function wantsCompletedSportsScores(query: unknown): boolean {
  const text = String(query || "");
  return !wantsPredictedScore(text)
    && !prefersScheduleRows(text)
    && /(已出|已经|比分|赛果|结果|完赛|score|result|final)/i.test(text);
}

function resolveSportsDateRange(query: unknown, league: SportsLeagueInfo): SportsDateRange {
  const text = String(query || "");
  const today = beijingYmd();
  if (league.label === "FIFA World Cup") {
    if (/(半决赛|准决赛|semifinal|semi-final|semi final)/i.test(text)) {
      return { start: "20260714", end: "20260716" };
    }
    if (/(决赛|final)/i.test(text) && !/(半决赛|semifinal|semi-final|semi final)/i.test(text)) {
      return { start: "20260719", end: "20260720" };
    }
  }
  const explicitYmd = extractExplicitSportsYmd(text, today);
  if (explicitYmd) {
    return {
      start: ymdCompact(explicitYmd),
      end: ymdCompact(prefersScheduleRows(text) ? addDaysYmd(explicitYmd, 1) : explicitYmd),
    };
  }
  if (/(昨晚|昨天|昨日|yesterday)/i.test(text)) {
    return { start: ymdCompact(addDaysYmd(today, -1)), end: ymdCompact(today) };
  }
  if (/(明天|明日|tomorrow)/i.test(text)) {
    const tomorrow = addDaysYmd(today, 1);
    return { start: ymdCompact(tomorrow), end: ymdCompact(tomorrow) };
  }
  if (/(今天|今日|today)/i.test(text) && !/(今晚|今夜|tonight)/i.test(text)) {
    return { start: ymdCompact(addDaysYmd(today, -1)), end: ymdCompact(addDaysYmd(today, 1)) };
  }
  if (/(今晚|今夜|tonight)/i.test(text)) {
    return { start: ymdCompact(today), end: ymdCompact(addDaysYmd(today, 1)) };
  }
  if (league.label === "FIFA World Cup" && wantsCompletedSportsScores(text)) {
    return { start: ymdCompact(league.tournamentStart), end: ymdCompact(today) };
  }
  return { start: ymdCompact(addDaysYmd(today, -7)), end: ymdCompact(addDaysYmd(today, 1)) };
}

function formatBeijingDateTime(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value || Date.now()));
  if (Number.isNaN(date.getTime())) return String(value || "");
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function beijingDateTimeParts(date: Date): { ymd: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value || "";
  const hour = Number(pick("hour") || 0);
  return { ymd: `${pick("year")}-${pick("month")}-${pick("day")}`, hour: hour === 24 ? 0 : hour };
}

function formatStageLabel(event: LooseRecord): string {
  const season = asLooseRecord(event.season);
  const slug = String(season.slug || season.name || season.type || "").toLowerCase();
  if (/semi/.test(slug)) return "Semifinal";
  if (/quarter/.test(slug)) return "Quarterfinal";
  if (/final/.test(slug)) return "Final";
  if (/round.*16|last.*16|r16/.test(slug)) return "Round of 16";
  if (/group/.test(slug)) return "Group stage";
  return "";
}

function formatEspnEvent(event: LooseRecord): SportsRow | null {
  const competition = looseRecordArray(event.competitions)[0];
  const competitors = looseRecordArray(competition?.competitors);
  if (!competition || competitors.length < 2) return null;
  const home = competitors.find((item: LooseRecord) => item.homeAway === "home") || competitors[0];
  const away = competitors.find((item: LooseRecord) => item.homeAway === "away") || competitors.find((item: LooseRecord) => item !== home) || competitors[1];
  const homeTeam = asLooseRecord(home.team);
  const awayTeam = asLooseRecord(away.team);
  const homeName = homeTeam.displayName || homeTeam.shortDisplayName || "Home";
  const awayName = awayTeam.displayName || awayTeam.shortDisplayName || "Away";
  const homeScore = home?.score ?? "";
  const awayScore = away?.score ?? "";
  const status = asLooseRecord(asLooseRecord(event.status).type || asLooseRecord(competition.status).type);
  const completed = Boolean(status.completed);
  const statusText = status.shortDetail || status.detail || status.name || "";
  const rawDate = event.date;
  const date = new Date(
    typeof rawDate === "string" || typeof rawDate === "number" || rawDate instanceof Date
      ? rawDate
      : Date.now(),
  );
  const dateText = formatBeijingDateTime(date);
  const localParts = beijingDateTimeParts(date);
  const score = completed && homeScore !== "" && awayScore !== "" ? `${homeScore}-${awayScore}` : "vs";
  const stageLabel = formatStageLabel(event);
  return {
    completed,
    localYmd: localParts.ymd,
    localHour: localParts.hour,
    line: `${dateText} ${stageLabel ? `${stageLabel}: ` : ""}${String(homeName)} ${score} ${String(awayName)}${statusText ? ` (${String(statusText)})` : ""}`,
  };
}

function filterSportsRows(rows: SportsRow[], query: unknown, range: SportsDateRange): SportsRow[] {
  const text = String(query || "");
  const today = beijingYmd();
  const tomorrow = addDaysYmd(today, 1);
  const yesterday = addDaysYmd(today, -1);
  const explicitYmd = extractExplicitSportsYmd(text, today);
  let filtered: SportsRow[];
  if (explicitYmd && prefersScheduleRows(text)) {
    const next = addDaysYmd(explicitYmd, 1);
    filtered = rows.filter((row) => (row.localYmd === explicitYmd && row.localHour >= 18) || (row.localYmd === next && row.localHour <= 12));
  } else if (/(今晚|今夜|tonight)/i.test(text)) {
    filtered = rows.filter((row) => (row.localYmd === today && row.localHour >= 18) || (row.localYmd === tomorrow && row.localHour <= 12));
  } else if (/(今天|今日|today)/i.test(text)) {
    filtered = rows.filter((row) => row.localYmd === today);
  } else if (/(昨晚|昨天|昨日|yesterday)/i.test(text)) {
    filtered = rows.filter((row) => row.localYmd === yesterday || (row.localYmd === today && row.localHour <= 12));
  } else {
    const start = compactToYmd(range.start);
    const end = compactToYmd(range.end);
    filtered = rows.filter((row) => row.localYmd >= start && row.localYmd <= end);
  }
  const teams = mentionedWorldCupTeams(text);
  if (teams.length) {
    const narrowed = filtered.filter((row) => {
      const line = row.line.toLowerCase();
      return teams.every((team) => line.includes(team.toLowerCase()));
    });
    if (teams.length >= 2 || narrowed.length) return narrowed;
  }
  return filtered;
}

function wantsPredictedScore(query: unknown): boolean {
  return /预测|预估|猜|看好|可能比分|比分预测|predict|prediction|forecast/i.test(String(query || ""));
}

function relativeSportsScopeNote(query: unknown, range: SportsDateRange): string {
  const text = String(query || "");
  const start = compactToYmd(range.start);
  const end = compactToYmd(range.end);
  if (/(今晚|今夜|tonight)/i.test(text)) {
    return `查询口径: “今晚/今夜”按北京时间 ${start} 晚间至 ${end} 后续赛程处理；不是“昨晚”。`;
  }
  if (/(今天|今日|today)/i.test(text)) {
    return `查询口径: “今天/今日”按北京时间 ${start} 当日比赛处理。`;
  }
  if (/(昨晚|昨天|昨日|yesterday)/i.test(text)) {
    return `查询口径: “昨晚/昨天/昨日”按北京时间 ${start} 至 ${end} 中午前后的已结束比赛处理。`;
  }
  if (/(明天|明日|tomorrow)/i.test(text)) {
    return `查询口径: “明天/明日”按北京时间 ${start} 当日比赛处理。`;
  }
  return "";
}

function buildSportsScoreboardResult(input: {
  query: string;
  league: SportsLeagueInfo;
  source: string;
  range: SportsDateRange;
  rows: SportsRow[];
  sourceStatus?: string;
  note?: string;
}): SportsScoreboardResult {
  const { query, league, source, range, rows, sourceStatus, note } = input;
  const scoreRows = rows.filter((row) => row.completed && /\d+\s*[-–—:：比]\s*\d+/.test(row.line));
  const wantsPrediction = wantsPredictedScore(query);
  const wantsScores = wantsCompletedSportsScores(query);
  const selected = (wantsScores ? scoreRows : rows).slice(-24);
  const dateRange = `${range.start}-${range.end}`;
  const scopeNote = relativeSportsScopeNote(query, range);
  const header = [
    "体育查询结果 (ESPN scoreboard)",
    "provider: espn_scoreboard",
    sourceStatus ? `directSourceStatus: ${sourceStatus}` : "",
    wantsPrediction ? "userIntent: score_prediction" : "",
    `league: ${league.label}`,
    `source: ${source}`,
    `dateRange: ${dateRange}`,
    "时间口径: 北京时间",
    scopeNote,
    note ? `说明: ${note}` : "",
  ].filter(Boolean);
  const body = selected.length
    ? [
      `matched: ${selected.length}`,
      `匹配比赛: ${selected.length} 场`,
      "",
      ...selected.map((row) => `- ${row.line}`),
    ]
    : [
      "matched: 0",
      "匹配比赛: 0 场",
      "结论: 在上述 ESPN scoreboard 与北京时间口径下，未匹配到符合球队/时间条件的比赛；不要把其它日期或其它赛事脑补为本轮结论。",
    ];
  return {
    provider: "espn_scoreboard",
    query,
    league: league.label,
    source,
    dateRange,
    events: rows.length,
    text: [...header, ...body].join("\n"),
    evidence: selected.map((row) => ({
      type: "sports_score",
      kind: "sports_score",
      label: league.label,
      value: row.line,
      timestamp: new Date().toISOString(),
      source,
    })),
  };
}

function buildStaticWorldCupScheduleFallback(query: string, league: SportsLeagueInfo, range: SportsDateRange, error: unknown): SportsScoreboardResult | null {
  if (league.label !== "FIFA World Cup") return null;
  const rows = filterSportsRows(WORLD_CUP_2026_STATIC_ROWS, query, range);
  if (!rows.length) return null;
  const source = `builtin:fifa-world-cup-2026-schedule:${range.start}-${range.end}`;
  const errorText = error instanceof Error ? error.message : String(error || "direct source unavailable");
  return buildSportsScoreboardResult({
    query,
    league,
    source,
    range,
    rows,
    sourceStatus: "fallback_static_schedule",
    note: `ESPN scoreboard 本轮网络失败（${errorText}），已使用 Lynn 内置 2026 世界杯赛程/赛果 fallback；赛前时间和赛后比分仍建议回到官方赛程页复核。`,
  });
}

async function fetchEspnScoreboardJson(
  source: string,
  options: { shouldAbortRetry?: (error: unknown) => boolean } = {},
): Promise<LooseRecord> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= ESPN_SCOREBOARD_MAX_ATTEMPTS; attempt += 1) {
    try {
      const resp = await fetch(source, {
        headers: { "User-Agent": "Lynn/ESPNScoreboard" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) throw scoreboardHttpError(resp.status);
      return asLooseRecord(await resp.json());
    } catch (error) {
      lastError = error;
      if (options.shouldAbortRetry?.(error)) {
        throw error;
      }
      if (attempt >= ESPN_SCOREBOARD_MAX_ATTEMPTS || !shouldRetryScoreboardError(error)) {
        throw error;
      }
      await sleep(attempt === 1 ? 120 : 320);
    }
  }
  throw lastError;
}

export async function fetchSportsScoreboardEvidence(query: unknown): Promise<SportsScoreboardResult | null> {
  const text = compactLine(query);
  const league = resolveSportsLeague(text);
  if (!league) return null;
  const range = resolveSportsDateRange(text, league);
  const source = `https://site.api.espn.com/apis/site/v2/sports/${league.path}/scoreboard?limit=950&dates=${range.start}-${range.end}`;
  try {
    const data = await fetchEspnScoreboardJson(source);
    const events = looseRecordArray(data.events);
    const rows = filterSportsRows(events.map(formatEspnEvent).filter(Boolean) as SportsRow[], text, range);
    return buildSportsScoreboardResult({ query: text, league, source, range, rows });
  } catch (error) {
    const fallback = buildStaticWorldCupScheduleFallback(text, league, range, error);
    if (fallback) return fallback;
    throw error;
  }
}
