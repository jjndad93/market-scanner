/**
 * Stage 7: one scan summary shape for every scanner, shown at the end of each text report and
 * added (additively) to each JSON result as `scan`. Builders fill it ONLY from counts the scan
 * result actually holds; nothing here is estimated.
 */

import { terminalSafe } from './format.ts';

export interface ScanSummary {
  scanType: 'crypto' | 'stocks' | 'options';
  /** ISO time the scan was evaluated at. */
  scannedAt: string;
  /** 'offline' = bundled or --fixture synthetic data, no network; 'live' = fetched by this tool. */
  mode: 'live' | 'offline';
  /** What the data is, in words (e.g. "synthetic fixture (TEST DATA)", "live; 3 histories from today's cache"). */
  data: string;
  source: string;
  /** What was scanned, in words. */
  scope: string;
  status: 'complete' | 'partial';
  /** Why the scan is partial (empty when complete). */
  partialReasons: string[];
  /** Named counts taken directly from the scan result. */
  counts: Record<string, number>;
  /** Candidates that met the evidence threshold (or were ranked, for options). */
  qualified: number;
  /** Stage 10: their symbols or contract tickers, in report order. */
  qualifiedNames: string[];
  /** Stage 10: how fresh the data is, from the scan's own timestamps and rules (never guessed). */
  freshness: string;
  /** Stage 10: the next practical step when the scan is partial or nothing could be evaluated; else null. */
  nextStep: string | null;
  /** Why the rest did not qualify: first exclusion reasons and other outcomes, largest first. */
  notQualified: { reason: string; count: number }[];
}

/** Groups first-reason labels into counts, largest first (ties by label). */
export function tally(labels: string[]): { reason: string; count: number }[] {
  const m = new Map<string, number>();
  for (const l of labels) m.set(l, (m.get(l) ?? 0) + 1);
  return [...m].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || (a.reason < b.reason ? -1 : 1));
}

/**
 * The next step for a live scan that stopped early, from the stop reason the scan recorded.
 * `keyEnv` and `provider` name the variable and provider; nothing is guessed beyond the reason.
 */
export function nextStepForStop(stopReason: string | null, keyEnv: string, provider: string): string {
  if (stopReason === null) return 'check DATA NOTES for the failed requests, then run again later.';
  if (/HTTP 401/.test(stopReason)) return `check ${keyEnv} and your ${provider} account; retrying with the same key will not help.`;
  if (/HTTP 403/.test(stopReason)) return `check your ${provider} plan and permissions; retrying will not help until access changes.`;
  if (/rate-limited/.test(stopReason)) return 'wait a few minutes, then run again (consider a smaller --max-requests).';
  if (/per-run limit/.test(stopReason)) return 'run again with a larger --max-requests if you want to spend more API requests on this scan.';
  return 'check DATA NOTES, then run again later.';
}

/** The SCAN SUMMARY section (wrapped by the caller's wrap function to the report width). */
export function renderSummary(s: ScanSummary, wrap: (text: string, indent: string, first?: string) => string[]): string[] {
  const out = ['', 'SCAN SUMMARY'];
  const line = (label: string, text: string) => out.push(...wrap(`${label.padEnd(15)}${text}`, `  ${' '.repeat(15)}`, '  '));
  line('Scanned:', s.scope);
  line('Data:', `${s.data} (${s.mode === 'live' ? 'live mode' : 'offline: no network requests'})`);
  line('Freshness:', s.freshness);
  // Provider-supplied names: escape control characters at this output boundary (JSON keeps the raw values).
  const names = s.qualifiedNames.slice(0, 8).map(terminalSafe).join(', ') + (s.qualifiedNames.length > 8 ? `, +${s.qualifiedNames.length - 8} more` : '');
  line('Qualified:', s.qualified > 0 ? `${s.qualified} (${names})` : '0');
  // "N excluded (n reason, ...)" first, then each other outcome as "n description".
  const excluded = s.notQualified.filter((n) => n.reason.startsWith('excluded: '));
  const other = s.notQualified.filter((n) => !n.reason.startsWith('excluded: '));
  const parts = [
    ...(excluded.length > 0 ? [`${excluded.reduce((a, n) => a + n.count, 0)} excluded (${excluded.map((n) => `${n.count} ${n.reason.slice('excluded: '.length)}`).join(', ')})`] : []),
    ...other.map((n) => `${n.count} ${n.reason}`),
  ];
  line('Not qualified:', parts.length > 0 ? parts.join('; ') : 'none');
  line('Status:', s.status === 'complete' ? 'COMPLETE for the scanned scope (not a market-wide scan)' : `PARTIAL - ${s.partialReasons.join('; ')}`);
  if (s.nextStep !== null) line('Next step:', s.nextStep);
  return out;
}
