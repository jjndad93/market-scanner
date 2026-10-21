import { daysBetweenIsoDates, nyDateString } from '../core/time.ts';
import { compactUsd, median } from '../scanner/analyze.ts';
import type { NormalizedStockDataset } from './normalize.ts';
import { STOCK_MOVER_MAX_SCORE, STOCK_RULES, STOCK_SCORE_TABLE, STOCK_WATCH_MAX_SCORE, type StockRules } from './rules.ts';
import type { StockCandidate, StockCandidateKind, StockExclusion, StockMetrics, StockScanResult, StockSnapshot } from './types.ts';

const pct = (to: number, from: number) => (to / from - 1) * 100;
const signed = (p: number) => `${p > 0 ? '+' : ''}${p.toFixed(1)}%`;
const tablePoints = (value: number, table: readonly (readonly [number, number])[]) => table.find(([min]) => value >= min)?.[1] ?? 0;

/**
 * Metrics from the latest completed session and the baseline sessions before it, or null when
 * there are too few bars to compute them. The baseline uses positive-volume sessions only.
 */
export function stockMetrics(s: StockSnapshot, rules: StockRules = STOCK_RULES): StockMetrics | null {
  const bars = s.bars;
  if (bars.length < 2) return null;
  const last = bars[bars.length - 1]!;
  const prev = bars[bars.length - 2]!;
  const base = bars.slice(-(rules.baselineSessions + 1), -1).filter((b) => b.volume > 0);
  const baselineVolume = median(base.map((b) => b.volume));
  if (baselineVolume === null || baselineVolume <= 0) return null;
  const fiveBack = bars.length >= 6 ? bars[bars.length - 6]! : null;
  return {
    lastDate: last.date,
    close: last.close,
    change1dPct: pct(last.close, prev.close),
    change5dPct: fiveBack ? pct(last.close, fiveBack.close) : null,
    volume: last.volume,
    baselineVolume,
    baselineSessions: base.length,
    relativeVolume: last.volume / baselineVolume,
    dollarVolume: last.close * last.volume,
    medianDollarVolume: median(base.map((b) => b.close * b.volume))!,
  };
}

/** Every reason a stock is excluded (all that apply). */
export function stockExclusionReasons(s: StockSnapshot, m: StockMetrics | null, now: Date, rules: StockRules = STOCK_RULES): StockExclusion['reasons'] {
  if (s.historyStatus === 'not_requested') return [{ code: 'history_not_requested', detail: 'daily bars were not requested in this run (request or rate limit reached); not evaluated' }];
  if (s.historyStatus === 'request_failed') return [{ code: 'history_request_failed', detail: 'the daily-bars request failed or returned no usable data; not evaluated' }];
  const reasons: StockExclusion['reasons'] = [];
  const invalidNote = s.invalidBars > 0 ? `; ${s.invalidBars} malformed or conflicting bar(s) not used` : '';
  if (m === null || m.baselineSessions < rules.minBaselineSessions) {
    reasons.push({ code: 'insufficient_history', detail: `${m?.baselineSessions ?? 0} usable baseline session(s) of ${rules.minBaselineSessions} needed (${s.bars.length} bars)${invalidNote}` });
    return reasons;
  }
  const window = s.bars.slice(-(rules.baselineSessions + 1));
  const maxGap = Math.max(0, ...window.slice(1).map((b, i) => daysBetweenIsoDates(window[i]!.date, b.date)));
  if (maxGap > rules.maxGapDays) reasons.push({ code: 'history_gap', detail: `${maxGap} calendar days between consecutive bars (limit ${rules.maxGapDays}); sessions may be missing` });
  const age = daysBetweenIsoDates(m.lastDate, nyDateString(now));
  if (age > rules.maxSessionAgeDays) reasons.push({ code: 'stale_data', detail: `latest session ${m.lastDate} is ${age} days old (limit ${rules.maxSessionAgeDays})` });
  else if (age < 0) reasons.push({ code: 'stale_data', detail: `latest session ${m.lastDate} is after the scan date; the dates are unreliable` });
  if (m.close < rules.minPrice) reasons.push({ code: 'below_price', detail: `close $${m.close.toFixed(2)} is below the $${rules.minPrice} minimum` });
  if (m.medianDollarVolume < rules.minMedianDollarVolume) {
    reasons.push({ code: 'below_liquidity', detail: `median ${compactUsd(m.medianDollarVolume)}/session traded is below the ${compactUsd(rules.minMedianDollarVolume)} minimum` });
  }
  if (m.relativeVolume > rules.maxRelativeVolume) reasons.push({ code: 'implausible_data', detail: `relative volume of ${m.relativeVolume.toFixed(0)}x exceeds the ${rules.maxRelativeVolume}x plausibility limit` });
  return reasons;
}

/** Mover: large move on unusual volume. Watch: unusual volume without a large move. */
export function classifyStock(m: StockMetrics, rules: StockRules = STOCK_RULES): StockCandidateKind | null {
  const move = Math.abs(m.change1dPct);
  if (move >= rules.moverMinAbsMovePct && m.relativeVolume >= rules.moverMinRelVolume) return 'mover';
  if (move < rules.watchMaxAbsMovePct && m.relativeVolume >= rules.watchMinRelVolume) return 'watch';
  return null;
}

export function scoreStock(m: StockMetrics, kind: StockCandidateKind): Pick<StockCandidate, 'score' | 'maxScore' | 'breakdown'> {
  const breakdown: StockCandidate['breakdown'] = [
    { rule: 'unusual volume', points: tablePoints(m.relativeVolume, STOCK_SCORE_TABLE.relativeVolume), max: 3, detail: `${m.relativeVolume.toFixed(2)}x the ${m.baselineSessions}-session median` },
  ];
  if (kind === 'mover') breakdown.push({ rule: 'size of move', points: tablePoints(Math.abs(m.change1dPct), STOCK_SCORE_TABLE.moveAbsPct), max: 2, detail: `${signed(m.change1dPct)} in the latest session` });
  breakdown.push({ rule: 'liquidity', points: tablePoints(m.dollarVolume, STOCK_SCORE_TABLE.dollarVolume), max: 2, detail: `${compactUsd(m.dollarVolume)} traded in the latest session` });
  if (kind === 'mover') {
    const agrees = m.change5dPct !== null && m.change5dPct !== 0 && Math.sign(m.change5dPct) === Math.sign(m.change1dPct);
    breakdown.push({
      rule: '5-day trend', points: agrees ? STOCK_SCORE_TABLE.trendAgreement : 0, max: STOCK_SCORE_TABLE.trendAgreement,
      detail: m.change5dPct === null ? '5-day change unavailable; trend not assessed' : `${signed(m.change5dPct)} over 5 sessions ${agrees ? 'agrees with' : 'does not agree with'} the 1-day move`,
    });
  }
  return { score: breakdown.reduce((t, p) => t + p.points, 0), maxScore: kind === 'mover' ? STOCK_MOVER_MAX_SCORE : STOCK_WATCH_MAX_SCORE, breakdown };
}

function stockRisks(m: StockMetrics, kind: StockCandidateKind, rules: StockRules): string[] {
  const risks = [kind === 'watch' ? 'Unusual volume without a price move has no known direction or cause.' : m.change1dPct >= 0 ? 'Sharp rises can reverse quickly.' : 'Declines can continue or rebound sharply.'];
  if (m.relativeVolume >= rules.extremeRelVolume) risks.push('Extreme volume spike: may be a one-off event, index rebalance or reporting artifact.');
  risks.push('End-of-day data: the next session may open very differently.');
  return risks;
}

/** Deterministic order: score, relative volume, dollar volume (descending), then symbol. */
const byEvidence = (x: StockCandidate, y: StockCandidate) =>
  (y.score - x.score) || (y.metrics.relativeVolume - x.metrics.relativeVolume) || (y.metrics.dollarVolume - x.metrics.dollarVolume) || (x.stock.symbol < y.stock.symbol ? -1 : 1);

export function runStockScan(data: NormalizedStockDataset, now: Date, rules: StockRules = STOCK_RULES): StockScanResult {
  const excluded: StockExclusion[] = [...data.invalid];
  const counts = new Map<string, number>();
  for (const s of data.stocks) counts.set(s.symbol, (counts.get(s.symbol) ?? 0) + 1);
  const movers: StockCandidate[] = [];
  const watch: StockCandidate[] = [];
  const belowThreshold: StockCandidate[] = [];
  let passedFilters = 0;
  let notCandidates = 0;
  const notEvaluated = { requestFailed: 0, notRequested: 0 };

  for (const s of data.stocks) {
    if (counts.get(s.symbol)! > 1) {
      excluded.push({ symbol: s.symbol, reasons: [{ code: 'duplicate_symbol', detail: `${counts.get(s.symbol)} records share symbol ${s.symbol}; none is used` }] });
      continue;
    }
    if (s.historyStatus === 'request_failed') notEvaluated.requestFailed++;
    if (s.historyStatus === 'not_requested') notEvaluated.notRequested++;
    const m = s.historyStatus === undefined ? stockMetrics(s, rules) : null;
    const reasons = stockExclusionReasons(s, m, now, rules);
    if (reasons.length > 0 || m === null) {
      excluded.push({ symbol: s.symbol, reasons });
      continue;
    }
    passedFilters++;
    const kind = classifyStock(m, rules);
    if (kind === null) {
      notCandidates++;
      continue;
    }
    const c: StockCandidate = { stock: s, metrics: m, kind, ...scoreStock(m, kind), risks: stockRisks(m, kind, rules) };
    if (c.score < (kind === 'mover' ? rules.moverMinScore : rules.watchMinScore)) belowThreshold.push(c);
    else (kind === 'mover' ? movers : watch).push(c);
  }
  for (const list of [movers, watch, belowThreshold]) list.sort(byEvidence);
  return {
    dataset: data.dataset,
    evaluatedAt: now.toISOString(),
    universe: data.stocks.length + data.invalid.length,
    passedFilters,
    movers: movers.slice(0, rules.maxMovers),
    watchlist: watch.slice(0, rules.maxWatchlist),
    overLimit: [...movers.slice(rules.maxMovers), ...watch.slice(rules.maxWatchlist)],
    belowThreshold,
    notCandidates,
    excluded: excluded.sort((x, y) => (x.symbol < y.symbol ? -1 : x.symbol > y.symbol ? 1 : 0)),
    invalidBars: data.stocks.filter((s) => s.invalidBars > 0).map((s) => ({ symbol: s.symbol, count: s.invalidBars })).sort((x, y) => (x.symbol < y.symbol ? -1 : 1)),
    notEvaluated,
  };
}
