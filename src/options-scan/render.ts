import { money, terminalSafe } from '../core/format.ts';
import { nextStepForStop, renderSummary, type ScanSummary } from '../core/summary.ts';
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

/** Stage 7 summary, built only from what the scan result holds. */
export function summarizeOptionScan(r: OptionScanResult): ScanSummary {
  const live = r.dataset.kind === 'live';
  const u = r.underlyings;
  const total = u.scanned + u.failed.length + u.notRequested.length;
  const partialReasons: string[] = [];
  if (u.notRequested.length > 0) partialReasons.push(`${u.notRequested.length} underlying(s) not requested (${u.notRequested.slice(0, 5).join(', ')}${u.notRequested.length > 5 ? ', ...' : ''})`);
  if (u.failed.length > 0) partialReasons.push(`${u.failed.length} underlying(s) failed or returned unusable data (${u.failed.slice(0, 5).join(', ')}${u.failed.length > 5 ? ', ...' : ''})`);
  if (u.truncated.length > 0) partialReasons.push(`only the first page of contracts was used for ${u.truncated.join(', ')}`);
  const c = r.counts;
  return {
    scanType: 'options',
    scannedAt: r.evaluatedAt,
    mode: live ? 'live' : 'offline',
    data: live ? 'live Massive option-chain snapshot' : 'synthetic fixture (TEST DATA), not market data',
    source: r.dataset.source,
    scope: `${total} underlying(s), ${u.scanned} scanned; ${c.retrieved} contract(s) retrieved`,
    status: partialReasons.length > 0 ? 'partial' : 'complete',
    partialReasons,
    counts: {
      underlyings: total, underlyingsScanned: u.scanned, underlyingsFailed: u.failed.length, underlyingsNotRequested: u.notRequested.length,
      retrieved: c.retrieved, excluded: c.excluded, eligible: c.eligible, evaluated: c.evaluated, ranked: c.ranked, insufficient: c.insufficient, putsNotEvaluated: c.putsNotEvaluated,
    },
    qualified: c.ranked,
    qualifiedNames: r.ranked.map((x) => x.contract.ticker),
    freshness: optionFreshness(r),
    nextStep: optionNextStep(r),
    notQualified: [
      ...r.exclusions.map((e) => ({ reason: `excluded: ${EXCLUSION_LABEL[e.code]}`, count: e.count })),
      ...(c.insufficient > 0 ? [{ reason: 'evaluated but insufficient data (not ranked)', count: c.insufficient }] : []),
      ...(c.putsNotEvaluated > 0 ? [{ reason: 'eligible puts not evaluated (calls only)', count: c.putsNotEvaluated }] : []),
    ],
  };
}

/** Live runs only (a fixture's gaps are part of the test data): the next step after a partial or empty scan. */
function optionNextStep(r: OptionScanResult): string | null {
  if (r.dataset.kind !== 'live') return null;
  const notes = r.dataset.notes ?? [];
  const u = r.underlyings;
  if (u.failed.length + u.notRequested.length > 0) {
    // The provider records why it stopped in its own DATA NOTES ("... because <reason>." or the HTTP 401/403 text).
    const stop = /because (.+)\.$/.exec(notes.find((n) => n.startsWith('Option chains not requested')) ?? '')?.[1] ?? notes.find((n) => /HTTP 40[13]\)/.test(n)) ?? null;
    return nextStepForStop(stop, 'POLYGON_API_KEY', 'Massive');
  }
  if (r.counts.retrieved === 0) return 'the provider returned no contracts; check --symbols and your plan.';
  if (u.truncated.length > 0) return 'only the first page of contracts was used for some underlyings; narrow --symbols to fewer underlyings if you need more of each chain (no pagination yet).';
  return null;
}

/** Freshness from the ranked contracts' own quote times and the stale-quote rule; never claims real-time. */
function optionFreshness(r: OptionScanResult): string {
  const stale = r.exclusions.find((e) => e.code === 'stale_quote')?.count ?? 0;
  const times = r.ranked.map((x) => x.contract.quoteTime).filter((t): t is string => t !== null).sort();
  const range = times.length === 0 ? 'no ranked contract, so no quote time to report'
    : `ranked quotes timed ${formatNy(new Date(times[0]!))}${times.length > 1 && times[times.length - 1] !== times[0] ? ` to ${formatNy(new Date(times[times.length - 1]!))}` : ''}`;
  const staleNote = `${stale} contract(s) excluded for a stale, undated or future-dated quote (more than ${OPTION_SCAN_RULES.maxQuoteAgeDays} days old)`;
  return r.dataset.kind === 'synthetic'
    ? `synthetic test data; its timestamps are invented; ${range}; ${staleNote}.`
    : `provider snapshot fetched ${formatNy(new Date(r.dataset.asOf))}; ${range} (end-of-day or delayed depending on the plan; not verified as real-time); ${staleNote}.`;
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
  if (r.ranked.length > 0) out.push(...wrap(`Values: bid, ask, last, volume and open interest are provider-supplied [${tag}]; provider IV and delta are the provider's own model figures [${isTest ? 'TEST DATA' : 'THIRD-PARTY'}]; mid, spread and the verdict are CALCULATED. "Why" lists the evaluator's reasons.`, '  ', '  '));
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
    for (const e of r.exclusions) {
      out.push(`  ${EXCLUSION_LABEL[e.code]}: ${e.count}`);
      e.examples.forEach((x, i) => out.push(...wrap(`${terminalSafe(x)}: ${e.details[i] ?? ''}`, '        ', '      ')));
    }
  }
  const rules = OPTION_SCAN_RULES;
  const notes = [
    ...(r.dataset.notes ?? []),
    ...((r.underlyings.empty ?? []).length > 0 ? [`The provider returned no contracts for ${r.underlyings.empty!.map(terminalSafe).join(', ')} in the requested expiration window: check the symbol (it may be unknown or have no listed options).`] : []),
    ...(r.underlyings.truncated.length > 0 ? [`The provider returned more than one page of contracts for ${r.underlyings.truncated.map(terminalSafe).join(', ')}; only the first page was used (no pagination yet).`] : []),
    `Filters: expiration ${rules.minDaysToExpiration}+ days away; valid, uncrossed bid/ask quoted within ${rules.maxQuoteAgeDays} days; spread at most ${rules.maxSpreadOfMid * 100}% of mid; open interest at least ${rules.minOpenInterest} when supplied. Spread, open interest and expiration limits are the evaluator's own thresholds.`,
    'Evaluation uses the existing option evaluator with no pasted context: historical volatility, earnings and dividend dates are missing, which the evaluator reports and which keeps verdicts cautious.',
    'Provider IV and Greeks are THIRD-PARTY figures shown for reference; the evaluator calculates its own.',
  ];
  out.push('', 'DATA NOTES');
  for (const n of notes) out.push(...wrap(n, '    ', '  '));
  out.push(...renderSummary(summarizeOptionScan(r), wrap));
  out.push(
    '',
    'Verdicts measure evidence from the evaluator\'s rules, not expected returns.',
    'No contract is safe or certain to profit.',
    'Research aid only; not financial advice.',
  );
  if (!isTest) out.push('VERIFIED DATA = fetched by this tool from the named source; not independently audited.');
  return out.join('\n');
}
