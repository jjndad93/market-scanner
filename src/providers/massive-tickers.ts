/**
 * Security types for US stock tickers, from Massive's ticker reference: GET /v3/reference/tickers
 * (official docs checked 2026-10-28: "Included in all Stocks plans", including the free Stocks
 * Basic plan; up to 1,000 tickers per request; `type` codes such as CS, ADRC, ETF, ETN, WARRANT,
 * RIGHT, UNIT, PFD; pages continue through `next_url`).
 *
 * Used by market-wide stock scans so that only ordinary stocks, depositary receipts and ordinary
 * ETFs take a candidate slot. The reference changes slowly, so the parsed map is cached on disk for
 * REFERENCE_MAX_AGE_MS and refreshed only when stale, within the scan's own request limit.
 *
 * Leveraged and inverse ETFs are NOT a provider type: they are recognised by their fund NAME
 * (e.g. "2X", "Ultra", "Bear", "Inverse"). That is a heuristic and is labelled as one.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SecurityInfo } from '../stocks/types.ts';
import { HttpError, type HttpClient } from './http.ts';
import { MassiveResponseError } from './massive.ts';
import { cleanText } from './massive-news.ts';

export const TICKER_REFERENCE_PATH = '/v3/reference/tickers';
export const REFERENCE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
/** Upper bound on reference pages per refresh (about 12 are expected for active US stocks). */
export const REFERENCE_MAX_PAGES = 15;
const CACHE_VERSION = 1;

export interface TickerRef { name: string; type: string }
export interface TickerReference { fetchedAt: string; tickers: Map<string, TickerRef>; complete: boolean }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** One reference page -> entries + the cursor of the next page (only from a next_url on the same host and path). */
export function parseTickerPage(json: unknown): { entries: [string, TickerRef][]; cursor: string | null } {
  if (!isRecord(json) || (json.results !== undefined && !Array.isArray(json.results))) throw new MassiveResponseError('ticker-reference response is not an object with a results array.');
  const entries: [string, TickerRef][] = [];
  for (const r of (json.results as unknown[] | undefined) ?? []) {
    if (!isRecord(r) || typeof r.ticker !== 'string' || !/^[A-Z][A-Z0-9.]{0,9}$/.test(r.ticker) || typeof r.type !== 'string' || !/^[A-Z]{1,10}$/.test(r.type)) continue;
    entries.push([r.ticker, { name: cleanText(r.name, 120) ?? r.ticker, type: r.type }]);
  }
  let cursor: string | null = null;
  if (typeof json.next_url === 'string') {
    try {
      const u = new URL(json.next_url);
      // Follow only Massive's own continuation of this listing; take just the cursor (never a key in a URL).
      if (u.protocol === 'https:' && u.hostname === 'api.massive.com' && u.pathname === TICKER_REFERENCE_PATH) cursor = u.searchParams.get('cursor');
    } catch { /* unusable next_url: stop paging */ }
  }
  return { entries, cursor: cursor && /^[A-Za-z0-9_=-]{1,2000}$/.test(cursor) ? cursor : null };
}

/** Fetches the active US stock reference, page by page, within `maxPages` and the client's budget. */
export async function fetchTickerReference(o: { client: HttpClient; clock: () => Date; maxPages: number; minIntervalMs: number; sleep: (ms: number) => Promise<void> }): Promise<TickerReference> {
  const tickers = new Map<string, TickerRef>();
  let cursor: string | null = null;
  let pages = 0;
  do {
    if (pages > 0) await o.sleep(o.minIntervalMs);
    const params: Record<string, string> = { market: 'stocks', active: 'true', limit: '1000', order: 'asc', sort: 'ticker' };
    if (cursor) params.cursor = cursor;
    const page = parseTickerPage(await o.client.getJson(TICKER_REFERENCE_PATH, params));
    for (const [t, ref] of page.entries) tickers.set(t, ref);
    cursor = page.cursor;
    pages++;
  } while (cursor !== null && pages < o.maxPages);
  return { fetchedAt: o.clock().toISOString(), tickers, complete: cursor === null };
}

// ---- classification ----------------------------------------------------------------------------

/** Types that are not ordinary shares or funds: never a stock candidate. */
const EXCLUDED_TYPES: Record<string, string> = {
  WARRANT: 'warrant', RIGHT: 'right', UNIT: 'unit', PFD: 'preferred share', ADRP: 'preferred depositary receipt',
  ADRW: 'depositary warrant', ADRR: 'depositary right', BOND: 'bond', SP: 'structured product', BASKET: 'basket',
  LT: 'liquidating trust', OS: 'other security', GDR: 'global depositary receipt', NYRS: 'New York registry share',
};
const ETP_TYPES: Record<string, string> = { ETF: 'ETF', ETN: 'ETN (exchange-traded note)', ETV: 'Exchange-traded vehicle', ETS: 'Single-security ETF', FUND: 'Fund' };

/** Leveraged or inverse by NAME (heuristic): "2X", "3x Long", "Ultra", "UltraPro", "Leveraged", "Inverse", "Bear". */
export function gearing(name: string): 'leveraged' | 'inverse' | null {
  const n = name.replace(/[-_]/g, ' ');
  if (/\binverse\b/i.test(n) || /\bbear\b/i.test(n) || /\bultrashort\b/i.test(n) || /(^|\s)-\s?\d(\.\d+)?\s?x\b/i.test(name)) return 'inverse';
  // "ProShares Short QQQ" is inverse; "Short-Term Treasury", "Short Duration Bond" are ordinary bond funds.
  if (/\bshort\b(?!\s+(term|duration|maturity|dated|treasury|bond|income|horizon|vol))/i.test(n) && !/\b(treasury|bond|income|municipal|muni)\b/i.test(n)) return 'inverse';
  if (/\b[1-9](\.\d+)?\s?x\b/i.test(n) || /\bultra(pro)?\b/i.test(n) || /\bleveraged\b/i.test(n) || /\bdaily\b.*\bbull\b/i.test(n)) return 'leveraged';
  return null;
}

export interface Classified { keep: boolean; reason: string | null; security: SecurityInfo; name: string | null }

const NAME_BASIS = 'Massive ticker reference; leveraged/inverse detected from the fund name (heuristic)';

/** Classifies one ticker. Without a reference (not fetched), everything is kept and marked "not checked". */
export function classifyTicker(ticker: string, ref: TickerReference | null): Classified {
  if (ref === null) return { keep: true, reason: null, name: null, security: { kind: 'unknown', typeCode: null, label: 'Type not checked', basis: 'ticker reference not available in this run' } };
  const r = ref.tickers.get(ticker);
  if (!r) {
    return { keep: true, reason: null, name: null, security: { kind: 'unknown', typeCode: null, label: 'Type unknown', basis: ref.complete ? 'not in Massive\'s active ticker reference' : 'ticker reference incomplete (page limit)' } };
  }
  const basis = 'Massive ticker reference';
  if (r.type === 'CS') return { keep: true, reason: null, name: r.name, security: { kind: 'common', typeCode: 'CS', label: 'Common stock', basis } };
  if (r.type === 'ADRC') return { keep: true, reason: null, name: r.name, security: { kind: 'adr', typeCode: 'ADRC', label: 'ADR (depositary receipt)', basis } };
  if (Object.hasOwn(ETP_TYPES, r.type)) {
    const g = gearing(r.name);
    if (g === 'leveraged') return { keep: false, reason: 'leveraged ETF/ETN', name: r.name, security: { kind: 'etf', typeCode: r.type, label: `Leveraged ${ETP_TYPES[r.type]}`, basis: NAME_BASIS } };
    if (g === 'inverse') return { keep: false, reason: 'inverse ETF/ETN', name: r.name, security: { kind: 'etf', typeCode: r.type, label: `Inverse ${ETP_TYPES[r.type]}`, basis: NAME_BASIS } };
    return { keep: true, reason: null, name: r.name, security: { kind: 'etf', typeCode: r.type, label: ETP_TYPES[r.type]!, basis: NAME_BASIS } };
  }
  const what = EXCLUDED_TYPES[r.type] ?? `security type ${r.type}`;
  return { keep: false, reason: what, name: r.name, security: { kind: 'unknown', typeCode: r.type, label: what, basis } };
}

// ---- disk cache --------------------------------------------------------------------------------

export function tickerReferenceDir(env: Record<string, string | undefined>): string | null {
  const base = env.LOCALAPPDATA ?? env.XDG_CACHE_HOME ?? (env.HOME ? join(env.HOME, '.cache') : undefined);
  return base ? join(base, 'market-scanner', 'massive-tickers') : null;
}
const cacheFile = (dir: string) => join(dir, `${createHash('sha256').update('us-stocks-active').digest('hex').slice(0, 16)}.json`);

/** A fresh cached reference, or null (missing, stale, corrupt or from another version). */
export function readCachedReference(dir: string, now: Date): TickerReference | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(cacheFile(dir), 'utf8'));
    if (!isRecord(raw) || raw.version !== CACHE_VERSION || typeof raw.fetchedAt !== 'string' || !Array.isArray(raw.tickers) || typeof raw.complete !== 'boolean') return null;
    const at = Date.parse(raw.fetchedAt);
    if (Number.isNaN(at) || now.getTime() - at > REFERENCE_MAX_AGE_MS || at > now.getTime() + 60_000) return null;
    const tickers = new Map<string, TickerRef>();
    for (const e of raw.tickers) {
      if (Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'string' && typeof e[2] === 'string') tickers.set(e[0], { name: e[1], type: e[2] });
    }
    return tickers.size > 0 ? { fetchedAt: new Date(at).toISOString(), tickers, complete: raw.complete } : null;
  } catch {
    return null;
  }
}

/** Writes a complete reference (atomic rename). Returns false if it could not be written. */
export function writeCachedReference(dir: string, ref: TickerReference): boolean {
  if (!ref.complete) return false; // an incomplete list would hide types for a week
  try {
    mkdirSync(dir, { recursive: true });
    const tmp = `${cacheFile(dir)}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: CACHE_VERSION, fetchedAt: ref.fetchedAt, complete: ref.complete, tickers: [...ref.tickers].map(([t, r]) => [t, r.name, r.type]) }));
    renameSync(tmp, cacheFile(dir));
    return true;
  } catch {
    return false;
  }
}

/**
 * The reference for this run: the cached copy when fresh, else a refresh if the budget leaves room for
 * `reserve` later requests. Never throws for provider trouble: the scan continues without types.
 */
export async function loadTickerReference(o: {
  client: HttpClient; clock: () => Date; maxCalls: number; reserve: number; cacheDir: string | null;
  minIntervalMs: number; sleep: (ms: number) => Promise<void>;
}): Promise<{ ref: TickerReference | null; note: string; requestsUsed: number }> {
  const now = o.clock();
  const cached = o.cacheDir ? readCachedReference(o.cacheDir, now) : null;
  if (cached) return { ref: cached, requestsUsed: 0, note: `Security types: Massive ticker reference from ${cached.fetchedAt.slice(0, 10)} (cached, refreshed weekly; no request made).` };
  const room = o.maxCalls - o.client.callsMade - o.reserve;
  if (room < 2) return { ref: null, requestsUsed: 0, note: `Security types were not checked: the request limit leaves no room for the weekly ticker-reference refresh (about 12 requests). ETFs, warrants and units may appear unlabelled; raise "Max API requests" once to refresh it.` };
  const before = o.client.callsMade;
  try {
    const ref = await fetchTickerReference({ client: o.client, clock: o.clock, maxPages: Math.min(REFERENCE_MAX_PAGES, room), minIntervalMs: o.minIntervalMs, sleep: o.sleep });
    const used = o.client.callsMade - before;
    const saved = o.cacheDir ? writeCachedReference(o.cacheDir, ref) : false;
    return {
      ref, requestsUsed: used,
      note: `Security types: Massive ticker reference refreshed (${ref.tickers.size.toLocaleString('en-US')} active tickers, ${used} request(s))${ref.complete ? (saved ? '; cached for 7 days' : '; could not be cached') : '; INCOMPLETE (page limit), so some tickers show "type unknown"; not cached'}.`,
    };
  } catch (e) {
    const used = o.client.callsMade - before;
    if (!(e instanceof HttpError) && !(e instanceof MassiveResponseError)) throw e;
    return { ref: null, requestsUsed: used, note: `Security types were not checked: the ticker-reference request failed (${e instanceof HttpError ? (e.status ? `HTTP ${e.status}` : e.kind) : 'unusable response'}). ETFs, warrants and units may appear unlabelled.` };
  }
}
