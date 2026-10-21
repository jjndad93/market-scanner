/**
 * Stage 7: one scan summary shape for every scanner, shown at the end of each text report and
 * added (additively) to each JSON result as `scan`. Builders fill it ONLY from counts the scan
 * result actually holds; nothing here is estimated.
 */

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
  /** Why the rest did not qualify: first exclusion reasons and other outcomes, largest first. */
  notQualified: { reason: string; count: number }[];
}

/** Groups first-reason labels into counts, largest first (ties by label). */
export function tally(labels: string[]): { reason: string; count: number }[] {
  const m = new Map<string, number>();
  for (const l of labels) m.set(l, (m.get(l) ?? 0) + 1);
  return [...m].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || (a.reason < b.reason ? -1 : 1));
}

/** The SCAN SUMMARY section (wrapped by the caller's wrap function to the report width). */
export function renderSummary(s: ScanSummary, wrap: (text: string, indent: string, first?: string) => string[]): string[] {
  const out = ['', 'SCAN SUMMARY'];
  const line = (label: string, text: string) => out.push(...wrap(`${label.padEnd(15)}${text}`, `  ${' '.repeat(15)}`, '  '));
  line('Scanned:', s.scope);
  line('Data:', `${s.data} (${s.mode === 'live' ? 'live mode' : 'offline: no network requests'})`);
  line('Qualified:', `${s.qualified}`);
  // "N excluded (n reason, ...)" first, then each other outcome as "n description".
  const excluded = s.notQualified.filter((n) => n.reason.startsWith('excluded: '));
  const other = s.notQualified.filter((n) => !n.reason.startsWith('excluded: '));
  const parts = [
    ...(excluded.length > 0 ? [`${excluded.reduce((a, n) => a + n.count, 0)} excluded (${excluded.map((n) => `${n.count} ${n.reason.slice('excluded: '.length)}`).join(', ')})`] : []),
    ...other.map((n) => `${n.count} ${n.reason}`),
  ];
  line('Not qualified:', parts.length > 0 ? parts.join('; ') : 'none');
  line('Status:', s.status === 'complete' ? 'COMPLETE for the scanned scope (not a market-wide scan)' : `PARTIAL - ${s.partialReasons.join('; ')}`);
  return out;
}
