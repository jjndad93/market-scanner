import { KIND_LABEL } from '../core/evidence.ts';
import { terminalSafe } from '../core/format.ts';
import { formatNy } from '../core/time.ts';
import { compactUsd } from '../scanner/analyze.ts';
import { wrap } from '../scanner/render.ts';
import { STOCK_RULES, type StockRules } from './rules.ts';
import type { StockCandidate, StockExclusionCode, StockScanResult } from './types.ts';

const EXCLUSION_LABEL: Record<StockExclusionCode, string> = {
  invalid_record: 'invalid record',
  duplicate_symbol: 'duplicate symbol',
  history_not_requested: 'bars not requested (request/rate limit)',
  history_request_failed: 'bars request failed',
  insufficient_history: 'too little history',
  history_gap: 'gap in daily bars',
  stale_data: 'stale data',
  below_price: 'below price minimum',
  below_liquidity: 'below liquidity minimum',
  implausible_data: 'implausible data',
};

const signedPct = (p: number) => `${p > 0 ? '+' : ''}${p.toFixed(1)}%`;
const shares = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : `${n}`);
const label = (c: StockCandidate) => (c.stock.name === c.stock.symbol ? terminalSafe(c.stock.symbol) : `${terminalSafe(c.stock.name)} (${terminalSafe(c.stock.symbol)})`);
const dataLine = (c: StockCandidate) => `Catalyst: NOT VERIFIED | Data: session ${c.metrics.lastDate}, end of day [${KIND_LABEL[c.stock.dataKind]}]`;

function renderCandidate(c: StockCandidate, i: number): string[] {
  const m = c.metrics;
  const week = m.change5dPct !== null ? `${signedPct(m.change5dPct)} 5d` : '5d n/a';
  const lines = [
    `${String(i + 1).padStart(2)}. ${label(c)}  $${m.close.toFixed(2)}  ${signedPct(m.change1dPct)} 1d / ${week}   Evidence ${c.score}/${c.maxScore}`,
    `    Volume ${shares(m.volume)} shares = ${m.relativeVolume.toFixed(2)}x the ${m.baselineSessions}-session median; ${compactUsd(m.dollarVolume)} traded`,
    ...wrap(`Why: ${c.breakdown.map((p) => `${p.rule} ${p.points}/${p.max} (${p.detail})`).join('; ')}`, '      ', '    '),
    ...wrap(`Risks: ${c.risks.join(' ')}`, '      ', '    '),
    `    ${dataLine(c)}`,
  ];
  return lines;
}

const listOf = (cs: StockCandidate[]) => cs.map((c) => `${terminalSafe(c.stock.symbol)} (${c.score}/${c.maxScore})`).join(', ');

export function renderStockReport(r: StockScanResult, rules: StockRules = STOCK_RULES): string {
  const out: string[] = [];
  const isTest = r.dataset.kind === 'synthetic';
  out.push(`US STOCK SCAN - ${formatNy(new Date(r.evaluatedAt))}`);
  if (isTest) out.push(`!! TEST DATA - synthetic fixture "${r.dataset.label}": invented tickers, NOT market data !!`);
  out.push(`Source: ${r.dataset.source}${isTest ? ' [TEST DATA]' : ''}`);
  if (!isTest && r.dataset.attribution) out.push(`Attribution: ${r.dataset.attribution}`);
  out.push(isTest
    ? `Snapshot: ${formatNy(new Date(r.dataset.asOf))}. No live data was fetched.`
    : `Snapshot: ${formatNy(new Date(r.dataset.asOf))}. End-of-day bars fetched by this tool; the latest bar is the last completed session.`);
  const notEvaluated = r.notEvaluated.requestFailed + r.notEvaluated.notRequested;
  const partial = notEvaluated > 0;
  out.push(...wrap(partial
    ? `Universe: ${r.universe} tickers; ${r.passedFilters} passed all filters; ${r.excluded.length} excluded (${notEvaluated} not evaluated: bars not requested or failed). PARTIAL SCAN.`
    : `Universe: ${r.universe} tickers; ${r.passedFilters} passed filters; ${r.excluded.length} excluded.`, '  ', ''));

  if (r.movers.length === 0 && r.watchlist.length === 0) {
    out.push('', partial
      ? `No candidates met the evidence threshold among the evaluated tickers; ${notEvaluated} ticker(s) were not evaluated.`
      : 'No candidates met the evidence threshold.');
  } else {
    if (partial) out.push('', `PARTIAL SCAN: ${notEvaluated} ticker(s) were not evaluated.`);
    out.push('', `MOVERS - large move on unusual volume (evidence strength, not a forecast): ${r.movers.length} of max ${rules.maxMovers}`);
    if (r.movers.length === 0) out.push('  None met the evidence threshold.');
    r.movers.forEach((c, i) => out.push(...renderCandidate(c, i)));
    out.push('', `WATCHLIST - unusual volume, no large move yet: ${r.watchlist.length} of max ${rules.maxWatchlist}`);
    if (r.watchlist.length === 0) out.push('  None met the evidence threshold.');
    r.watchlist.forEach((c, i) => out.push(...renderCandidate(c, i)));
  }
  if (r.overLimit.length > 0) out.push(...wrap(`Met the threshold but beyond the display limit: ${listOf(r.overLimit)}.`, '  ', '  '));
  if (r.belowThreshold.length > 0) out.push(...wrap(`Matched a pattern but scored below the threshold: ${listOf(r.belowThreshold)}.`, '  ', '  '));

  if (r.excluded.length > 0) {
    out.push('', `EXCLUDED (${r.excluded.length}; first reason shown, all reasons kept in the scan result)`);
    const groups = new Map<StockExclusionCode, string[]>();
    for (const e of r.excluded) groups.set(e.reasons[0]!.code, [...(groups.get(e.reasons[0]!.code) ?? []), terminalSafe(e.symbol)]);
    for (const [code, symbols] of groups) out.push(`  ${EXCLUSION_LABEL[code]}: ${symbols.slice(0, 8).join(', ')}${symbols.length > 8 ? ` +${symbols.length - 8} more` : ''}`);
  }
  const notes = [
    ...(r.dataset.notes ?? []),
    ...r.invalidBars.map((b) => `${terminalSafe(b.symbol)}: ${b.count} malformed or conflicting bar(s) counted and not used.`),
  ];
  if (notes.length > 0) {
    out.push('', 'DATA NOTES');
    for (const n of notes) out.push(...wrap(n, '    ', '  '));
  }
  out.push(
    '',
    'Scores measure the strength of the observed evidence, not expected returns. No price targets.',
    'Catalysts are not verified in this stage. End-of-day data only: no intraday or pre-market moves.',
    'Research aid only; not financial advice.',
  );
  if (!isTest) out.push('VERIFIED DATA = fetched by this tool from the named source; not independently audited.');
  return out.join('\n');
}
