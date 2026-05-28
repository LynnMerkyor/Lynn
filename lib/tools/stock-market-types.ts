import type { SearchResultItem } from "./web-search.js";

export type MarketKind = string;
export type LooseRecord = Record<string, any>;

export type ToolTextResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
};

export interface StockMarketToolParams {
  query?: string;
  kind?: string;
  market?: string;
  symbol?: string;
}

export interface MarketQuote {
  symbol?: string;
  stooqSymbol?: string;
  name?: string;
  date?: string;
  time?: string;
  open?: string;
  high?: string;
  low?: string;
  close?: string;
  previousClose?: string;
  previous?: string;
  change?: string;
  pct?: string;
  volume?: string;
  amount?: string;
  amountText?: string;
  turnoverRate?: string;
  pe?: string;
  source?: string;
  url?: string;
  currency?: string;
  price?: string;
}

export interface NamedPrice {
  name: string;
  price: string;
  date?: string;
}

export interface PriceRange {
  min: number;
  minName: string;
  max: number;
  maxName: string;
}

export interface GoldSignals {
  jewelry: NamedPrice[];
  jewelryRange: PriceRange | null;
  bars: NamedPrice[];
  barRange: PriceRange | null;
  recovery: NamedPrice[];
  goldRecovery: NamedPrice | null;
  date: string;
  sgeLines: string[];
  shuibeiLines: string[];
  internationalLines: string[];
}

export interface MarketSource extends Partial<SearchResultItem> {
  title?: string;
  url?: string;
  snippet?: string;
  lines?: string[];
  goldSignals?: GoldSignals | null;
  source?: string;
  host?: string;
  timestamp?: string;
  date?: string;
}

export interface MarketCollection {
  provider: string;
  plan: { scene?: string } | null;
  sources: MarketSource[];
  directQuotes: MarketQuote[];
}

export interface ConceptResolution {
  marketHint: string;
  symbols: string[];
  sources: MarketSource[];
}

export interface ConceptQuotes {
  marketHint?: string;
  sources: MarketSource[];
  directQuotes: MarketQuote[];
}
