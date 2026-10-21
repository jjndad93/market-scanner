/**
 * Every threshold the US-stock scanner uses, in one place. Like the crypto rules, these are
 * provisional heuristics chosen for this tool, not calibrated trading rules. Scores measure the
 * strength of the observed evidence, never an expected return.
 */
export const STOCK_RULES = {
  // History: the baseline is the sessions before the latest one.
  baselineSessions: 20,
  minBaselineSessions: 15, // positive-volume sessions needed for a median baseline
  maxGapDays: 5, // calendar days between consecutive bars (longer than any weekend + holiday)
  maxSessionAgeDays: 4, // latest bar vs the scan date (covers a 3-day weekend)

  // Filters
  minPrice: 5, // USD
  minMedianDollarVolume: 20_000_000, // USD per session
  maxRelativeVolume: 50, // beyond this, more likely a data error than evidence

  // Candidate patterns (latest session)
  moverMinAbsMovePct: 4, // |1-day change| >= 4% ...
  moverMinRelVolume: 1.5, // ... on volume >= 1.5x the baseline median
  watchMaxAbsMovePct: 2, // |1-day change| < 2% ...
  watchMinRelVolume: 2, // ... but volume >= 2x the baseline median

  // Evidence thresholds and display limits
  moverMinScore: 4, // out of 8
  watchMinScore: 3, // out of 5
  maxMovers: 5,
  maxWatchlist: 3,

  // Risk notes (shown, not scored)
  extremeRelVolume: 10,
};

export type StockRules = { readonly [K in keyof typeof STOCK_RULES]: number };

/** Scoring tables: [minimum, points], checked from the top. */
export const STOCK_SCORE_TABLE = {
  relativeVolume: [[3, 3], [2, 2], [1.5, 1]] as const, // max 3
  moveAbsPct: [[8, 2], [4, 1]] as const, // max 2 (movers only)
  dollarVolume: [[1_000_000_000, 2], [200_000_000, 1]] as const, // max 2
  trendAgreement: 1, // movers only: 5-day change in the same direction as the 1-day move
} as const;

export const STOCK_MOVER_MAX_SCORE = 3 + 2 + 2 + 1;
export const STOCK_WATCH_MAX_SCORE = 3 + 2;

/**
 * The initial, deliberately small live universe: 20 large, liquid US-listed stocks across
 * sectors. Not a recommendation list and not a market-wide scan; there is no universe
 * discovery yet.
 */
export const STOCK_UNIVERSE: readonly string[] = [
  'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AVGO', 'JPM', 'V',
  'UNH', 'XOM', 'LLY', 'WMT', 'JNJ', 'PG', 'MA', 'HD', 'COST', 'NFLX',
];
