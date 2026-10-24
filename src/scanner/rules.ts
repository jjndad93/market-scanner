/**
 * Every threshold the crypto scanner uses, in one place. These are provisional heuristics
 * chosen for this tool, not empirically calibrated trading rules. Scores measure the
 * strength of the observed evidence, never an expected return.
 */
export const SCAN_RULES = {
  // Filters
  minMarketCap: 100_000_000, // USD
  minVolume24h: 10_000_000, // USD
  minHistoryDays: 20, // valid (positive) daily volumes needed in the window for a median baseline
  maxDataAgeMinutes: 15,

  // Volume history. Only the most recent `historyWindowDays` entries are used. Zero-volume days
  // are counted and reported but not used in the median (providers often report 0 for missing
  // data, and zeros would drag the median down and inflate relative volume). Zero or invalid
  // days beyond `maxUnreliableHistoryDays` make the whole baseline unreliable.
  historyWindowDays: 30,
  maxUnreliableHistoryDays: 5,
  minBaselineVolume: 1_000_000, // USD/day; a smaller median baseline cannot support a ratio

  // Plausibility limits (data quality, not market judgment). A value beyond these is more likely
  // a data error than evidence, so the asset is excluded and earns no points. These are
  // conservative guards, not calibrated statistics; a genuine extreme move would also be excluded.
  maxAbsChange24hPct: 300,
  maxAbsChange7dPct: 1000,
  maxTurnover: 1, // 24h volume above the entire market cap
  maxRelativeVolume: 50,

  // Candidate patterns
  moverMinAbsMovePct: 8, // |24h change| >= 8% ...
  moverMinRelVolume: 1.5, // ... with 24h volume >= 1.5x the baseline median
  watchMaxAbsMovePct: 5, // |24h change| < 5% ...
  watchMinRelVolume: 2, // ... but 24h volume >= 2x the baseline median

  // Evidence thresholds and display limits
  moverMinScore: 4, // out of 8
  watchMinScore: 3, // out of 5
  maxMovers: 5,
  maxWatchlist: 3,

  // A coin priced within 2% of $1 that barely moved looks pegged (stablecoin heuristic).
  peggedPriceBand: 0.02,
  peggedMaxAbs24hPct: 0.5,
  peggedMaxAbs7dPct: 1,

  // Risk notes (shown, not scored)
  thinVolume24h: 25_000_000, // below this, spreads and slippage are likely to matter
  extremeRelVolume: 10, // a spike this large may be a one-off or a reporting artifact
  highTurnover: 0.5, // 24h volume above half the market cap suggests speculative churn
  // Stage 11, informational only (never scored): when the middle half of the baseline's daily
  // volumes spans this many-fold range (Q3 / Q1), the baseline is "highly variable" and a volume
  // multiple says less. A heuristic: on real data from 2026-10-21, seven large coins measured
  // 1.4-2.5 and an erratic one 38.5. Q3/Q1 ignores the lowest and highest quarter of days, so a
  // single tiny or huge day cannot trigger it (unlike max/min).
  variableBaselineIqrRatio: 4,

  // Step 2, discovery pre-screen (never scored): signs of unusual activity readable from the
  // market snapshot alone. Live runs request history for such assets first, so a limited request
  // budget is not spent only on the largest coins. Heuristics, not calibrated statistics. A large
  // 24h move reuses `moverMinAbsMovePct`.
  prescreenMinTurnover: 0.15, // 24h volume >= 15% of market cap
  prescreenMinAbs7dPct: 20, // |7-day change| >= 20%
};

export type ScanRules = { readonly [K in keyof typeof SCAN_RULES]: number };

/** Scoring tables: [minimum, points], checked from the top. */
export const SCORE_TABLE = {
  relativeVolume: [[3, 3], [2, 2], [1.5, 1]] as const, // max 3
  moveAbsPct: [[15, 2], [8, 1]] as const, // max 2 (movers only)
  volume24h: [[100_000_000, 2], [25_000_000, 1]] as const, // max 2
  trendAgreement: 1, // movers only: 7-day change in the same direction as the 24h move
} as const;

export const MOVER_MAX_SCORE = 3 + 2 + 2 + 1;
export const WATCH_MAX_SCORE = 3 + 2;

/**
 * Known stablecoin symbols. Incomplete by nature, and symbols can collide across assets, so
 * known ids and tags are checked too, and a pegged-price heuristic backs them up.
 */
export const STABLECOIN_SYMBOLS: ReadonlySet<string> = new Set([
  'USDT', 'USDC', 'DAI', 'TUSD', 'USDP', 'FDUSD', 'PYUSD', 'USDE', 'USDS', 'FRAX', 'GUSD', 'LUSD', 'USDD', 'EURC',
  'BUSD', 'GHO', 'CRVUSD', 'RLUSD', 'USD1',
]);

/**
 * Known stablecoin asset ids. These follow CoinGecko-style ids and must be re-verified when a
 * real provider is added (P2); in P1 they only matter for fixtures that use them.
 */
export const STABLECOIN_IDS: ReadonlySet<string> = new Set(['tether', 'usd-coin', 'dai']);

/**
 * Tags are matched EXACTLY after normalization (lower case; spaces and underscores become
 * hyphens), so negations and near-matches such as "non-stablecoin" or "unstaked-rewards" never
 * match. Unlisted tag spellings are simply not recognized.
 */
export function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase().replace(/[\s_]+/g, '-');
}

/** Tags that identify a stablecoin. */
export const STABLECOIN_TAGS: ReadonlySet<string> = new Set([
  'stablecoin', 'stablecoins', 'usd-stablecoin', 'eur-stablecoin', 'fiat-backed-stablecoin',
  'crypto-backed-stablecoin', 'algorithmic-stablecoin',
]);

/** Tag that overrides the pegged-price heuristic for a genuine asset that trades near $1. */
export const NOT_STABLECOIN_TAG = 'not-stablecoin';

/** Known wrapped / liquid-staking token symbols (incomplete; tag and name checks back it up). */
export const WRAPPED_STAKED_SYMBOLS: ReadonlySet<string> = new Set([
  'WBTC', 'WETH', 'STETH', 'WSTETH', 'CBETH', 'RETH', 'WEETH', 'CBBTC', 'WBNB', 'EZETH',
]);

export const WRAPPED_STAKED_NAME = /\b(wrapped|staked|bridged)\b/i;
/** Tags for wrapped, bridged, staked, liquid-staking and restaking tokens (exact, normalized). */
export const WRAPPED_STAKED_TAGS: ReadonlySet<string> = new Set([
  'wrapped', 'wrapped-tokens', 'bridged', 'bridged-tokens', 'staked', 'liquid-staking',
  'liquid-staking-tokens', 'liquid-restaking', 'liquid-restaking-tokens', 'restaking',
]);
