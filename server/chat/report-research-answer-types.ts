export type ResearchAnswerKind =
  | ""
  | "stock"
  | "real_estate"
  | "market_weather_brief"
  | "weather"
  | "sports"
  | "market"
  | "news"
  | "public_data"
  | "generic"
  | (string & {});

export interface ToolTextContent {
  text?: unknown;
  [key: string]: unknown;
}

export interface DirectQuoteSnapshot {
  symbol?: unknown;
  close?: unknown;
  date?: unknown;
  time?: unknown;
  source?: unknown;
  url?: unknown;
  open?: unknown;
  high?: unknown;
  low?: unknown;
  [key: string]: unknown;
}

export interface EvidenceSource {
  title?: unknown;
  source?: unknown;
  url?: unknown;
  [key: string]: unknown;
}

export interface ToolResultDetails {
  directQuotes?: DirectQuoteSnapshot[];
  provider?: unknown;
  sources?: EvidenceSource[];
  location?: unknown;
  [key: string]: unknown;
}

export interface ToolExecutionResult {
  content?: ToolTextContent[];
  details?: ToolResultDetails;
  [key: string]: unknown;
}

export interface StooqItem {
  symbol: string;
  source: string;
  url: string;
  name: string;
  price: string;
  change: string;
  timestamp: string;
  range: string;
}

export interface StockSnapshot {
  symbol?: unknown;
  price?: unknown;
  timestamp?: string;
  source?: unknown;
  url?: unknown;
  range?: string;
}

export interface IndexFallbackTarget {
  label?: string;
  [key: string]: unknown;
}

export interface IndexSnapshot {
  name?: string;
  level?: string;
  change?: string;
  source?: unknown;
  url?: unknown;
  queryDate: string;
}

export interface WeatherForecastRow {
  date: string;
  desc: string;
  min: string;
  max: string;
}

export interface WeatherSnapshot {
  location?: unknown;
  date: string;
  desc: string;
  tempRange: string;
}

export interface EvidenceMeta {
  tool: string;
  basis: string;
  caveat: string;
}

export interface EvidenceBlockOptions {
  kind?: ResearchAnswerKind;
  context?: unknown;
  userPrompt?: unknown;
}

export type StructuredSectionEntry = readonly [string, unknown];
export type StructuredFields = Record<string, string>;

export interface TempRange {
  min: number | null;
  max: number | null;
}

export interface GoldSummary {
  date: string;
  jewelry: string;
  bars: string;
  recovery: string;
  examples: string;
  sge: string;
  shuibei: string;
  international: string;
}

export interface NewsItem {
  title: string;
  source: string;
  sourceUrl: string;
  link: string;
  snippet?: string;
  published: string;
  windowLabel: string;
  freshness: string;
}

export interface BuildAnswerOptions {
  userPrompt?: unknown;
  prompt?: unknown;
  [key: string]: unknown;
}
