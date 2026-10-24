/**
 * Dashboard insights for crypto assets: a category label with its evidence, and volatility-risk
 * measures. INFORMATIONAL ONLY: nothing here changes eligibility, scoring, ranking or verdicts
 * (the existing stablecoin and wrapped/staked filters are separate and unchanged).
 *
 * Classification evidence, strongest first:
 *   1. provider category data: NOT AVAILABLE. CoinGecko /coins/markets (what the scanner fetches)
 *      returns no category field; categories would need an extra request whose meme-category id
 *      is not verified yet. So "meme coin" and "other project/utility token" are never assigned.
 *   2. the project's curated lists (rules.ts): known stablecoin ids/symbols/tags and known
 *      wrapped/staked symbols/tags. Symbols can be shared by unrelated assets, which is noted.
 *   3. heuristics: the existing pegged-price pattern (possible stablecoin), and CoinGecko
 *      market-cap rank <= ESTABLISHED_MAX_RANK ("established", meaning large, NOT legitimate/safe).
 * A name pattern ("wrapped"/"staked"/"bridged") is recorded but never used on its own.
 * Contradictory evidence at the deciding level, or none, gives "unknown".
 */

import { has } from '../core/evidence.ts';
import { volumeReliability } from './analyze.ts';
import {
  NOT_STABLECOIN_TAG, SCAN_RULES, STABLECOIN_IDS, STABLECOIN_SYMBOLS, STABLECOIN_TAGS, type ScanRules,
  WRAPPED_STAKED_NAME, WRAPPED_STAKED_SYMBOLS, WRAPPED_STAKED_TAGS,
} from './rules.ts';
import type { AssetSnapshot, VolumeReliability } from './types.ts';

export type CryptoCategory = 'established' | 'meme' | 'stablecoin' | 'wrapped_staked' | 'other_project' | 'unknown';
export const CATEGORY_LABEL: Record<CryptoCategory, string> = {
  established: 'Established crypto asset',
  meme: 'Meme coin',
  stablecoin: 'Stablecoin',
  wrapped_staked: 'Wrapped/staked token',
  other_project: 'Other project/utility token',
  unknown: 'Unknown/unclassified',
};

/** Informational heuristic: CoinGecko market-cap rank at or below this is labelled "established" (large), never "safe". */
export const ESTABLISHED_MAX_RANK = 20;

export interface Classification {
  category: CryptoCategory;
  label: string;
  /** What decided it: provider data, the project's curated lists, a heuristic, or nothing. */
  basis: 'provider' | 'curated_list' | 'heuristic' | 'none';
  /** Every piece of evidence found, with its source. */
  evidence: string[];
  /** Why the result is unknown, or a caveat. */
  note: string | null;
}

export function classifyCrypto(a: AssetSnapshot, rules: ScanRules = SCAN_RULES): Classification {
  const curated: [CryptoCategory, string][] = [];
  const heuristic: [CryptoCategory, string][] = [];
  const notes: string[] = [];
  if (STABLECOIN_IDS.has(a.id)) curated.push(['stablecoin', `id "${a.id}" is on the project's curated stablecoin list`]);
  if (STABLECOIN_SYMBOLS.has(a.symbol)) curated.push(['stablecoin', `symbol ${a.symbol} is on the project's curated stablecoin list (symbols can be shared by unrelated assets)`]);
  for (const t of a.tags) if (STABLECOIN_TAGS.has(t)) curated.push(['stablecoin', `tag "${t}"`]);
  if (WRAPPED_STAKED_SYMBOLS.has(a.symbol)) curated.push(['wrapped_staked', `symbol ${a.symbol} is on the project's curated wrapped/staked list (symbols can be shared)`]);
  for (const t of a.tags) if (WRAPPED_STAKED_TAGS.has(t)) curated.push(['wrapped_staked', `tag "${t}"`]);

  const pegged = has(a.price) && has(a.change24hPct) && Math.abs(a.price.value - 1) <= rules.peggedPriceBand
    && Math.abs(a.change24hPct.value) <= rules.peggedMaxAbs24hPct && (!has(a.change7dPct) || Math.abs(a.change7dPct.value) <= rules.peggedMaxAbs7dPct);
  if (pegged && !a.tags.includes(NOT_STABLECOIN_TAG)) heuristic.push(['stablecoin', 'heuristic: price within 2% of $1 with almost no movement (pegged pattern)']);
  const rank = a.market?.rank;
  if (rank && has(rank) && rank.value <= ESTABLISHED_MAX_RANK) {
    heuristic.push(['established', `heuristic: CoinGecko market-cap rank ${rank.value} (rank ${ESTABLISHED_MAX_RANK} or better); size, not legitimacy or safety`]);
  }
  if (WRAPPED_STAKED_NAME.test(a.name)) notes.push(`name "${a.name}" mentions wrapped/staked/bridged; a name alone is not used as evidence`);

  const evidence = [...curated, ...heuristic].map(([, e]) => e);
  const decide = (list: [CryptoCategory, string][], basis: Classification['basis']): Classification | null => {
    const cats = [...new Set(list.map(([c]) => c))];
    if (cats.length === 1) return { category: cats[0]!, label: CATEGORY_LABEL[cats[0]!], basis, evidence, note: notes.join('; ') || null };
    if (cats.length > 1) {
      return { category: 'unknown', label: CATEGORY_LABEL.unknown, basis: 'none', evidence, note: [`contradictory ${basis === 'curated_list' ? 'curated' : 'heuristic'} evidence (${cats.map((c) => CATEGORY_LABEL[c]).join(' vs ')})`, ...notes].join('; ') };
    }
    return null;
  };
  return decide(curated, 'curated_list') ?? decide(heuristic, 'heuristic') ?? {
    category: 'unknown', label: CATEGORY_LABEL.unknown, basis: 'none', evidence,
    note: ['no provider category or curated evidence (meme and utility categories need provider category data, which the scanner does not fetch)', ...notes].join('; '),
  };
}

/** Informational thresholds for risk flags; heuristics, not calibrated statistics. */
export const RISK_FLAGS = { extremeRange24hPct: 30, dropFromHigh24hPct: 20, athDrawdownPct: 90 };

export interface CryptoRisk {
  /** Observation period and source of the measures below. */
  period: string;
  change24hPct: number | null;
  change7dPct: number | null;
  /** (high_24h - low_24h) / low_24h x 100, CALCULATED from provider 24h high/low. */
  range24hPct: number | null;
  /** (price - high_24h) / high_24h x 100: how far below the 24h high the current price is. */
  fromHigh24hPct: number | null;
  /** (price - low_24h) / low_24h x 100. */
  fromLow24hPct: number | null;
  /** Provider-reported % change from the all-time high, and its date. */
  athChangePct: number | null;
  athDate: string | null;
  /** 24h volume / market cap x 100 (liquidity relative to size). */
  turnoverPct: number | null;
  volumeReliability: VolumeReliability;
  dataAgeMinutes: number | null;
  /** Informational warnings (thresholds in RISK_FLAGS). */
  flags: string[];
  /** One code per flag, same order: extreme_range_24h, far_below_24h_high, far_below_ath, variable_volume_baseline. */
  flagCodes: string[];
  /** Measures that could not be calculated, and why. */
  unavailable: string[];
}

export function cryptoRisk(a: AssetSnapshot, now: Date, reliability?: VolumeReliability, rules: ScanRules = SCAN_RULES): CryptoRisk {
  const unavailable: string[] = ['bid/ask spread: not available (CoinGecko volume and prices are aggregated across exchanges)'];
  const flags: string[] = [];
  const flagCodes: string[] = [];
  const flag = (code: string, text: string) => { flagCodes.push(code); flags.push(text); };
  const price = has(a.price) ? a.price.value : null;
  const m = a.market;
  const hi = m && has(m.high24h) ? m.high24h.value : null;
  const lo = m && has(m.low24h) ? m.low24h.value : null;
  let range24hPct: number | null = null;
  let fromHigh24hPct: number | null = null;
  let fromLow24hPct: number | null = null;
  if (price === null || hi === null || lo === null) {
    unavailable.push('24h high-to-low range and drawdown from the 24h high: the source did not provide a usable 24h high and low');
  } else if (hi < lo || price > hi * 1.01 || price < lo * 0.99) {
    // Different snapshot times can make price, high and low disagree; do not compute from inconsistent data.
    unavailable.push(`24h range not used: the provider's price ${price} lies outside its own 24h low ${lo} to high ${hi} (or high < low)`);
  } else {
    range24hPct = (hi - lo) / lo * 100;
    fromHigh24hPct = (price - hi) / hi * 100;
    fromLow24hPct = (price - lo) / lo * 100;
    if (range24hPct >= RISK_FLAGS.extremeRange24hPct) flag('extreme_range_24h', `Extreme 24h swing: the price ranged ${range24hPct.toFixed(0)}% from its 24h low to its 24h high.`);
    if (fromHigh24hPct <= -RISK_FLAGS.dropFromHigh24hPct) flag('far_below_24h_high', `Now ${Math.abs(fromHigh24hPct).toFixed(0)}% below its 24h high: the 24h change alone hides this drop.`);
  }
  const ath = m && has(m.athChangePct) ? m.athChangePct.value : null;
  if (ath === null) unavailable.push('drawdown from the all-time high: not provided by the source');
  else if (ath <= -RISK_FLAGS.athDrawdownPct) flag('far_below_ath', `${Math.abs(ath).toFixed(0)}% below its all-time high (provider figure).`);
  const rel = reliability ?? volumeReliability(a.dailyVolumes, rules);
  if (!rel.insufficient && rel.highlyVariable) flag('variable_volume_baseline', `Highly variable volume baseline (Q3/Q1 ${rel.iqrRatio.toFixed(1)}x): volume multiples are less conclusive.`);
  if (rel.insufficient) unavailable.push(`volume-baseline variability: only ${rel.validDays} valid daily volumes`);
  const turnoverPct = has(a.volume24h) && has(a.marketCap) ? a.volume24h.value / a.marketCap.value * 100 : null;
  const updated = has(a.lastUpdated) ? Date.parse(a.lastUpdated.value) : NaN;
  return {
    period: 'CoinGecko rolling 24h window (24h change, high_24h, low_24h), 7-day change, and all-time high, as reported at the last update',
    change24hPct: has(a.change24hPct) ? a.change24hPct.value : null,
    change7dPct: has(a.change7dPct) ? a.change7dPct.value : null,
    range24hPct, fromHigh24hPct, fromLow24hPct,
    athChangePct: ath,
    athDate: m && has(m.athDate) ? m.athDate.value : null,
    turnoverPct,
    volumeReliability: rel,
    dataAgeMinutes: Number.isFinite(updated) ? Math.round((now.getTime() - updated) / 60_000) : null,
    flags,
    flagCodes,
    unavailable,
  };
}
