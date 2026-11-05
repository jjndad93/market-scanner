/**
 * One compact summary per dashboard row: why it is listed, how good the evidence is, the key risk,
 * and the next step. Built only from values the scan already has; no request, no new scoring.
 *
 * The research dimensions are kept SEPARATE and never blended into one number:
 * - market confirmation: the scanner's own signal (category, score, volume multiple), unchanged;
 * - evidence quality: whether the data behind that signal is complete and real (this module);
 * - catalyst: only from the news panel, after the user opens it (not here);
 * - attention: only from the optional CoinGecko trending check (not here).
 * Nothing here claims buying, sentiment or social coverage.
 */

import type { LeadExplanation } from '../scanner/lead-quality.ts';
import type { DashboardRow } from './rows.ts';

export type EvidenceLevel = 'test_data' | 'limited' | 'single_source';
export interface RowBrief {
  /** Why it is listed, or null for assets that matched no pattern. */
  reason: string | null;
  evidence: { level: EvidenceLevel; text: string };
  keyRisk: string | null;
  next: string;
}

const pct = (n: number) => `${n > 0 ? '+' : ''}${n.toFixed(1)}%`;
const times = (n: number | null) => (n === null ? '' : ` (about ${n.toFixed(1)}× its usual level)`);

/** The data-source wording per market (the only source behind the signal). */
export const SOURCE = { crypto: 'CoinGecko', stocks: 'Massive' } as const;

function stockReason(row: DashboardRow): string | null {
  const ch = row.change.short.value;
  if (row.signal.category === 'Mover') return `The price moved ${ch === null ? 'sharply' : pct(ch)} in the last session with higher-than-usual trading${times(row.volumeMultiple)}.`;
  if (row.signal.category === 'Watchlist') return `Trading was unusually high${times(row.volumeMultiple)}, but the price moved little.`;
  return null;
}

export function rowBrief(row: DashboardRow, lead?: { explanation?: LeadExplanation } | null): RowBrief {
  const x = lead?.explanation ?? null;
  const dataWarn = x?.warnings.find((w) => w.group === 'data_quality') ?? null;
  const volWarn = x?.warnings.find((w) => w.group === 'volatility') ?? null;
  const reason = x?.reason ?? (row.market === 'stocks' ? stockReason(row) : null);

  let evidence: RowBrief['evidence'];
  if (row.dataKind === 'test_data') evidence = { level: 'test_data', text: 'Invented values for trying the dashboard.' };
  else if (dataWarn) evidence = { level: 'limited', text: dataWarn.text };
  else if (row.market === 'stocks' && (!row.security || row.security.kind === 'unknown')) evidence = { level: 'limited', text: 'Security type not confirmed (it may not be an ordinary stock).' };
  else evidence = { level: 'single_source', text: `Complete ${SOURCE[row.market]} market data; one source, not independently confirmed.` };

  // Volatility first, then the scanner's own weaker-evidence caution (e.g. only volume stands out).
  const keyRisk = volWarn?.text ?? row.risk.flags[0] ?? x?.warnings.find((w) => w.group === 'evidence')?.text ?? null;

  let next: string;
  if (evidence.level === 'test_data') next = 'Run a live scan for real data.';
  else if (evidence.level === 'limited') next = 'Treat as unconfirmed: check the next scan or a second source before drawing any conclusion.';
  else if (row.signal.category === 'Watchlist') next = 'Check the news for a catalyst; watch whether the price follows the trading activity.';
  else if (row.signal.category === 'Mover') next = 'Check the news for a catalyst, then a second source, before drawing any conclusion.';
  else next = 'No signal: nothing to act on from this scan.';
  return { reason, evidence, keyRisk, next };
}

/** Adds a brief to every row; crypto rows use the scan's lead explanations (by coin id) when present. */
export function withBriefs<R extends DashboardRow>(rows: R[], result: { discovery?: { highPriority?: unknown[]; watchlist?: unknown[] } }): (R & { brief: RowBrief })[] {
  const leads = new Map<string, { explanation?: LeadExplanation }>();
  for (const e of [...(result.discovery?.highPriority ?? []), ...(result.discovery?.watchlist ?? [])] as { id?: unknown; explanation?: LeadExplanation }[]) {
    if (typeof e?.id === 'string') leads.set(e.id, e);
  }
  return rows.map((r) => ({ ...r, brief: rowBrief(r, r.market === 'crypto' ? leads.get(r.id) : null) }));
}
