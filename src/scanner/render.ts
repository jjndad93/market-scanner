import { KIND_LABEL, has } from '../core/evidence.ts';
import { formatNy } from '../core/time.ts';
import { compactUsd } from './analyze.ts';
import { SCAN_RULES, type ScanRules } from './rules.ts';
import type { Candidate, ExclusionCode, ScanResult } from './types.ts';

const WIDTH = 100;

const EXCLUSION_LABEL: Record<ExclusionCode, string> = {
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
  stale_data: 'stale data',
};

function wrap(text: string, indent: string, first = indent): string[] {
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

/** Symbol, plus the id when the symbol is shared by several assets (ambiguous). */
const assetLabel = (c: Candidate, ambiguous: ReadonlySet<string>) =>
  ambiguous.has(c.asset.symbol) ? `${c.asset.symbol}, id ${c.asset.id}` : c.asset.symbol;

function why(c: Candidate): string {
  return c.breakdown.map((p) => `${p.rule} ${p.points}/${p.max} (${p.detail})`).join('; ');
}

function renderMover(c: Candidate, i: number, now: Date, ambiguous: ReadonlySet<string>): string[] {
  const a = c.asset;
  const week = has(a.change7dPct) ? `${signedPct(a.change7dPct.value)} 7d` : '7d n/a';
  const turnover = has(c.metrics.turnover) ? `; turnover ${(c.metrics.turnover.value * 100).toFixed(1)}% of ${compactUsd(a.marketCap.value!)} market cap` : '';
  return [
    `${String(i + 1).padStart(2)}. ${a.name} (${assetLabel(c, ambiguous)})  ${price(a.price.value!)}  ${signedPct(a.change24hPct.value!)} 24h / ${week}   Evidence ${c.score}/${c.maxScore}`,
    `    Volume ${compactUsd(a.volume24h.value!)} = ${c.metrics.relativeVolume.value!.toFixed(2)}x the ${a.dailyVolumes.length}-day median${turnover}`,
    ...wrap(`Why: ${why(c)}`, '      ', '    '),
    ...wrap(`Risks: ${c.risks.join(' ')}`, '      ', '    '),
    `    ${dataLine(c, now)}`,
  ];
}

function renderWatch(c: Candidate, i: number, now: Date, ambiguous: ReadonlySet<string>): string[] {
  const a = c.asset;
  return [
    `${String(i + 1).padStart(2)}. ${a.name} (${assetLabel(c, ambiguous)})  ${price(a.price.value!)}  ${signedPct(a.change24hPct.value!)} 24h   Evidence ${c.score}/${c.maxScore}`,
    `    Volume ${compactUsd(a.volume24h.value!)} = ${c.metrics.relativeVolume.value!.toFixed(2)}x median, no large move yet. A research lead, not a prediction.`,
    `    ${dataLine(c, now)}`,
  ];
}

const symbolList = (cs: Candidate[], ambiguous: ReadonlySet<string>) => cs.map((c) => `${assetLabel(c, ambiguous)} (${c.score}/${c.maxScore})`).join(', ');

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
  out.push(`Universe: ${r.universe} assets; ${r.passedFilters} passed filters; ${r.excluded.length} excluded.`);

  if (r.movers.length === 0 && r.watchlist.length === 0) {
    out.push('', 'No candidates met the evidence threshold.');
    if (r.belowThreshold.length > 0) out.push(...wrap(`Matched a pattern but scored below the threshold: ${symbolList(r.belowThreshold, ambiguous)}.`, '  ', '  '));
  } else {
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
      const label = ambiguous.has(e.symbol) || code.startsWith('duplicate') ? `${e.symbol} [id ${e.id}]` : e.symbol;
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
    for (const s of r.symbolCollisions) out.push(`  Symbol ${s.symbol} is shared by ids ${s.ids.join(', ')}; check which asset is meant.`);
    for (const n of notes) out.push(...wrap(n, '    ', '  '));
  }

  out.push(
    '',
    'Scores measure the strength of the observed evidence, not expected returns. No price targets.',
    'Catalysts are not verified in this stage. Aggregated volume can include inflated exchange reports.',
    'Research aid only; not financial advice.',
  );
  if (!isTest) out.push('VERIFIED DATA = fetched by this tool from the named source; not independently audited.');
  return out.join('\n');
}
