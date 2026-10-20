import { calculated, has, missing } from '../core/evidence.ts';
import type { NormalizedDataset } from './normalize.ts';
import {
  MOVER_MAX_SCORE,
  NOT_STABLECOIN_TAG,
  SCAN_RULES,
  SCORE_TABLE,
  type ScanRules,
  STABLECOIN_IDS,
  STABLECOIN_SYMBOLS,
  STABLECOIN_TAGS,
  WATCH_MAX_SCORE,
  WRAPPED_STAKED_NAME,
  WRAPPED_STAKED_SYMBOLS,
  WRAPPED_STAKED_TAGS,
} from './rules.ts';
import type { AssetMetrics, AssetSnapshot, Candidate, CandidateKind, Exclusion, ExclusionReason, ScanResult, ScorePart } from './types.ts';

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function compactUsd(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(abs >= 1e8 ? 0 : 1)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

export function computeMetrics(a: AssetSnapshot, now: Date): AssetMetrics {
  const asOf = a.lastUpdated.value;
  const base = median(a.dailyVolumes);
  const baselineVolume = base !== null
    ? calculated(base, `median of ${a.dailyVolumes.length} prior daily volumes`, asOf)
    : missing<number>('no prior daily volumes');
  const relativeVolume = has(a.volume24h) && base !== null && base > 0
    ? calculated(a.volume24h.value / base, '24h volume / median prior daily volume', asOf)
    : missing<number>('needs 24h volume and a volume baseline');
  const turnover = has(a.volume24h) && has(a.marketCap)
    ? calculated(a.volume24h.value / a.marketCap.value, '24h volume / market cap', asOf)
    : missing<number>('needs 24h volume and market cap');
  const dataAgeMinutes = asOf !== null ? (now.getTime() - Date.parse(asOf)) / 60_000 : null;
  return { baselineVolume, relativeVolume, turnover, dataAgeMinutes };
}

/** Every reason an asset is excluded (all that apply, not just the first). */
export function exclusionReasons(a: AssetSnapshot, m: AssetMetrics, rules: ScanRules = SCAN_RULES): ExclusionReason[] {
  const reasons: ExclusionReason[] = [];

  // Stablecoins: a known id, symbol or tag is definitive. The pegged-price pattern is only a
  // heuristic (price near $1 AND almost no movement), reported as "possible", and a
  // `not-stablecoin` tag overrides it. A missing 7-day change no longer disables the heuristic.
  // Tags are matched exactly (already normalized), so "non-stablecoin" or "not-stablecoin" never count.
  const knownStable = STABLECOIN_IDS.has(a.id) || STABLECOIN_SYMBOLS.has(a.symbol) || a.tags.some((t) => STABLECOIN_TAGS.has(t));
  const pegged = has(a.price) && has(a.change24hPct)
    && Math.abs(a.price.value - 1) <= rules.peggedPriceBand
    && Math.abs(a.change24hPct.value) <= rules.peggedMaxAbs24hPct
    && (!has(a.change7dPct) || Math.abs(a.change7dPct.value) <= rules.peggedMaxAbs7dPct);
  if (knownStable) {
    reasons.push({ code: 'stablecoin', detail: 'stablecoin (known id, symbol or tag)' });
  } else if (pegged && !a.tags.includes(NOT_STABLECOIN_TAG)) {
    reasons.push({
      code: 'possible_stablecoin',
      detail: `possible stablecoin (heuristic, not proof): price within ${(rules.peggedPriceBand * 100).toFixed(0)}% of $1 with almost no movement${has(a.change7dPct) ? '' : ' (7-day change missing)'}; tag "${NOT_STABLECOIN_TAG}" if it is not one`,
    });
  }
  if (WRAPPED_STAKED_SYMBOLS.has(a.symbol) || a.tags.some((t) => WRAPPED_STAKED_TAGS.has(t)) || WRAPPED_STAKED_NAME.test(a.name)) {
    reasons.push({ code: 'wrapped_or_staked', detail: 'wrapped, staked, liquid-staking or bridged version of another asset' });
  }

  const missingFields = [a.price, a.change24hPct, a.volume24h, a.marketCap, a.lastUpdated]
    .filter((e) => !has(e))
    .map((e) => e.note ?? 'value missing');
  if (missingFields.length > 0) reasons.push({ code: 'missing_data', detail: `missing evidence: ${missingFields.join('; ')}` });

  if (has(a.marketCap) && a.marketCap.value < rules.minMarketCap) {
    reasons.push({ code: 'below_market_cap', detail: `market cap ${compactUsd(a.marketCap.value)} is below the ${compactUsd(rules.minMarketCap)} minimum` });
  }
  if (has(a.volume24h) && a.volume24h.value < rules.minVolume24h) {
    reasons.push({ code: 'below_volume', detail: `24h volume ${compactUsd(a.volume24h.value)} is below the ${compactUsd(rules.minVolume24h)} minimum` });
  }
  // Volume history: every unusable entry is disclosed; none can inflate the baseline.
  const h = a.history;
  const unusable = h.zeroDays + h.invalidEntries;
  const historyNote = `${a.dailyVolumes.length} valid of ${h.windowDays} days used${h.supplied > h.windowDays ? ` (latest ${h.windowDays} of ${h.supplied} supplied)` : ''}; ${h.zeroDays} zero-volume, ${h.invalidEntries} invalid`;
  // Live runs mark assets whose history was never obtained, so they are not reported as having
  // too little history: they were not evaluated. Such an asset has no history data, so it is
  // excluded exactly as before; only the reason differs.
  if (a.historyStatus === 'not_requested') {
    reasons.push({ code: 'history_not_requested', detail: 'volume history was not requested in this run (request or rate limit reached); not evaluated' });
  } else if (a.historyStatus === 'request_failed') {
    reasons.push({ code: 'history_request_failed', detail: 'the volume history request failed or returned no usable volume data; not evaluated' });
  } else if (a.dailyVolumes.length < rules.minHistoryDays) {
    reasons.push({ code: 'insufficient_history', detail: `${historyNote}; ${rules.minHistoryDays} valid days needed for a baseline` });
  }
  if (unusable > rules.maxUnreliableHistoryDays) {
    reasons.push({ code: 'unreliable_history', detail: `${historyNote}; more than ${rules.maxUnreliableHistoryDays} unusable days makes the baseline unreliable` });
  } else if (a.dailyVolumes.length >= rules.minHistoryDays && has(m.baselineVolume) && m.baselineVolume.value < rules.minBaselineVolume) {
    reasons.push({ code: 'unreliable_history', detail: `median baseline ${compactUsd(m.baselineVolume.value)}/day is below the ${compactUsd(rules.minBaselineVolume)} minimum for a meaningful volume ratio` });
  }

  // Plausibility: values this extreme are treated as data errors and earn no points.
  if (has(a.change24hPct) && Math.abs(a.change24hPct.value) > rules.maxAbsChange24hPct) {
    reasons.push({ code: 'implausible_data', detail: `24h change of ${a.change24hPct.value}% exceeds the ${rules.maxAbsChange24hPct}% plausibility limit` });
  }
  if (has(a.change7dPct) && Math.abs(a.change7dPct.value) > rules.maxAbsChange7dPct) {
    reasons.push({ code: 'implausible_data', detail: `7-day change of ${a.change7dPct.value}% exceeds the ${rules.maxAbsChange7dPct}% plausibility limit` });
  }
  if (has(m.turnover) && m.turnover.value > rules.maxTurnover) {
    reasons.push({ code: 'implausible_data', detail: `24h volume is ${(m.turnover.value * 100).toFixed(0)}% of market cap, above the ${(rules.maxTurnover * 100).toFixed(0)}% plausibility limit` });
  }
  if (has(m.relativeVolume) && m.relativeVolume.value > rules.maxRelativeVolume) {
    reasons.push({ code: 'implausible_data', detail: `relative volume of ${m.relativeVolume.value.toFixed(0)}x exceeds the ${rules.maxRelativeVolume}x plausibility limit` });
  }
  if (m.dataAgeMinutes !== null && m.dataAgeMinutes > rules.maxDataAgeMinutes) {
    reasons.push({ code: 'stale_data', detail: `data is ${Math.round(m.dataAgeMinutes)} minutes old (limit ${rules.maxDataAgeMinutes})` });
  } else if (m.dataAgeMinutes !== null && m.dataAgeMinutes < -5) {
    reasons.push({ code: 'stale_data', detail: 'last-updated time is in the future; the timestamp is unreliable' });
  }
  return reasons;
}

/** Mover: large move on unusual volume. Watch: unusual volume without a large move. */
export function classify(a: AssetSnapshot, m: AssetMetrics, rules: ScanRules = SCAN_RULES): CandidateKind | null {
  if (!has(a.change24hPct) || !has(m.relativeVolume)) return null;
  const move = Math.abs(a.change24hPct.value);
  const rv = m.relativeVolume.value;
  if (move >= rules.moverMinAbsMovePct && rv >= rules.moverMinRelVolume) return 'mover';
  if (move < rules.watchMaxAbsMovePct && rv >= rules.watchMinRelVolume) return 'watch';
  return null;
}

const tablePoints = (value: number, table: readonly (readonly [number, number])[]): number =>
  table.find(([min]) => value >= min)?.[1] ?? 0;
const signed = (pct: number) => `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`;

export function scoreCandidate(a: AssetSnapshot, m: AssetMetrics, kind: CandidateKind): { score: number; maxScore: number; breakdown: ScorePart[] } {
  const rv = m.relativeVolume.value!;
  const vol = a.volume24h.value!;
  const move = a.change24hPct.value!;
  const skipped = a.history.zeroDays + a.history.invalidEntries;
  const skippedNote = skipped > 0 ? `; ${a.history.zeroDays} zero-volume days not used, ${a.history.invalidEntries} invalid` : '';
  const breakdown: ScorePart[] = [
    { rule: 'unusual volume', points: tablePoints(rv, SCORE_TABLE.relativeVolume), max: 3, detail: `${rv.toFixed(2)}x the ${a.dailyVolumes.length}-day median${skippedNote}` },
  ];
  if (kind === 'mover') {
    breakdown.push({ rule: 'size of move', points: tablePoints(Math.abs(move), SCORE_TABLE.moveAbsPct), max: 2, detail: `${signed(move)} in 24h` });
  }
  breakdown.push({ rule: 'liquidity', points: tablePoints(vol, SCORE_TABLE.volume24h), max: 2, detail: `${compactUsd(vol)} traded in 24h` });
  if (kind === 'mover') {
    const w = a.change7dPct;
    const agrees = has(w) && w.value !== 0 && Math.sign(w.value) === Math.sign(move);
    breakdown.push({
      rule: '7-day trend',
      points: agrees ? SCORE_TABLE.trendAgreement : 0,
      max: SCORE_TABLE.trendAgreement,
      detail: has(w) ? `${signed(w.value)} over 7 days ${agrees ? 'agrees with' : 'does not agree with'} the 24h move` : '7-day change missing; trend not assessed',
    });
  }
  return { score: breakdown.reduce((s, p) => s + p.points, 0), maxScore: kind === 'mover' ? MOVER_MAX_SCORE : WATCH_MAX_SCORE, breakdown };
}

export function riskNotes(a: AssetSnapshot, m: AssetMetrics, kind: CandidateKind, rules: ScanRules = SCAN_RULES): string[] {
  const risks: string[] = [];
  if (kind === 'watch') risks.push('Unusual volume without a price move has no known direction or cause.');
  else risks.push(a.change24hPct.value! >= 0 ? 'Sharp rises can reverse quickly.' : 'Declines can continue or rebound sharply.');
  if (a.volume24h.value! < rules.thinVolume24h) risks.push('Thin liquidity: spreads and slippage may be large.');
  if (m.relativeVolume.value! >= rules.extremeRelVolume) risks.push('Extreme volume spike: may be a one-off or a reporting artifact.');
  if (has(m.turnover) && m.turnover.value >= rules.highTurnover) risks.push('Very high turnover for its size: speculative churn is likely.');
  return risks;
}

/** Deterministic order: score, then relative volume, then 24h volume (all descending), then id. */
export function compareCandidates(x: Candidate, y: Candidate): number {
  return (y.score - x.score)
    || (y.metrics.relativeVolume.value! - x.metrics.relativeVolume.value!)
    || (y.asset.volume24h.value! - x.asset.volume24h.value!)
    || (x.asset.id < y.asset.id ? -1 : x.asset.id > y.asset.id ? 1 : 0);
}

/** Everything that describes an asset's data, for telling identical duplicates from conflicting ones. */
function fingerprint(a: AssetSnapshot): string {
  return JSON.stringify([a.symbol, a.name, [...a.tags].sort(), a.price.value, a.change24hPct.value, a.change7dPct.value,
    a.volume24h.value, a.marketCap.value, a.lastUpdated.value, a.dailyVolumes, a.history]);
}

/**
 * One record per id. Identical copies count once (the extras are recorded); copies that disagree
 * are all excluded, because there is no basis for choosing one. Either way the outcome does not
 * depend on input order.
 */
function dedupe(assets: AssetSnapshot[]): { unique: AssetSnapshot[]; excluded: Exclusion[] } {
  const byId = new Map<string, AssetSnapshot[]>();
  for (const a of assets) byId.set(a.id, [...(byId.get(a.id) ?? []), a]);
  const unique: AssetSnapshot[] = [];
  const excluded: Exclusion[] = [];
  for (const [id, copies] of byId) {
    if (copies.length === 1) {
      unique.push(copies[0]!);
    } else if (new Set(copies.map(fingerprint)).size === 1) {
      unique.push(copies[0]!);
      for (const extra of copies.slice(1)) {
        excluded.push({ id, symbol: extra.symbol, name: extra.name, reasons: [{ code: 'duplicate_record', detail: `identical duplicate of id "${id}" (${copies.length} copies); counted once` }] });
      }
    } else {
      for (const c of copies) {
        excluded.push({ id, symbol: c.symbol, name: c.name, reasons: [{ code: 'duplicate_conflict', detail: `${copies.length} records share id "${id}" with different data; none is used` }] });
      }
    }
  }
  return { unique, excluded };
}

const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
/**
 * Total order on exclusions: id, first reason code, symbol, name, then every reason in full.
 * Entries equal on all of these are indistinguishable, so their relative order cannot show.
 */
const byIdThenReason = (x: Exclusion, y: Exclusion) =>
  cmp(x.id, y.id) || cmp(x.reasons[0]!.code, y.reasons[0]!.code) || cmp(x.symbol, y.symbol) || cmp(x.name, y.name)
  || cmp(JSON.stringify(x.reasons), JSON.stringify(y.reasons));

export function runScan(data: NormalizedDataset, now: Date, rules: ScanRules = SCAN_RULES): ScanResult {
  // The history window is applied during normalization; refuse a silently different setting.
  if (rules.historyWindowDays !== data.historyWindowDays) {
    throw new Error(`Rules use a ${rules.historyWindowDays}-day history window but the data was normalized with ${data.historyWindowDays} days; pass the same rules to normalizeDataset.`);
  }
  const { unique, excluded: duplicates } = dedupe(data.assets);
  const excluded: Exclusion[] = [...data.invalid, ...duplicates];
  const movers: Candidate[] = [];
  const watch: Candidate[] = [];
  const belowThreshold: Candidate[] = [];
  let passedFilters = 0;
  let notCandidates = 0;

  // Distinct ids sharing a symbol are ambiguous: flag them so the report identifies them by id.
  const idsBySymbol = new Map<string, string[]>();
  for (const a of unique) idsBySymbol.set(a.symbol, [...(idsBySymbol.get(a.symbol) ?? []), a.id]);
  const symbolCollisions = [...idsBySymbol]
    .filter(([, ids]) => ids.length > 1)
    .map(([symbol, ids]) => ({ symbol, ids: [...ids].sort() }))
    .sort((x, y) => (x.symbol < y.symbol ? -1 : x.symbol > y.symbol ? 1 : 0));

  for (const a of unique) {
    const m = computeMetrics(a, now);
    const reasons = exclusionReasons(a, m, rules);
    if (reasons.length > 0) {
      excluded.push({ id: a.id, symbol: a.symbol, name: a.name, reasons });
      continue;
    }
    passedFilters++;
    const kind = classify(a, m, rules);
    if (kind === null) {
      notCandidates++;
      continue;
    }
    const scored = scoreCandidate(a, m, kind);
    const candidate: Candidate = {
      asset: a,
      metrics: m,
      kind,
      direction: a.change24hPct.value! >= 0 ? 'up' : 'down',
      ...scored,
      risks: riskNotes(a, m, kind, rules),
    };
    const threshold = kind === 'mover' ? rules.moverMinScore : rules.watchMinScore;
    if (candidate.score < threshold) belowThreshold.push(candidate);
    else (kind === 'mover' ? movers : watch).push(candidate);
  }

  movers.sort(compareCandidates);
  watch.sort(compareCandidates);
  belowThreshold.sort(compareCandidates);
  return {
    dataset: data.dataset,
    evaluatedAt: now.toISOString(),
    universe: data.assets.length + data.invalid.length,
    passedFilters,
    movers: movers.slice(0, rules.maxMovers),
    moversOverLimit: movers.slice(rules.maxMovers),
    watchlist: watch.slice(0, rules.maxWatchlist),
    watchlistOverLimit: watch.slice(rules.maxWatchlist),
    belowThreshold,
    notCandidates,
    excluded: excluded.sort(byIdThenReason),
    symbolCollisions,
  };
}
