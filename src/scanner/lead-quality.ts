/**
 * Research-lead explanations (Phase 1, crypto): one plain reason per lead and its warnings in a
 * fixed priority order. Built only from what the scan already produced: the lead's own fields
 * (DiscoveryEntry) and the existing volatility flags (insights.cryptoRisk on the same snapshot).
 * It never changes scores, tiers, rankings or thresholds, and never invents a value: a missing
 * value either drops a warning that needs it or is itself reported as missing.
 *
 * Priority: data quality first (a lead cannot be judged on bad or missing data), then volatility,
 * then weaker evidence. Within a group, the order of WARNING_CATALOG.
 *
 * It runs where the crypto JSON is produced (scan command; the dashboard uses the same output),
 * not inside runScan: insights.ts already imports analyze.ts, so calling it from runScan would
 * create a circular import. The text report never sees it, so CLI text output is unchanged.
 */

import { type CryptoRisk, cryptoRisk } from './insights.ts';
import type { NormalizedDataset } from './normalize.ts';
import type { AssetSnapshot, DiscoveryEntry, ScanResult } from './types.ts';

export type WarningGroup = 'data_quality' | 'volatility' | 'evidence';
export interface LeadWarning { code: string; group: WarningGroup; text: string }
export interface LeadExplanation {
  /** One plain sentence: why this lead appeared. */
  reason: string;
  /** Every warning that applies, highest priority first. */
  warnings: LeadWarning[];
  /** Shown only when there is no warning. */
  nextStep: string | null;
}
export type ExplainedEntry = DiscoveryEntry & { explanation: LeadExplanation };

export const GROUP_ORDER: readonly WarningGroup[] = ['data_quality', 'volatility', 'evidence'];
export const NEXT_STEP = 'Next step: check the news and a second data source before drawing any conclusion.';
export const UNKNOWN_WARNING_TEXT = 'See the scanner notes below for what limits this evidence.';

const pct = (n: number) => `${n > 0 ? '+' : ''}${n.toFixed(1)}%`;
const abs0 = (n: number) => Math.abs(n).toFixed(0);
type Ctx = { e: DiscoveryEntry; risk: CryptoRisk | null };

/**
 * Every warning code the scanner can attach to a lead: its caveat codes, its data-gap exclusion
 * codes, and cryptoRisk's flag codes. Insertion order is the priority order within each group.
 * Texts that quote a number return null when that number is unavailable (the warning is then dropped
 * rather than worded without its evidence; this cannot happen for a flag cryptoRisk raised).
 */
export const WARNING_CATALOG: Record<string, { group: WarningGroup; text: (c: Ctx) => string | null }> = {
  implausible_data: { group: 'data_quality', text: () => 'Some values look implausible, possibly a data error.' },
  stale_data: { group: 'data_quality', text: () => 'Its market data is out of date.' },
  missing_data: { group: 'data_quality', text: () => 'Some of its market data is missing.' },
  history_request_failed: { group: 'data_quality', text: () => 'Its trading history could not be loaded.' },
  history_not_requested: { group: 'data_quality', text: () => 'It was not checked against its usual trading level: the scan\'s request limit was reached.' },
  insufficient_history: { group: 'data_quality', text: () => 'It has too little trading history to judge.' },
  unreliable_history: { group: 'data_quality', text: () => 'Its trading history has too many gaps to judge.' },
  baseline_unmeasured: { group: 'data_quality', text: () => 'There is too little history to tell how steady its usual trading level is.' },
  baseline_variable: { group: 'data_quality', text: () => 'Its usual trading level swings a lot, so "unusually high" means less here.' },
  unusable_days: { group: 'data_quality', text: () => 'Some days of its trading history were missing and were left out.' },
  trend_missing: { group: 'data_quality', text: () => 'Its 7-day trend is not available.' },
  far_below_24h_high: { group: 'volatility', text: ({ risk }) => (risk?.fromHigh24hPct != null ? `It is now ${abs0(risk.fromHigh24hPct)}% below its 24-hour high; the 24-hour change alone hides this drop.` : null) },
  extreme_range_24h: { group: 'volatility', text: ({ risk }) => (risk?.range24hPct != null ? `The price swung ${abs0(risk.range24hPct)}% between its 24-hour low and high.` : null) },
  extreme_spike: { group: 'volatility', text: () => 'The trading spike is extreme; it may be a one-off or a data error.' },
  far_below_ath: { group: 'volatility', text: ({ risk }) => (risk?.athChangePct != null ? `It is ${abs0(risk.athChangePct)}% below its all-time high (provider figure).` : null) },
  one_signal: { group: 'evidence', text: () => 'Only trading activity stands out; the direction and cause are unknown.' },
  below_threshold: { group: 'evidence', text: () => 'The evidence is weaker than the scanner\'s threshold for a strong signal.' },
  no_volume_confirmation: { group: 'evidence', text: () => 'No unusual trading activity backs up the price move.' },
};
/** cryptoRisk's variable-baseline flag is the same fact as the scanner's baseline_variable caveat. */
export const ALIASES: Record<string, string> = { variable_volume_baseline: 'baseline_variable' };

function activityText(e: DiscoveryEntry): string {
  const parts: string[] = [];
  for (const s of e.activity) {
    if (s.code === 'large_24h_move' && e.change24hPct !== null) parts.push(`price moved ${pct(e.change24hPct)} in 24 hours`);
    if (s.code === 'large_7d_move' && e.change7dPct !== null) parts.push(`price moved ${pct(e.change7dPct)} over 7 days`);
    if (s.code === 'high_turnover') parts.push('heavy trading for its size');
  }
  return parts.join(', ');
}

/** One short sentence: why this lead appeared. Uses only the entry's own values. */
export function leadReason(e: DiscoveryEntry): string {
  const times = e.volumeMultiple !== null ? ` (about ${e.volumeMultiple.toFixed(1)}× its usual level)` : '';
  const move = e.change24hPct !== null ? `${pct(e.change24hPct)} in 24 hours` : null;
  if (e.tier === 'high_priority') return `The price moved ${move ?? 'sharply'} and trading activity is unusually high${times}.`;
  if (e.tier === 'insufficient_data') {
    const a = activityText(e);
    return `Unusual activity${a ? ` (${a})` : ''}, but not enough reliable data to judge.`;
  }
  if (e.kind === 'watch') return `Trading activity is unusually high${times}, but the price has barely moved.`;
  if (e.kind === 'mover') return `The price moved ${move ?? 'sharply'} with higher-than-usual trading activity${times}.`;
  const a = activityText(e);
  return `Price is moving${a ? ` (${a})` : ''}, but trading activity is normal.`;
}

/** Explains one lead. `risk` is cryptoRisk for the same snapshot, or null when unavailable. */
export function explainLead(e: DiscoveryEntry, risk: CryptoRisk | null): LeadExplanation {
  const codes = [...e.caveatCodes, ...(risk?.flagCodes ?? [])].map((c) => ALIASES[c] ?? c);
  const unique = [...new Set(codes)];
  const known = Object.keys(WARNING_CATALOG);
  const warnings: LeadWarning[] = [];
  for (const code of unique) {
    const entry = WARNING_CATALOG[code];
    if (!entry) {
      warnings.push({ code, group: 'evidence', text: UNKNOWN_WARNING_TEXT });
      continue;
    }
    const text = entry.text({ e, risk });
    if (text !== null) warnings.push({ code, group: entry.group, text });
  }
  const rank = (w: LeadWarning) => GROUP_ORDER.indexOf(w.group) * 1000 + (known.includes(w.code) ? known.indexOf(w.code) : 999);
  warnings.sort((x, y) => rank(x) - rank(y));
  return { reason: leadReason(e), warnings, nextStep: warnings.length === 0 ? NEXT_STEP : null };
}

/**
 * Adds an `explanation` to every research lead of a crypto scan result. Returns a new result; the
 * input, its order, tiers, scores and every other field are left exactly as they were.
 */
export function addLeadExplanations(result: ScanResult, data: NormalizedDataset): ScanResult & { discovery: ScanResult['discovery'] & { highPriority: ExplainedEntry[]; watchlist: ExplainedEntry[]; insufficientData: ExplainedEntry[] } } {
  const now = new Date(result.evaluatedAt);
  const byId = new Map<string, AssetSnapshot>();
  for (const a of data.assets) if (!byId.has(a.id)) byId.set(a.id, a);
  const explain = (list: DiscoveryEntry[]): ExplainedEntry[] => list.map((e) => {
    const a = byId.get(e.id);
    return { ...e, explanation: explainLead(e, a ? cryptoRisk(a, now) : null) };
  });
  const d = result.discovery;
  return { ...result, discovery: { ...d, highPriority: explain(d.highPriority), watchlist: explain(d.watchlist), insufficientData: explain(d.insufficientData) } };
}
