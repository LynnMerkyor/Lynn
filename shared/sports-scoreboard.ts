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

type LooseRecord = Record<string, any>;

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

function compactLine(value: unknown): string {
  return String(value || "").replace(/\s+/g, " ").trim();
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
    if (/(已出|已经|比分|赛果|结果|完赛|score|result)/i.test(text)) {
      return { start: ymdCompact(league.tournamentStart), end: ymdCompact(today) };
    }
  }
  if (/(昨晚|昨天|昨日|yesterday)/i.test(text)) {
    return { start: ymdCompact(addDaysYmd(today, -1)), end: ymdCompact(today) };
  }
  if (/(明天|明日|tomorrow)/i.test(text)) {
    const tomorrow = addDaysYmd(today, 1);
    return { start: ymdCompact(tomorrow), end: ymdCompact(tomorrow) };
  }
  if (/(今晚|今夜|今天|今日|today|tonight)/i.test(text)) {
    return { start: ymdCompact(today), end: ymdCompact(addDaysYmd(today, 1)) };
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
  return { ymd: `${pick("year")}-${pick("month")}-${pick("day")}`, hour: Number(pick("hour") || 0) };
}

function formatEspnEvent(event: LooseRecord): SportsRow | null {
  const competition = event?.competitions?.[0];
  const competitors = Array.isArray(competition?.competitors) ? competition.competitors : [];
  if (!competition || competitors.length < 2) return null;
  const home = competitors.find((item: LooseRecord) => item.homeAway === "home") || competitors[0];
  const away = competitors.find((item: LooseRecord) => item.homeAway === "away") || competitors.find((item: LooseRecord) => item !== home) || competitors[1];
  const homeName = home?.team?.displayName || home?.team?.shortDisplayName || "Home";
  const awayName = away?.team?.displayName || away?.team?.shortDisplayName || "Away";
  const homeScore = home?.score ?? "";
  const awayScore = away?.score ?? "";
  const status = event?.status?.type || competition?.status?.type || {};
  const completed = Boolean(status.completed);
  const statusText = status.shortDetail || status.detail || status.name || "";
  const date = new Date(event?.date || Date.now());
  const dateText = formatBeijingDateTime(date);
  const localParts = beijingDateTimeParts(date);
  const score = completed && homeScore !== "" && awayScore !== "" ? `${homeScore}-${awayScore}` : "vs";
  return {
    completed,
    localYmd: localParts.ymd,
    localHour: localParts.hour,
    line: `${dateText} ${homeName} ${score} ${awayName}${statusText ? ` (${statusText})` : ""}`,
  };
}

function filterSportsRows(rows: SportsRow[], query: unknown, range: SportsDateRange): SportsRow[] {
  const text = String(query || "");
  const today = beijingYmd();
  const tomorrow = addDaysYmd(today, 1);
  const yesterday = addDaysYmd(today, -1);
  let filtered: SportsRow[];
  if (/(今晚|今夜|tonight)/i.test(text)) {
    filtered = rows.filter((row) => (row.localYmd === today && row.localHour >= 18) || row.localYmd === tomorrow);
  } else if (/(今天|今日|today)/i.test(text)) {
    filtered = rows.filter((row) => row.localYmd === today);
  } else if (/(昨晚|昨天|昨日|yesterday)/i.test(text)) {
    filtered = rows.filter((row) => (row.localYmd === yesterday && row.localHour >= 18) || (row.localYmd === today && row.localHour <= 12));
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

export async function fetchSportsScoreboardEvidence(query: unknown): Promise<SportsScoreboardResult | null> {
  const text = compactLine(query);
  const league = resolveSportsLeague(text);
  if (!league) return null;
  const range = resolveSportsDateRange(text, league);
  const source = `https://site.api.espn.com/apis/site/v2/sports/${league.path}/scoreboard?limit=950&dates=${range.start}-${range.end}`;
  const resp = await fetch(source, {
    headers: { "User-Agent": "Lynn/ESPNScoreboard" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`ESPN scoreboard HTTP ${resp.status}`);
  const data = await resp.json() as LooseRecord;
  const events = Array.isArray(data?.events) ? data.events : [];
  const rows = filterSportsRows(events.map(formatEspnEvent).filter(Boolean) as SportsRow[], text, range);
  const scoreRows = rows.filter((row) => row.completed && /\d+\s*[-–—:：比]\s*\d+/.test(row.line));
  const wantsScores = /(比分|赛果|结果|已出|已经|完赛|score|result|final)/i.test(text);
  const selected = (wantsScores ? scoreRows : rows).slice(-24);
  const dateRange = `${range.start}-${range.end}`;
  const header = [
    "体育查询结果 (ESPN scoreboard)",
    "provider: espn_scoreboard",
    `league: ${league.label}`,
    `source: ${source}`,
    `dateRange: ${dateRange}`,
    "时间口径: 北京时间",
  ];
  const body = selected.length
    ? [
      `匹配比赛: ${selected.length} 场`,
      "",
      ...selected.map((row) => `- ${row.line}`),
    ]
    : [
      "matched: 0",
    ];
  return {
    provider: "espn_scoreboard",
    query: text,
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
