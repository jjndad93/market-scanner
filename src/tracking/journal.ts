/**
 * Candidate journal: did the scanner find opportunities early?
 *
 * After every LIVE scan, the evaluated rows are saved as one JSON file on this computer (never test
 * data, never sent anywhere). A "candidate" is a row the scanner qualified (Mover or Watchlist). Its
 * outcome after 1, 3 and 7 days is measured from LATER scans that observed the same asset again, so
 * measuring costs no extra request. An asset that no later scan observed stays "not measured yet":
 * nothing is estimated or filled in.
 *
 * Limits, stated with every result: only assets a later scan saw can be measured (crypto: the top 500
 * by market cap, usually; stocks: only if the asset is among a later day's gainers), the price is the
 * scan's price (crypto: CoinGecko's last update; stocks: the session close), and past results do not
 * predict future ones.
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const JOURNAL_VERSION = 1;
export const JOURNAL_KEEP_DAYS = 180;
export const HORIZONS = [1, 3, 7] as const;
const DAY = 86_400_000;

export interface Observation {
  key: string;
  symbol: string;
  name: string;
  /** Price and when it applied (ISO). */
  price: number;
  priceAt: string;
  /** Short-period change at the time (crypto 24h, stocks 1d), or null. */
  changePct: number | null;
  status: 'qualified' | 'over_display_limit' | 'below_threshold' | 'no_pattern';
  category: 'Mover' | 'Watchlist' | null;
  score: number | null;
  maxScore: number | null;
}
export interface ScanRecord { version: number; market: 'crypto' | 'stocks'; scannedAt: string; observations: Observation[] }

/** The minimal row shape the journal reads (a DashboardRow satisfies it). */
export interface RowLike {
  key: string; market: 'crypto' | 'stocks'; symbol: string; name: string; unitPrice: number | null; priceAsOf: string | null;
  dataKind: string; change: { short: { value: number | null } };
  signal: { status: Observation['status']; category: Observation['category']; score: number | null; maxScore: number | null };
}

export function journalDir(env: Record<string, string | undefined>): string | null {
  const base = env.LOCALAPPDATA ?? env.XDG_CACHE_HOME ?? (env.HOME ? join(env.HOME, '.cache') : undefined);
  return base ? join(base, 'market-scanner', 'candidate-journal') : null;
}

/** A price time: crypto keeps its ISO time; a stock session date means that day's 4 pm New York close (21:00 UTC). */
function priceTime(asOf: string | null): string | null {
  if (!asOf) return null;
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(asOf) ? `${asOf}T21:00:00Z` : asOf;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export function observationsFrom(rows: readonly RowLike[]): Observation[] {
  const out: Observation[] = [];
  for (const r of rows) {
    const at = priceTime(r.priceAsOf);
    if (r.dataKind === 'test_data' || r.unitPrice === null || !(r.unitPrice > 0) || at === null) continue;
    out.push({ key: r.key, symbol: r.symbol, name: r.name, price: r.unitPrice, priceAt: at, changePct: r.change.short.value,
      status: r.signal.status, category: r.signal.category, score: r.signal.score, maxScore: r.signal.maxScore });
  }
  return out;
}

/** Saves one live scan (atomic write). Returns false when nothing was saved; never throws. */
export function recordScan(dir: string, market: 'crypto' | 'stocks', scannedAt: Date, rows: readonly RowLike[]): boolean {
  const observations = observationsFrom(rows);
  if (observations.length === 0) return false;
  try {
    mkdirSync(dir, { recursive: true });
    const name = `${market}-${scannedAt.toISOString().replace(/[:.]/g, '-')}.json`;
    const tmp = join(dir, `${name}.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify({ version: JOURNAL_VERSION, market, scannedAt: scannedAt.toISOString(), observations } satisfies ScanRecord));
    renameSync(tmp, join(dir, name));
    pruneJournal(dir, scannedAt);
    return true;
  } catch {
    return false;
  }
}

function pruneJournal(dir: string, now: Date) {
  for (const f of readdirSync(dir)) {
    const m = /^(crypto|stocks)-(\d{4}-\d{2}-\d{2})T/.exec(f);
    if (m && now.getTime() - Date.parse(`${m[2]}T00:00:00Z`) > JOURNAL_KEEP_DAYS * DAY) {
      try { unlinkSync(join(dir, f)); } catch { /* best effort */ }
    }
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Every readable scan record, oldest first. Corrupt or foreign files are skipped. */
export function loadJournal(dir: string): ScanRecord[] {
  let files: string[];
  try { files = readdirSync(dir).filter((f) => /^(crypto|stocks)-.*\.json$/.test(f)); } catch { return []; }
  const out: ScanRecord[] = [];
  for (const f of files) {
    try {
      const r: unknown = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (!isRecord(r) || r.version !== JOURNAL_VERSION || (r.market !== 'crypto' && r.market !== 'stocks') || typeof r.scannedAt !== 'string' || !Array.isArray(r.observations)) continue;
      const obs = (r.observations as unknown[]).filter((o): o is Observation => isRecord(o) && typeof o.key === 'string' && typeof o.price === 'number' && o.price > 0 && typeof o.priceAt === 'string' && !Number.isNaN(Date.parse(o.priceAt)));
      out.push({ version: JOURNAL_VERSION, market: r.market, scannedAt: r.scannedAt, observations: obs });
    } catch { /* skip */ }
  }
  return out.sort((a, b) => (a.scannedAt < b.scannedAt ? -1 : 1));
}

// ---- outcomes ------------------------------------------------------------------------------------

export interface CandidateOutcome {
  key: string; market: 'crypto' | 'stocks'; symbol: string; name: string;
  category: 'Mover' | 'Watchlist'; score: number | null; maxScore: number | null;
  /** When it was FIRST flagged, at what price, and its move at that time. */
  flaggedAt: string; price: number; changeAtFlag: number | null;
  /** % change to the first later observation in each window, or null when not observed. */
  after: Record<(typeof HORIZONS)[number], number | null>;
  /** Times it was flagged again later. */
  reflagged: number;
}
export interface HorizonStat { horizon: number; measured: number; up: number; medianPct: number | null; meanPct: number | null }
export interface TrackRecord {
  candidates: number;
  /** Flagged long enough ago for at least the 1-day window to be possible. */
  old: number;
  stats: HorizonStat[];
  byCategory: { category: 'Mover' | 'Watchlist'; stats: HorizonStat[] }[];
  recent: CandidateOutcome[];
  scans: number;
  firstScan: string | null;
  notes: string[];
}

/** A later observation counts for horizon H when taken between H - 0.2 days and 1.6 x H + 1 days after the flag. */
const inWindow = (dtDays: number, h: number) => dtDays >= h - 0.2 && dtDays <= h * 1.6 + 1;

export function outcomes(records: readonly ScanRecord[], market?: 'crypto' | 'stocks'): CandidateOutcome[] {
  const recs = records.filter((r) => !market || r.market === market);
  const first = new Map<string, CandidateOutcome & { t0: number }>();
  for (const rec of recs) {
    for (const o of rec.observations) {
      if (o.status !== 'qualified' || !o.category) continue;
      const k = `${rec.market}|${o.key}`;
      const seen = first.get(k);
      if (seen) { if (Date.parse(o.priceAt) > seen.t0 + 0.5 * DAY) seen.reflagged++; continue; }
      first.set(k, { key: o.key, market: rec.market, symbol: o.symbol, name: o.name, category: o.category, score: o.score, maxScore: o.maxScore,
        flaggedAt: o.priceAt, price: o.price, changeAtFlag: o.changePct, after: { 1: null, 3: null, 7: null }, reflagged: 0, t0: Date.parse(o.priceAt) });
    }
  }
  for (const c of first.values()) {
    for (const h of HORIZONS) {
      for (const rec of recs) {
        if (rec.market !== c.market) continue;
        const o = rec.observations.find((x) => x.key === c.key);
        if (!o) continue;
        const dt = (Date.parse(o.priceAt) - c.t0) / DAY;
        if (inWindow(dt, h)) { c.after[h] = (o.price / c.price - 1) * 100; break; }
      }
    }
  }
  return [...first.values()].map(({ t0: _t, ...c }) => c).sort((a, b) => (a.flaggedAt < b.flaggedAt ? 1 : -1));
}

const median = (v: number[]) => { if (!v.length) return null; const s = [...v].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
function stats(list: CandidateOutcome[]): HorizonStat[] {
  return HORIZONS.map((h) => {
    const v = list.map((c) => c.after[h]).filter((x): x is number => x !== null);
    return { horizon: h, measured: v.length, up: v.filter((x) => x > 0).length, medianPct: median(v), meanPct: v.length ? v.reduce((a, b) => a + b, 0) / v.length : null };
  });
}

export function trackRecord(records: readonly ScanRecord[], now: Date, market?: 'crypto' | 'stocks', recentLimit = 12): TrackRecord {
  const list = outcomes(records, market);
  const recs = records.filter((r) => !market || r.market === market);
  const old = list.filter((c) => now.getTime() - Date.parse(c.flaggedAt) >= 0.8 * DAY).length;
  const unmeasured = list.filter((c) => now.getTime() - Date.parse(c.flaggedAt) >= 1.6 * DAY && HORIZONS.every((h) => c.after[h] === null)).length;
  const notes = [
    'Measured from the price when a candidate was first flagged to the first later scan that saw it in each window (1 day: 0.8-2.6 days later; 3 days: 2.8-5.8; 7 days: 6.8-12.2). No extra requests; nothing is estimated.',
    'Only assets a later scan observed can be measured: crypto usually (top 500), stocks only if the stock is among a later day\'s gainers. Past results do not predict future moves.',
  ];
  if (unmeasured) notes.push(`${unmeasured} older candidate(s) were never observed again by a later scan, so they cannot be measured.`);
  return {
    candidates: list.length, old, stats: stats(list),
    byCategory: (['Mover', 'Watchlist'] as const).map((category) => ({ category, stats: stats(list.filter((c) => c.category === category)) })),
    recent: list.slice(0, recentLimit), scans: recs.length, firstScan: recs[0]?.scannedAt ?? null, notes,
  };
}
