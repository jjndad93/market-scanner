import { money, terminalSafe } from '../core/format.ts';
import { formatNy } from '../core/time.ts';
import { wrap } from '../scanner/render.ts';
import { OPTION_SCAN_RULES, type OptionExclusionCode, type OptionScanResult, type RankedCandidate } from './scan.ts';

const EXCLUSION_LABEL: Record<OptionExclusionCode, string> = {
  incomplete: 'incomplete record',
  expired: 'expired',
  too_short: 'too close to expiration',
  missing_quote: 'missing bid/ask',
  crossed_market: 'crossed market (bid above ask)',
  no_offer: 'no offer (ask 0)',
  wide_spread: 'spread too wide',
  stale_quote: 'stale or undated quote',
  low_open_interest: 'open interest too low',
};
const VERDICT_LABEL: Record<string, string> = {
  RELATIVELY_STRONG: 'RELATIVELY STRONG', MIXED: 'MIXED', WEAK: 'WEAK', TOO_RISKY: 'TOO RISKY', INSUFFICIENT_DATA: 'INSUFFICIENT DATA',
};
const opt = (v: number | null, f: (n: number) => string) => (v === null ? 'n/a' : f(v));

function renderCandidate(c: RankedCandidate, tag: string): string[] {
  const k = c.contract;
  const mid = k.bid !== null && k.ask !== null ? (k.bid + k.ask) / 2 : null;
  return [
    `${String(c.rank).padStart(2)}. ${terminalSafe(k.ticker)}  ${terminalSafe(k.underlying)} ${money(k.strike)} ${k.type.toUpperCase()} exp ${k.expiration} (${k.daysToExpiration}d)   ${VERDICT_LABEL[c.verdict]}`,
    `    Underlying ${money(k.underlyingPrice)} | bid ${opt(k.bid, money)} / ask ${opt(k.ask, money)} (mid ${opt(mid, money)}, spread ${opt(k.spreadOfMid, (s) => `${(s * 100).toFixed(1)}%`)}) | last ${opt(k.last, money)}`,
    `    Volume ${opt(k.volume, (v) => v.toLocaleString('en-US'))} | open interest ${opt(k.openInterest, (v) => v.toLocaleString('en-US'))} | provider IV ${opt(k.iv, (v) => `${(v * 100).toFixed(1)}%`)} | provider delta ${opt(k.delta, (v) => v.toFixed(2))}`,
    ...wrap(`Why: ${c.reasons.length > 0 ? c.reasons.slice(0, 4).join('; ') : c.verdictSummary}`, '      ', '    '),
    ...wrap(`Data reliability: ${c.dataReliability.level === 'normal' ? 'no issues found in the checks run' : `REDUCED (${c.dataReliability.reasons.slice(0, 2).join('; ')})`}`, '      ', '    '),
    `    Quote: ${k.quoteTime !== null ? formatNy(new Date(k.quoteTime)) : 'n/a'} [${tag}]`,
  ];
}

export function renderOptionScanReport(r: OptionScanResult): string {
  const out: string[] = [];
  const isTest = r.dataset.kind === 'synthetic';
  const tag = isTest ? 'TEST DATA' : 'VERIFIED DATA';
  out.push(`US OPTIONS DISCOVERY - ${formatNy(new Date(r.evaluatedAt))}`);
  if (isTest) out.push(`!! TEST DATA - synthetic fixture "${r.dataset.label}": invented contracts, NOT market data !!`);
  out.push(`Source: ${r.dataset.source}${isTest ? ' [TEST DATA]' : ''}`);
  if (!isTest && r.dataset.attribution) out.push(`Attribution: ${r.dataset.attribution}`);
  out.push(`Snapshot: ${formatNy(new Date(r.dataset.asOf))}. ${isTest ? 'No live data was fetched.' : 'Option chains fetched by this tool; values are as reported by the source.'}`);
  const c = r.counts;
  const partial = r.underlyings.failed.length + r.underlyings.notRequested.length > 0;
  out.push(...wrap(`Underlyings: ${r.underlyings.scanned} scanned${partial ? `; ${r.underlyings.failed.length} failed, ${r.underlyings.notRequested.length} not requested. PARTIAL SCAN` : ''}.`, '  ', ''));
  out.push(...wrap(`Contracts: ${c.retrieved} retrieved; ${c.excluded} excluded; ${c.eligible} eligible (${c.putsNotEvaluated} puts not evaluated); ${c.evaluated} evaluated; ${c.ranked} ranked; ${c.insufficient} with insufficient data.`, '  ', ''));

  out.push('', ...wrap(`RANKED CALLS (${r.ranked.length} shown) - ordered by evaluator verdict, then data reliability, tighter spread, higher open interest. A rule-based order, not a profit forecast.`, '  ', ''));
  if (r.ranked.length === 0) out.push(partial ? '  No contract could be ranked among the underlyings that were scanned.' : '  No contract could be ranked.');
  r.ranked.forEach((cand) => out.push(...renderCandidate(cand, tag)));
  if (r.moreRanked > 0) out.push(`  +${r.moreRanked} more ranked contract(s) beyond the display limit (see --json).`);

  if (r.insufficient.length > 0) {
    out.push('', `NOT RANKED - insufficient data for the evaluator (${r.insufficient.length})`);
    // First sentence of each reason; the full text is in --json.
    const firstSentence = (s: string) => s.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? s;
    for (const i of r.insufficient.slice(0, 5)) out.push(...wrap(`${terminalSafe(i.ticker)}: ${i.reasons.slice(0, 2).map(firstSentence).join(' ')}`, '      ', '  '));
  }
  if (r.putsNotEvaluated.length > 0) {
    out.push('', `ELIGIBLE PUTS - not evaluated: the option evaluator handles calls only (${r.putsNotEvaluated.length})`);
    out.push(...wrap(r.putsNotEvaluated.slice(0, 8).map(terminalSafe).join(', ') + (r.putsNotEvaluated.length > 8 ? ` +${r.putsNotEvaluated.length - 8} more` : ''), '  ', '  '));
  }
  if (r.exclusions.length > 0) {
    out.push('', `EXCLUDED CONTRACTS (${c.excluded}; first reason shown)`);
    for (const e of r.exclusions) out.push(`  ${EXCLUSION_LABEL[e.code]}: ${e.count} (e.g. ${e.examples.map(terminalSafe).join(', ')})`);
  }
  const rules = OPTION_SCAN_RULES;
  const notes = [
    ...(r.dataset.notes ?? []),
    ...(r.underlyings.truncated.length > 0 ? [`The provider returned more than one page of contracts for ${r.underlyings.truncated.map(terminalSafe).join(', ')}; only the first page was used (no pagination yet).`] : []),
    `Filters: expiration ${rules.minDaysToExpiration}+ days away; valid, uncrossed bid/ask quoted within ${rules.maxQuoteAgeDays} days; spread at most ${rules.maxSpreadOfMid * 100}% of mid; open interest at least ${rules.minOpenInterest} when supplied. Spread, open interest and expiration limits are the evaluator's own thresholds.`,
    'Evaluation uses the existing option evaluator with no pasted context: historical volatility, earnings and dividend dates are missing, which the evaluator reports and which keeps verdicts cautious.',
    'Provider IV and Greeks are THIRD-PARTY figures shown for reference; the evaluator calculates its own.',
  ];
  out.push('', 'DATA NOTES');
  for (const n of notes) out.push(...wrap(n, '    ', '  '));
  out.push(
    '',
    'Verdicts measure evidence from the evaluator\'s rules, not expected returns.',
    'No contract is safe or certain to profit.',
    'Research aid only; not financial advice.',
  );
  if (!isTest) out.push('VERIFIED DATA = fetched by this tool from the named source; not independently audited.');
  return out.join('\n');
}
