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

export interface SportsScoreboardOptions {
  league?: unknown;
  date_from?: unknown;
  date_to?: unknown;
  teams?: unknown;
}

interface SportsLeagueInfo {
  label: string;
  path: string;
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

function buildSportsScoreboardResult(input: {
  query: string;
  league: SportsLeagueInfo;
  source: string;
  range: SportsDateRange;
  rows: SportsRow[];
  sourceStatus?: string;
  note?: string;
  sources?: string[];
  teams?: string[];
}): SportsScoreboardResult {
  const { query, league, source, range, rows, sourceStatus, note, sources } = input;
  const selected = rows;
  const dateRange = `${range.start}-${range.end}`;
  const teams = input.teams || [];
  const header = [
    "体育查询结果 (ESPN scoreboard)",
    "provider: espn_scoreboard",
    sourceStatus ? `directSourceStatus: ${sourceStatus}` : "",
    `league: ${league.label}`,
    teams.length ? `teams: ${teams.join(", ")}` : "",
    `source: ${source}`,
    ...(sources || []).filter((url) => url !== source).map((url) => `source: ${url}`),
    `dateRange: ${dateRange}`,
    "时间口径: 北京时间",
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
      const data = asLooseRecord(await resp.json());
      if (!Array.isArray(data.events)) throw new Error('ESPN scoreboard invalid events payload');
      return data;
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

const MODEL_LEAGUE_PATHS: Record<string, SportsLeagueInfo> = {
  "fifa.world": { label: "FIFA World Cup", path: "soccer/fifa.world" },
  worldcup: { label: "FIFA World Cup", path: "soccer/fifa.world" },
  "world-cup": { label: "FIFA World Cup", path: "soccer/fifa.world" },
  nba: { label: "NBA", path: "basketball/nba" },
  mlb: { label: "MLB", path: "baseball/mlb" },
  nhl: { label: "NHL", path: "hockey/nhl" },
};

function leagueFromModel(value: unknown): SportsLeagueInfo | null {
  const key = compactLine(value).toLowerCase().replace(/\s+/g, "");
  return MODEL_LEAGUE_PATHS[key] || null;
}

export function modelDateRange(options: SportsScoreboardOptions): SportsDateRange {
  if (options.date_from === undefined) throw new Error("missing_date_range: model must supply date_from and date_to");
  const first = compactToYmd(options.date_from);
  const last = compactToYmd(options.date_to || options.date_from);
  const validDate = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value)
    && validYmd(value.slice(0, 4), value.slice(5, 7), value.slice(8, 10)) === value;
  if (!validDate(first) || !validDate(last) || first > last) {
    throw new Error('invalid_date_range: supply date_from <= date_to as YYYY-MM-DD');
  }
  return { start: ymdCompact(first), end: ymdCompact(last) };
}

async function fetchScoreboardWindow(base: string, first: string, last: string): Promise<{ events: LooseRecord[]; sources: string[] }> {
  const source = `${base}&dates=${first}-${last}`;
  try {
    const data = await fetchEspnScoreboardJson(source);
    return { events: looseRecordArray(data.events), sources: [source] };
  } catch (error) {
    if (Number((error as { status?: number })?.status) !== 400) throw error;
  }
  const dates: string[] = [];
  for (let date = compactToYmd(first); date <= compactToYmd(last); date = addDaysYmd(date, 1)) {
    if (dates.length >= 33) throw new Error('date_range_too_large: source requires daily queries; split into windows of at most 31 days');
    dates.push(ymdCompact(date));
  }
  const events: LooseRecord[] = [];
  const sources = dates.map((date) => `${base}&dates=${date}`);
  for (let offset = 0; offset < sources.length; offset += 4) {
    const daily = await Promise.all(sources.slice(offset, offset + 4).map((url) => fetchEspnScoreboardJson(url)));
    for (const data of daily) events.push(...looseRecordArray(data.events));
  }
  const unique = new Map<string, LooseRecord>();
  for (const event of events) unique.set(compactLine(event.id) || JSON.stringify(event), event);
  return { events: [...unique.values()], sources };
}

export async function fetchSportsScoreboardEvidence(
  query: unknown,
  options: SportsScoreboardOptions = {},
): Promise<SportsScoreboardResult | null> {
  const text = compactLine(query);
  const league = leagueFromModel(options.league);
  if (!league) return null;
  const range = modelDateRange(options);
  const fetchStart = ymdCompact(addDaysYmd(compactToYmd(range.start), -1));
  const fetchEnd = ymdCompact(addDaysYmd(compactToYmd(range.end), 1));
  const base = `https://site.api.espn.com/apis/site/v2/sports/${league.path}/scoreboard?limit=950`;
  const { events, sources } = await fetchScoreboardWindow(base, fetchStart, fetchEnd);
  const allRows = events.map(formatEspnEvent).filter(Boolean) as SportsRow[];
  const teams = Array.isArray(options.teams) ? options.teams.map(compactLine).filter(Boolean) : [];
  const rows = allRows.filter((row) => row.localYmd >= compactToYmd(range.start) && row.localYmd <= compactToYmd(range.end)
    && teams.every((team) => row.line.toLowerCase().includes(team.toLowerCase())));
  return buildSportsScoreboardResult({ query: text, league, source: sources[0], sources, sourceStatus: 'ok', range, rows, teams });
}
