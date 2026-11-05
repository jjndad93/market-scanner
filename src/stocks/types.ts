import type { EvidenceKind } from '../core/evidence.ts';

/** One daily bar as supplied (provider-neutral). Values are validated by the normalizer. */
export interface RawBar {
  /** Session date, YYYY-MM-DD (New York). */
  date: unknown;
  close: unknown;
  volume: unknown;
  /** Optional day open, high and low (display-only warnings; never scored). */
  open?: unknown;
  high?: unknown;
  low?: unknown;
}

/** Provider-neutral input for one stock. */
export interface RawStock {
  symbol: string;
  name?: string;
  /** Live only: the security type from the provider's ticker reference (see massive-tickers.ts). */
  security?: SecurityInfo;
  /** Daily bars, any order; completed sessions only. */
  bars?: RawBar[] | null;
  /** Live only: why this stock has no bars (the request failed, or was never sent). */
  historyStatus?: StockHistoryStatus;
}

export type StockHistoryStatus = 'not_requested' | 'request_failed';

export interface StockDatasetMeta {
  kind: 'synthetic' | 'live';
  label: string;
  source: string;
  /** ISO timestamp the snapshot represents. */
  asOf: string;
  /** Live only: credit line for the data provider. */
  attribution?: string;
  /** Live only: what happened while collecting the data. */
  notes?: string[];
}

export interface Bar {
  date: string;
  close: number;
  volume: number;
  /** Day open, high and low when the source gave consistent values (low <= open, close <= high); else absent. */
  open?: number;
  high?: number;
  low?: number;
}

/** What kind of security a ticker is, from the provider's reference data (or unknown). */
export interface SecurityInfo {
  /** common stock, depositary receipt, exchange-traded product, or not checked. */
  kind: 'common' | 'adr' | 'etf' | 'unknown';
  /** The provider's type code (CS, ADRC, ETF, ETN, ...), or null when not checked. */
  typeCode: string | null;
  /** Short label for display, e.g. "Common stock", "ETF". */
  label: string;
  /** Where the type came from. */
  basis: string;
}

export interface StockSnapshot {
  symbol: string;
  name: string;
  /** Security type, when known (live market-wide scans). */
  security?: SecurityInfo;
  /** Valid bars, oldest first, one per session date. */
  bars: Bar[];
  /** Bars that were malformed, or conflicting duplicates of a date; counted, never used. */
  invalidBars: number;
  /** TEST DATA for fixtures, VERIFIED DATA for live values (as reported by the provider). */
  dataKind: EvidenceKind;
  historyStatus?: StockHistoryStatus;
}

export type StockExclusionCode =
  | 'invalid_record'
  | 'duplicate_symbol'
  | 'history_not_requested'
  | 'history_request_failed'
  | 'insufficient_history'
  | 'history_gap'
  | 'stale_data'
  | 'below_price'
  | 'below_liquidity'
  | 'implausible_data';

export interface StockExclusion {
  symbol: string;
  reasons: { code: StockExclusionCode; detail: string }[];
}

/** Everything here is calculated from the bars; the formulas are in analyze.ts. */
export interface StockMetrics {
  /** Latest completed session. */
  lastDate: string;
  close: number;
  /** % change of the latest close vs the previous session's close. */
  change1dPct: number;
  /** % change vs the close 5 sessions earlier, or null with fewer bars. */
  change5dPct: number | null;
  /** Shares traded in the latest session. */
  volume: number;
  /** Median shares per session over the baseline sessions (before the latest). */
  baselineVolume: number;
  /** Positive-volume sessions in the baseline. */
  baselineSessions: number;
  relativeVolume: number;
  /** close x volume for the latest session, USD. */
  dollarVolume: number;
  /** Median of close x volume over the baseline sessions, USD. */
  medianDollarVolume: number;
}

export type StockCandidateKind = 'mover' | 'watch';

export interface StockCandidate {
  stock: StockSnapshot;
  metrics: StockMetrics;
  kind: StockCandidateKind;
  /** Evidence strength (a rule tally), not an expected return. */
  score: number;
  maxScore: number;
  breakdown: { rule: string; points: number; max: number; detail: string }[];
  risks: string[];
}

export interface StockScanResult {
  dataset: StockDatasetMeta;
  evaluatedAt: string;
  universe: number;
  passedFilters: number;
  movers: StockCandidate[];
  watchlist: StockCandidate[];
  /** Met the threshold but beyond the display limit. */
  overLimit: StockCandidate[];
  /** Matched a pattern but scored below the threshold. */
  belowThreshold: StockCandidate[];
  notCandidates: number;
  /** Additive: the stocks counted in `notCandidates` (passed every filter, matched no pattern), by symbol. */
  noPattern: { stock: StockSnapshot; metrics: StockMetrics }[];
  /** Sorted by symbol. */
  excluded: StockExclusion[];
  /** Stocks with malformed or conflicting bars that were counted and not used. */
  invalidBars: { symbol: string; count: number }[];
  /** Stocks whose bars were never obtained (live): failed or not requested. */
  notEvaluated: { requestFailed: number; notRequested: number };
  /** Latest-session dates of the stocks that passed all filters (null when none did). */
  evaluatedSessions: { tickers: number; earliest: string | null; latest: string | null };
}
