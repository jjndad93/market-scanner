import type { Evidence } from '../core/evidence.ts';

/**
 * Provider-neutral input record for one asset. Stage 2 P1 reads it only from synthetic
 * fixtures; a later provider (P2) will translate a real API response into this shape.
 * Numbers may be missing or invalid in the input; normalization reports that explicitly.
 */
export interface RawAsset {
  id: string;
  symbol: string;
  name: string;
  /** Price in USD. */
  price?: number | null;
  /** Percentage change, e.g. 18.2 means +18.2%. */
  change24hPct?: number | null;
  change7dPct?: number | null;
  /** Trailing 24h volume in USD. */
  volume24h?: number | null;
  marketCap?: number | null;
  /** ISO timestamp of the asset's latest data point. */
  lastUpdated?: string | null;
  /** Prior daily volumes in USD (oldest first), excluding the current 24h. */
  dailyVolumes?: number[] | null;
  /** Optional classification hints, e.g. "stablecoin", "wrapped", "staked". */
  tags?: string[];
  /** Live only: set when this run did not obtain the asset's history (see HistoryStatus). */
  historyStatus?: HistoryStatus;
}

/**
 * Why a live asset has no history: 'not_requested' (the run stopped requesting history: request
 * limit or rate limit) or 'request_failed' (the request was sent but failed, or its response had
 * no usable volume data). Absent when history was obtained, and always absent for fixtures.
 */
export type HistoryStatus = 'not_requested' | 'request_failed';

/**
 * Live only: how much of the history-eligible universe this run actually obtained history for.
 * Every eligible asset is counted in exactly one of fetched, requestFailed and notRequested.
 */
export interface HistoryCoverage {
  /** Distinct assets that passed every non-history filter when the data was fetched. */
  historyEligible: number;
  /** History obtained and parsed (it may still fail the history-sufficiency rules). */
  historyFetched: number;
  /** Of historyFetched: reused from the local history cache (no request made). */
  historyFromCache: number;
  /** Request sent but failed, or the response had no usable volume data. */
  historyRequestFailed: number;
  /** Never requested because the run stopped (request limit or rate limit). */
  historyNotRequested: number;
  /** True only when no request failed and nothing was left unrequested. */
  complete: boolean;
  /** Why history requests stopped; null whenever historyNotRequested is 0. */
  stopReason: string | null;
  /** Requests made in this run (markets + history, retries included). */
  requestsUsed: number;
  /** The run's request limit. */
  requestLimit: number;
}

/**
 * Where a dataset came from. 'synthetic' fixtures are always labeled TEST DATA; 'live' data was
 * fetched by this tool from a named provider and must carry that provider's attribution.
 */
export interface DatasetMeta {
  kind: 'synthetic' | 'live';
  label: string;
  source: string;
  /** ISO timestamp the snapshot represents. */
  asOf: string;
  /** Required for live data: the provider's attribution text, shown in every live report. */
  attribution?: string;
  /** Live only: what happened while collecting the data (partial failures, skipped calls). */
  notes?: string[];
  /** Live only: history coverage of this run; absent for fixtures. */
  coverage?: HistoryCoverage;
}

export interface AssetSnapshot {
  id: string;
  symbol: string;
  name: string;
  tags: string[];
  price: Evidence<number>;
  change24hPct: Evidence<number>;
  change7dPct: Evidence<number>;
  volume24h: Evidence<number>;
  marketCap: Evidence<number>;
  lastUpdated: Evidence<string>;
  /** Valid (finite, positive) daily volumes from the most recent history window. */
  dailyVolumes: number[];
  /** What happened to the supplied history, so nothing is dropped silently. */
  history: VolumeHistoryStats;
  /** Live only: present when this run did not obtain the asset's history. */
  historyStatus?: HistoryStatus;
}

export interface VolumeHistoryStats {
  /** Entries supplied in the input. */
  supplied: number;
  /** Entries inside the window (the most recent `historyWindowDays`). */
  windowDays: number;
  /** Entries in the window equal to 0: counted, not used in the median. */
  zeroDays: number;
  /** Entries in the window that were not finite non-negative numbers (text, null, negative, NaN). */
  invalidEntries: number;
}

export type ExclusionCode =
  | 'invalid_record'
  | 'duplicate_record' // an identical extra copy of an asset already counted
  | 'duplicate_conflict' // several records share an id but disagree; none is used
  | 'stablecoin' // known symbol, id or tag
  | 'possible_stablecoin' // pegged-price heuristic; not proof
  | 'wrapped_or_staked'
  | 'missing_data'
  | 'implausible_data' // a value beyond the plausibility limits; treated as a data error
  | 'below_market_cap'
  | 'below_volume'
  | 'insufficient_history'
  | 'unreliable_history' // too many zero/invalid days, or a near-zero baseline
  | 'history_not_requested' // live: history never requested (request or rate limit); not evaluated
  | 'history_request_failed' // live: history request failed or returned no usable data; not evaluated
  | 'stale_data';

export interface ExclusionReason {
  code: ExclusionCode;
  detail: string;
}

export interface Exclusion {
  id: string;
  symbol: string;
  name: string;
  reasons: ExclusionReason[];
}

export interface AssetMetrics {
  /** Median of the prior daily volumes. */
  baselineVolume: Evidence<number>;
  /** 24h volume / baseline median. */
  relativeVolume: Evidence<number>;
  /** 24h volume / market cap. */
  turnover: Evidence<number>;
  /** Minutes between the asset's last update and the scan time; null if unknown. */
  dataAgeMinutes: number | null;
}

export interface ScorePart {
  rule: string;
  points: number;
  max: number;
  detail: string;
}

export type CandidateKind = 'mover' | 'watch';

export interface Candidate {
  asset: AssetSnapshot;
  metrics: AssetMetrics;
  kind: CandidateKind;
  direction: 'up' | 'down';
  /** Evidence strength, not an expected return. */
  score: number;
  maxScore: number;
  breakdown: ScorePart[];
  risks: string[];
}

export interface ScanResult {
  dataset: DatasetMeta;
  /** ISO timestamp the scan was evaluated at. */
  evaluatedAt: string;
  universe: number;
  passedFilters: number;
  movers: Candidate[];
  watchlist: Candidate[];
  /** Qualified and above threshold, but beyond the display limit. */
  moversOverLimit: Candidate[];
  watchlistOverLimit: Candidate[];
  /** Matched a candidate pattern but scored below the evidence threshold. */
  belowThreshold: Candidate[];
  /** Passed filters but matched neither the mover nor the watchlist pattern. */
  notCandidates: number;
  /** Sorted by id, then by first reason, so the order never depends on the input order. */
  excluded: Exclusion[];
  /** Distinct ids sharing one symbol: ambiguous, so the report names them by id. */
  symbolCollisions: { symbol: string; ids: string[] }[];
}
