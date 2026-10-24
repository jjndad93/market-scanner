import { KIND_LABEL, has } from '../core/evidence.ts';
import { terminalSafe } from '../core/format.ts';
import { nextStepForStop, renderSummary, type ScanSummary, tally } from '../core/summary.ts';
import { formatNy } from '../core/time.ts';
import { compactUsd } from './analyze.ts';
import { SCAN_RULES, type ScanRules } from './rules.ts';
import type { Candidate, ExclusionCode, ScanResult } from './types.ts';

const WIDTH = 100;

export const EXCLUSION_LABEL: Record<ExclusionCode, string> = {
  invalid_record: 'invalid record',
  duplicate_record: 'duplicate record (counted once)',
  duplicate_conflict: 'conflicting duplicate ids',
  stablecoin: 'stablecoin',
  possible_stablecoin: 'possible stablecoin (heuristic)',
  wrapped_or_staked: 'wrapped/staked',
  missing_data: 'missing data',
  implausible_data: 'implausible data',
  below_market_cap: 'below market-cap minimum',
  below_volume: 'below volume minimum',
  insufficient_history: 'too little history',
  unreliable_history: 'unreliable volume history',
  history_not_requested: 'history not requested (request/rate limit)',
  history_request_failed: 'history request failed',
  stale_data: 'stale data',
};

export function wrap(text: string, indent: string, first = indent): string[] {
  const out: string[] = [];
  let line = first;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const start = out.length === 0 ? first : indent;
    if (line !== start && line.length + 1 + word.length > WIDTH) {
      out.push(line);
      line = indent + word;
    } else {
      line = line === start ? start + word : `${line} ${word}`;
    }
  }
  if (line.trim() !== '') out.push(line);
  return out;
}

const price = (p: number) => `$${p.toFixed(p >= 1 ? 2 : p >= 0.01 ? 4 : 8)}`;
const signedPct = (p: number) => `${p > 0 ? '+' : ''}${p.toFixed(1)}%`;

function dataLine(c: Candidate, now: Date): string {
  const at = c.asset.lastUpdated.value!;
  const age = Math.max(0, Math.round((now.getTime() - Date.parse(at)) / 60_000));
  // Synthetic data is labeled TEST DATA; live data VERIFIED DATA (fetched from the named source).
  const tag = KIND_LABEL[c.asset.price.kind];
  return `Catalyst: NOT VERIFIED | Data: ${formatNy(new Date(at))} (${age} min old) [${tag}]`;
}

/**
 * Symbol, plus the id when the symbol is shared by several assets (ambiguous). Ids, symbols and
 * names come from the data provider, so they are escaped here, at the output boundary only.
 */
const assetLabel = (c: Candidate, ambiguous: ReadonlySet<string>) =>
  ambiguous.has(c.asset.symbol) ? `${terminalSafe(c.asset.symbol)}, id ${terminalSafe(c.asset.id)}` : terminalSafe(c.asset.symbol);

function why(c: Candidate): string {
  return c.breakdown.map((p) => `${p.rule} ${p.points}/${p.max} (${p.detail})`).join('; ');
}

function renderMover(c: Candidate, i: number, now: Date, ambiguous: ReadonlySet<string>): string[] {
  const a = c.asset;
  const week = has(a.change7dPct) ? `${signedPct(a.change7dPct.value)} 7d` : '7d n/a';
  const turnover = has(c.metrics.turnover) ? `; turnover ${(c.metrics.turnover.value * 100).toFixed(1)}% of ${compactUsd(a.marketCap.value!)} market cap` : '';
  return [
    `${String(i + 1).padStart(2)}. ${terminalSafe(a.name)} (${assetLabel(c, ambiguous)})  ${price(a.price.value!)}  ${signedPct(a.change24hPct.value!)} 24h / ${week}   Evidence ${c.score}/${c.maxScore}`,
    `    Volume ${compactUsd(a.volume24h.value!)} = ${c.metrics.relativeVolume.value!.toFixed(2)}x the ${a.dailyVolumes.length}-day median${turnover}`,
    ...wrap(`Why: ${why(c)}`, '      ', '    '),
    ...wrap(`Risks: ${c.risks.join(' ')}`, '      ', '    '),
    ...baselineLine(c),
    `    ${dataLine(c, now)}`,
  ];
}

function renderWatch(c: Candidate, i: number, now: Date, ambiguous: ReadonlySet<string>): string[] {
  const a = c.asset;
  return [
    `${String(i + 1).padStart(2)}. ${terminalSafe(a.name)} (${assetLabel(c, ambiguous)})  ${price(a.price.value!)}  ${signedPct(a.change24hPct.value!)} 24h   Evidence ${c.score}/${c.maxScore}`,
    `    Volume ${compactUsd(a.volume24h.value!)} = ${c.metrics.relativeVolume.value!.toFixed(2)}x median, no large move yet. A research lead, not a prediction.`,
    ...baselineLine(c),
    `    ${dataLine(c, now)}`,
  ];
}

/**
 * Stage 11, informational only (not scored): shown when the volume baseline is highly variable,
 * or could not be measured. A stable baseline adds no line, so ordinary reports are unchanged.
 */
function baselineLine(c: Candidate): string[] {
  const r = c.volumeReliability;
  if (r.insufficient) return wrap(`Volume baseline: variability not measured (only ${r.validDays} valid daily volumes). Informational; not scored.`, '      ', '    ');
  if (!r.highlyVariable) return [];
  return wrap(`Volume baseline: HIGHLY VARIABLE - the middle half of its ${r.validDays} daily volumes spans a ${r.iqrRatio.toFixed(1)}x range (${compactUsd(r.q1)} to ${compactUsd(r.q3)}), so the ${c.metrics.relativeVolume.value!.toFixed(2)}x multiple is less conclusive. This does not by itself mean manipulation or bad data. Informational; not scored.`, '      ', '    ');
}

const symbolList = (cs: Candidate[], ambiguous: ReadonlySet<string>) => cs.map((c) => `${assetLabel(c, ambiguous)} (${c.score}/${c.maxScore})`).join(', ');

/** Stage 7 summary, built only from what the scan result holds. */
export function summarizeCryptoScan(r: ScanResult): ScanSummary {
  const live = r.dataset.kind === 'live';
  const cov = r.dataset.coverage;
  const qualified = r.movers.length + r.watchlist.length + r.moversOverLimit.length + r.watchlistOverLimit.length;
  const partialReasons: string[] = [];
  if (cov !== undefined && cov.historyNotRequested > 0) partialReasons.push(`${cov.historyNotRequested} eligible asset(s) not evaluated because ${cov.stopReason}`);
  if (cov !== undefined && cov.historyRequestFailed > 0) partialReasons.push(`${cov.historyRequestFailed} history request(s) failed`);
  return {
    scanType: 'crypto',
    scannedAt: r.evaluatedAt,
    mode: live ? 'live' : 'offline',
    data: live
      ? `live CoinGecko data${cov !== undefined && cov.historyFromCache > 0 ? `; ${cov.historyFromCache} volume history(ies) reused from this UTC day's local cache` : ''}`
      : 'synthetic fixture (TEST DATA), not market data',
    source: r.dataset.source,
    scope: live ? `${r.universe} crypto assets (CoinGecko top 500 by market cap)` : `${r.universe} crypto assets in the fixture`,
    status: partialReasons.length > 0 ? 'partial' : 'complete',
    partialReasons,
    counts: {
      universe: r.universe, passedFilters: r.passedFilters, excluded: r.excluded.length, qualified,
      belowThreshold: r.belowThreshold.length, noPattern: r.notCandidates,
      ...(cov !== undefined ? { historyEligible: cov.historyEligible, historyFetched: cov.historyFetched, historyFromCache: cov.historyFromCache, historyRequestFailed: cov.historyRequestFailed, historyNotRequested: cov.historyNotRequested } : {}),
    },
    qualified,
    qualifiedNames: [...r.movers, ...r.watchlist, ...r.moversOverLimit, ...r.watchlistOverLimit].map((c) => c.asset.symbol),
    freshness: cryptoFreshness(r),
    nextStep: partialReasons.length > 0 ? nextStepForStop(cov?.stopReason ?? null, 'COINGECKO_DEMO_API_KEY', 'CoinGecko')
      : live && r.passedFilters === 0 ? 'no asset passed every filter; see EXCLUDED above for the reasons.' : null,
    notQualified: [
      ...tally(r.excluded.map((e) => `excluded: ${EXCLUSION_LABEL[e.reasons[0]!.code]}`)),
      ...(r.belowThreshold.length > 0 ? [{ reason: 'matched a pattern but scored below the evidence threshold', count: r.belowThreshold.length }] : []),
      ...(r.notCandidates > 0 ? [{ reason: 'passed filters but matched no mover/watchlist pattern', count: r.notCandidates }] : []),
    ],
  };
}

/** Freshness from the scan's own timestamps and its stale-data rule; never claims real-time. */
function cryptoFreshness(r: ScanResult): string {
  const stale = r.excluded.filter((e) => e.reasons.some((x) => x.code === 'stale_data')).length;
  const staleNote = `${stale} asset(s) excluded as stale (data older than ${SCAN_RULES.maxDataAgeMinutes} min or future-dated)`;
  if (r.dataset.kind === 'synthetic') return `synthetic test data; its timestamps are invented (fixture snapshot ${formatNy(new Date(r.dataset.asOf))}). ${staleNote} by the same rule live data uses.`;
  const cached = r.dataset.coverage?.historyFromCache ?? 0;
  return `provider data fetched ${formatNy(new Date(r.dataset.asOf))}, as reported by the source (not verified as real-time). Every asset that passed the filters was updated within ${SCAN_RULES.maxDataAgeMinutes} min of the scan; ${staleNote}.${cached > 0 ? ` ${cached} volume history(ies) came from this UTC day's local cache (completed days only).` : ''}`;
}

export function renderScanReport(r: ScanResult, rules: ScanRules = SCAN_RULES): string {
  const now = new Date(r.evaluatedAt);
  const out: string[] = [];
  const isTest = r.dataset.kind === 'synthetic';
  const ambiguous: ReadonlySet<string> = new Set(r.symbolCollisions.map((s) => s.symbol));

  out.push(`CRYPTO MORNING SCAN - ${formatNy(now)}`);
  if (isTest) out.push(`!! TEST DATA - synthetic fixture "${r.dataset.label}". Invented coins and numbers; NOT market data. !!`);
  // Kept on its own unwrapped line so the source label is never split.
  out.push(`Source: ${r.dataset.source}${isTest ? ' [TEST DATA]' : ''}`);
  if (isTest) {
    out.push(`Snapshot: ${formatNy(new Date(r.dataset.asOf))}. No live data was fetched.`);
  } else {
    out.push(`Attribution: ${r.dataset.attribution}`);
    out.push(`Snapshot: ${formatNy(new Date(r.dataset.asOf))}. Live data fetched by this tool; values are as reported by the source.`);
  }
  // Live only: how much of the history-eligible universe was actually evaluated.
  const cov = r.dataset.coverage;
  const partial = cov !== undefined && !cov.complete;
  // Assets whose history was never obtained (distinct ids from the provider's coverage). Every record
  // of such an asset is excluded (with its history code, or as a duplicate), so this never exceeds
  // the excluded total, and the Universe line, coverage line and conclusion all use the same count.
  const unevaluated = cov !== undefined ? cov.historyRequestFailed + cov.historyNotRequested : 0;
  if (partial) {
    // Separate exclusions that are "not evaluated" (history never obtained) from real filter failures.
    out.push(...wrap(`Universe: ${r.universe} assets; ${r.passedFilters} passed all filters; ${r.excluded.length} excluded (${unevaluated} not evaluated: history not requested or failed).`, '  ', ''));
  } else {
    out.push(`Universe: ${r.universe} assets; ${r.passedFilters} passed filters; ${r.excluded.length} excluded.`);
  }
  if (cov !== undefined) {
    const status = partial
      ? `; ${cov.historyRequestFailed} failed; ${cov.historyNotRequested} not requested${cov.stopReason !== null ? ` (${cov.stopReason})` : ''}. PARTIAL SCAN.`
      : '. Complete.';
    const cached = cov.historyFromCache > 0 ? ` (${cov.historyFromCache} reused from this UTC day's local cache)` : '';
    out.push(...wrap(`History coverage: fetched for ${cov.historyFetched} of ${cov.historyEligible} assets that passed the non-history filters${cached}${status}`, '  ', ''));
  }
  const assetCount = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
  const wasWere = (n: number) => (n === 1 ? 'was' : 'were');

  if (r.movers.length === 0 && r.watchlist.length === 0) {
    if (partial) {
      out.push('', ...wrap(`No candidates met the evidence threshold among the ${assetCount(cov.historyFetched, 'asset')} whose history was fetched; ${assetCount(unevaluated, 'eligible asset')} ${wasWere(unevaluated)} not evaluated (failed or not requested), so this is not a market-wide result.`, '', ''));
    } else {
      out.push('', 'No candidates met the evidence threshold.');
    }
    if (r.belowThreshold.length > 0) out.push(...wrap(`Matched a pattern but scored below the threshold: ${symbolList(r.belowThreshold, ambiguous)}.`, '  ', '  '));
  } else {
    if (partial) out.push('', ...wrap(`PARTIAL SCAN: these results cover only the ${cov.historyFetched} of ${cov.historyEligible} eligible assets whose history was fetched; ${unevaluated} ${wasWere(unevaluated)} not evaluated.`, '', ''));
    out.push('', `MOVERS - large move on unusual volume (evidence strength, not a forecast): ${r.movers.length} of max ${rules.maxMovers}`);
    if (r.movers.length === 0) out.push('  None met the evidence threshold.');
    r.movers.forEach((c, i) => out.push(...renderMover(c, i, now, ambiguous)));
    if (r.moversOverLimit.length > 0) out.push(`  +${r.moversOverLimit.length} more met the threshold but exceed the display limit: ${symbolList(r.moversOverLimit, ambiguous)}.`);

    out.push('', `WATCHLIST - unusual volume, no large move yet: ${r.watchlist.length} of max ${rules.maxWatchlist}`);
    if (r.watchlist.length === 0) out.push('  None met the evidence threshold.');
    r.watchlist.forEach((c, i) => out.push(...renderWatch(c, i, now, ambiguous)));
    if (r.watchlistOverLimit.length > 0) out.push(`  +${r.watchlistOverLimit.length} more met the threshold but exceed the display limit: ${symbolList(r.watchlistOverLimit, ambiguous)}.`);

    if (r.belowThreshold.length > 0) out.push(...wrap(`Below evidence threshold (not shown): ${symbolList(r.belowThreshold, ambiguous)}.`, '  ', ''));
  }

  if (r.excluded.length > 0) {
    out.push('', `EXCLUDED (${r.excluded.length}; first reason shown, all reasons kept in the scan result)`);
    const groups = new Map<ExclusionCode, string[]>();
    for (const e of r.excluded) {
      const code = e.reasons[0]!.code;
      const label = ambiguous.has(e.symbol) || code.startsWith('duplicate') ? `${terminalSafe(e.symbol)} [id ${terminalSafe(e.id)}]` : terminalSafe(e.symbol);
      groups.set(code, [...(groups.get(code) ?? []), label]);
    }
    for (const [code, symbols] of groups) {
      const shown = symbols.slice(0, 6).join(', ');
      out.push(`  ${EXCLUSION_LABEL[code]}: ${shown}${symbols.length > 6 ? ` +${symbols.length - 6} more` : ''}`);
    }
  }

  const notes = r.dataset.notes ?? [];
  if (r.symbolCollisions.length > 0 || notes.length > 0) {
    out.push('', 'DATA NOTES');
    for (const s of r.symbolCollisions) out.push(`  Symbol ${terminalSafe(s.symbol)} is shared by ids ${s.ids.map(terminalSafe).join(', ')}; check which asset is meant.`);
    for (const n of notes) out.push(...wrap(n, '    ', '  '));
  }

  out.push(...renderSummary(summarizeCryptoScan(r), wrap));
  out.push(
    '',
    'Scores measure the strength of the observed evidence, not expected returns. No price targets.',
    'Catalysts are not verified in this stage. Aggregated volume can include inflated exchange reports.',
    'Research aid only; not financial advice.',
  );
  if (!isTest) out.push('VERIFIED DATA = fetched by this tool from the named source; not independently audited.');
  return out.join('\n');
}
