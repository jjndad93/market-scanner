/**
 * Crypto asset search for the dashboard: find any CoinGecko coin by name or symbol, including coins
 * the scanner did not select, then show its current market data. Separate from scans: a search or
 * an asset lookup never starts a scan and never changes scan results or budget filters.
 *
 * Requests (live mode only; offline mode reads a TEST DATA fixture and makes none):
 * - Exactly ONE CoinGecko request per search (/search) and per asset lookup (/coins/markets?ids=),
 *   each through the existing HTTP client with a 1-call budget, the key in a header only.
 * - Nothing is sent without an explicit confirmation from the page; cached answers need none.
 *   Searches are cached for SEARCH_CACHE_TTL_MS, lookups for ASSET_CACHE_TTL_MS; "refresh"
 *   bypasses the cache and needs confirmation again.
 * - Live requests are spaced (LIVE_MIN_INTERVAL_MS, well under the Demo plan's 100 calls/minute),
 *   capped per server session (SESSION_REQUEST_LIMIT), never run alongside a scan, and one at a time.
 *
 * Ambiguity: CoinGecko symbols are not unique. Results are listed with names, symbols and ids; a
 * symbol shared by several results is flagged; nothing is auto-selected. Lookups are by unique id.
 */

import { readFileSync } from 'node:fs';
import { has, type Evidence } from '../core/evidence.ts';
import { COINGECKO_ATTRIBUTION, COINGECKO_DEMO_BASE_URL, COINGECKO_KEY_ENV, COINGECKO_KEY_HEADER, ProviderResponseError, parseMarkets } from '../providers/coingecko.ts';
import { COIN_ID_PATTERN, type SearchCoin, fetchCoinMarket, fetchCoinSearch, parseSearchCoins } from '../providers/coingecko-search.ts';
import { HttpError, type FetchLike, createHttpClient } from '../providers/http.ts';
import { normalizeDataset } from '../scanner/normalize.ts';
import type { RawAsset } from '../scanner/types.ts';
import type { LastScan } from './news.ts';

export const SEARCH_MAX_RESULTS = 25;
export const SEARCH_CACHE_TTL_MS = 15 * 60_000;
export const ASSET_CACHE_TTL_MS = 5 * 60_000;
/** 2 s apart = at most 30 requests/minute, well under the Demo plan's documented 100 calls/minute (shared with scans, which never overlap). */
export const LIVE_MIN_INTERVAL_MS = 2_000;
export const SESSION_REQUEST_LIMIT = 100;
export const BUNDLED_CRYPTO_SEARCH_FIXTURE = new URL('../../test/fixtures/crypto-search.synthetic.json', import.meta.url);
export const SEARCH_SOURCE = 'CoinGecko Demo API /search (all coins CoinGecko lists, sorted by market cap)';
export const ASSET_SOURCE = 'CoinGecko Demo API /coins/markets (USD)';

export type Mode = 'offline' | 'live';
export interface SearchDeps { env: Record<string, string | undefined>; fetch: FetchLike; clock: () => Date; sleep?: (ms: number) => Promise<void> }
export interface Reply { status: number; data: Record<string, unknown> }

export type MatchKind = 'symbol' | 'name' | 'id' | 'partial';
export interface SearchResult extends SearchCoin { match: MatchKind }

/** Trims, collapses spaces and drops a leading "$". Returns null for an unusable query. */
export function normalizeQuery(q: unknown): string | null {
  if (typeof q !== 'string') return null;
  const t = q.trim().replace(/\s+/g, ' ').replace(/^\$/, '');
  return t.length >= 2 && t.length <= 50 && /^[\p{L}\p{N} ._()-]+$/u.test(t) ? t : null;
}

/**
 * Orders and annotates results: exact symbol, name or id matches first, otherwise the provider's
 * order (market cap). Flags every symbol shared by more than one result. Never selects one.
 */
export function rankResults(coins: readonly SearchCoin[], query: string) {
  const q = query.toLowerCase();
  const matchOf = (c: SearchCoin): MatchKind => (c.symbol.toLowerCase() === q ? 'symbol' : c.name.toLowerCase() === q ? 'name' : c.id === q ? 'id' : 'partial');
  const annotated: SearchResult[] = coins.map((c) => ({ ...c, match: matchOf(c) }));
  const ordered = [...annotated.filter((c) => c.match !== 'partial'), ...annotated.filter((c) => c.match === 'partial')];
  const shown = ordered.slice(0, SEARCH_MAX_RESULTS);
  const bySymbol = new Map<string, string[]>();
  for (const c of shown) bySymbol.set(c.symbol, [...(bySymbol.get(c.symbol) ?? []), c.id]);
  const ambiguousSymbols = [...bySymbol].filter(([, ids]) => ids.length > 1).map(([symbol, ids]) => ({ symbol, ids }));
  const exactSymbol = shown.filter((c) => c.match === 'symbol');
  let guidance: string | null = null;
  if (shown.length === 0) guidance = `No CoinGecko coin matches "${query}". Check the spelling, or try the full name or the symbol.`;
  else if (exactSymbol.length > 1) guidance = `${exactSymbol.length} different coins use the symbol ${exactSymbol[0]!.symbol}. Symbols are not unique: choose by name and CoinGecko id.`;
  return { results: shown, total: coins.length, ambiguousSymbols, guidance };
}

const ev = <T>(e: Evidence<T> | undefined) => (e === undefined ? { value: null, kind: 'missing', note: 'not provided' } : { value: has(e) ? e.value : null, kind: e.kind, note: e.note ?? null });

/** Validates a lookup response through the scanner's own normalizer; null when the coin is absent. */
export function assetView(raw: RawAsset[], id: string, mode: Mode, asOf: string) {
  const match = raw.filter((r) => typeof r === 'object' && r !== null && r.id === id); // never show a different coin
  if (match.length === 0) return null;
  const n = normalizeDataset({
    dataset: mode === 'live'
      ? { kind: 'live', label: 'asset lookup', source: ASSET_SOURCE, asOf, attribution: COINGECKO_ATTRIBUTION }
      : { kind: 'synthetic', label: 'crypto-search synthetic', source: 'Synthetic search fixture', asOf },
    assets: match.slice(0, 1),
  });
  const a = n.assets[0];
  if (!a) return null;
  return {
    id: a.id, name: a.name, symbol: a.symbol,
    price: ev(a.price), change24hPct: ev(a.change24hPct), change7dPct: ev(a.change7dPct),
    volume24h: ev(a.volume24h), marketCap: ev(a.marketCap), lastUpdated: ev(a.lastUpdated),
    rank: ev(a.market?.rank), high24h: ev(a.market?.high24h), low24h: ev(a.market?.low24h),
  };
}

function failureMessage(e: unknown): string {
  if (e instanceof ProviderResponseError) return `CoinGecko sent a response that could not be used (${e.message}). Try again later.`;
  if (!(e instanceof HttpError)) return 'The request failed unexpectedly. Try again later.';
  if (e.status === 401) return `CoinGecko rejected the API key (HTTP 401). Check ${COINGECKO_KEY_ENV}, then restart the dashboard.`;
  if (e.status === 403) return 'CoinGecko refused access (HTTP 403). The Demo API reference lists /search and /coins/markets; check the key and its plan.';
  if (e.status === 429 || e.kind === 'rate_limited' || e.kind === 'budget') return 'CoinGecko is rate-limiting requests (HTTP 429; the Demo plan allows 100 per minute, shared with scans). Wait a minute, then try again.';
  if (e.kind === 'timeout') return 'The request to CoinGecko timed out. Check your connection and try again later.';
  if (e.kind === 'network') return 'Could not reach CoinGecko. Check your internet connection, then try again.';
  if (e.kind === 'invalid_json') return 'CoinGecko sent a response that was not valid JSON; this is usually temporary.';
  return `CoinGecko returned HTTP ${e.status}${e.status !== null && e.status >= 500 ? '; this is usually temporary' : ''}. Try again later.`;
}

/** Validates a search or lookup body. */
export function validateSearchBody(body: string, kind: 'search' | 'asset'): { mode: Mode; value: string; refresh: boolean; confirmLive: boolean } | { error: string } {
  if (body.length > 1024) return { error: 'Request body too large.' };
  let d: unknown;
  try {
    d = JSON.parse(body);
  } catch {
    return { error: 'Request body must be JSON.' };
  }
  if (typeof d !== 'object' || d === null) return { error: 'Request body must be a JSON object.' };
  const r = d as Record<string, unknown>;
  if (r.mode !== 'offline' && r.mode !== 'live') return { error: 'mode must be "offline" or "live".' };
  const value = kind === 'search' ? normalizeQuery(r.query) : (typeof r.id === 'string' && COIN_ID_PATTERN.test(r.id) ? r.id : null);
  if (value === null) {
    return { error: kind === 'search' ? 'Enter 2 to 50 characters: letters, digits, spaces, or . _ - ( ).' : 'id must be a CoinGecko coin id from the search results.' };
  }
  return { mode: r.mode, value, refresh: r.refresh === true, confirmLive: r.confirmLive === true };
}

export function createCryptoSearchService(deps: SearchDeps, opts: { getLastCrypto: () => LastScan | undefined; scanRunning: () => boolean; fixture?: URL; minIntervalMs?: number; sessionLimit?: number }) {
  const searchCache = new Map<string, { at: number; coins: SearchCoin[]; skipped: number }>();
  const assetCache = new Map<string, { at: number; raw: RawAsset[] }>();
  let busy = false;
  let lastLiveAt = -Infinity;
  let used = 0;
  const minInterval = opts.minIntervalMs ?? LIVE_MIN_INTERVAL_MS;
  const limit = opts.sessionLimit ?? SESSION_REQUEST_LIMIT;
  let fixtureCache: { asOf: string; search: unknown; markets: unknown } | undefined;
  const fixture = () => (fixtureCache ??= JSON.parse(readFileSync(opts.fixture ?? BUNDLED_CRYPTO_SEARCH_FIXTURE, 'utf8')));
  const reply = (status: number, data: Record<string, unknown>): Reply => ({ status, data: { ok: status === 200, ...data } });
  const session = () => ({ liveRequestsThisSession: used, sessionRequestLimit: limit });

  /** Runs one live request under every guard; `run` gets a 1-call client. */
  async function live<T>(confirm: boolean, run: (client: ReturnType<typeof createHttpClient>) => Promise<T>): Promise<{ value: T; calls: number } | Reply> {
    if (!confirm) return reply(428, { error: 'This sends 1 CoinGecko request. Confirm to continue.', needsConfirm: true, ...session() });
    const key = deps.env[COINGECKO_KEY_ENV]?.trim();
    if (!key) return reply(422, { error: `${COINGECKO_KEY_ENV} is not set on the server, so no request was made. Offline mode still works.` });
    if (opts.scanRunning()) return reply(409, { error: 'A scan is running; search waits until it finishes (they share CoinGecko\'s rate limit).' });
    if (busy) return reply(409, { error: 'A search request is already running.' });
    if (used >= limit) return reply(429, { error: `This dashboard session has used its ${limit} live search requests. Restart the dashboard to reset the limit.`, ...session() });
    const now = deps.clock().getTime();
    const wait = lastLiveAt + minInterval - now;
    if (wait > 0) return reply(429, { error: `To stay under CoinGecko's Demo limit, wait ${Math.ceil(wait / 1000)} s before the next live request.` });
    busy = true;
    lastLiveAt = now;
    const client = createHttpClient({ fetch: deps.fetch, baseUrl: COINGECKO_DEMO_BASE_URL, apiKeyHeader: COINGECKO_KEY_HEADER, apiKey: key, maxCalls: 1, sleep: deps.sleep, maxRetryWaitMs: 0 });
    try {
      const value = await run(client);
      return { value, calls: client.callsMade };
    } catch (e) {
      return reply(502, { error: failureMessage(e).split(key).join('[REDACTED]'), requestsUsed: client.callsMade });
    } finally {
      used += client.callsMade;
      busy = false;
    }
  }

  function scanStatus(id: string) {
    const last = opts.getLastCrypto();
    if (!last) return { inLastScan: null, scanNote: 'No crypto scan has run in this dashboard session.' };
    const row = last.rows.find((r) => r.id === id);
    if (!row) {
      return { inLastScan: null, scanNote: `Not among the ${last.rows.length} assets the latest ${last.mode} crypto scan evaluated (the scan covers CoinGecko's top 500 by market cap and applies its filters).` };
    }
    return { inLastScan: { mode: last.mode, status: row.signal.status, category: row.signal.category, score: row.signal.score, maxScore: row.signal.maxScore }, scanNote: null };
  }

  return {
    get busy() {
      return busy;
    },
    async search(mode: Mode, query: string, refresh: boolean, confirmLive: boolean): Promise<Reply> {
      if (mode === 'offline') {
        const f = fixture();
        const parsed = parseSearchCoins(f.search);
        const q = query.toLowerCase();
        // Emulates the provider: name, symbol or id contains the query; fixture order is by market cap.
        const coins = parsed.coins.filter((c) => c.name.toLowerCase().includes(q) || c.symbol.toLowerCase().includes(q) || c.id.includes(q));
        return reply(200, { mode, query, dataKind: 'test_data', source: 'Synthetic search fixture (TEST DATA, invented coins)', fetchedAt: f.asOf, fromCache: false, requestsUsed: 0, skipped: parsed.skipped, ...rankResults(coins, query), ...session() });
      }
      const cacheKey = query.toLowerCase();
      const hit = searchCache.get(cacheKey);
      const now = deps.clock().getTime();
      const base = { mode, query, dataKind: 'verified_market_data', source: SEARCH_SOURCE, attribution: COINGECKO_ATTRIBUTION };
      if (hit && now - hit.at < SEARCH_CACHE_TTL_MS && !refresh) {
        return reply(200, { ...base, fetchedAt: new Date(hit.at).toISOString(), fromCache: true, requestsUsed: 0, skipped: hit.skipped, ...rankResults(hit.coins, query), ...session() });
      }
      const r = await live(confirmLive, (client) => fetchCoinSearch(client, query));
      if (!('value' in r)) return r;
      searchCache.set(cacheKey, { at: now, coins: r.value.coins, skipped: r.value.skipped });
      return reply(200, { ...base, fetchedAt: new Date(now).toISOString(), fromCache: false, requestsUsed: r.calls, skipped: r.value.skipped, ...rankResults(r.value.coins, query), ...session() });
    },
    async asset(mode: Mode, id: string, refresh: boolean, confirmLive: boolean): Promise<Reply> {
      const noData = 'CoinGecko returned no market data for this coin (it may be inactive, newly listed, or not tracked for prices).';
      if (mode === 'offline') {
        const f = fixture();
        const asset = assetView(parseMarkets(f.markets), id, 'offline', f.asOf);
        return reply(200, { mode, id, dataKind: 'test_data', source: 'Synthetic market fixture (TEST DATA, invented values)', fetchedAt: f.asOf, fromCache: false, requestsUsed: 0, asset, message: asset ? null : noData, ...scanStatus(id), ...session() });
      }
      const hit = assetCache.get(id);
      const now = deps.clock().getTime();
      const base = { mode, id, dataKind: 'verified_market_data', source: ASSET_SOURCE, attribution: COINGECKO_ATTRIBUTION };
      if (hit && now - hit.at < ASSET_CACHE_TTL_MS && !refresh) {
        const asset = assetView(hit.raw, id, 'live', new Date(hit.at).toISOString());
        return reply(200, { ...base, fetchedAt: new Date(hit.at).toISOString(), fromCache: true, requestsUsed: 0, asset, message: asset ? null : noData, ...scanStatus(id), ...session() });
      }
      const r = await live(confirmLive, (client) => fetchCoinMarket(client, id));
      if (!('value' in r)) return r;
      assetCache.set(id, { at: now, raw: r.value });
      const asset = assetView(r.value, id, 'live', new Date(now).toISOString());
      return reply(200, { ...base, fetchedAt: new Date(now).toISOString(), fromCache: false, requestsUsed: r.calls, asset, message: asset ? null : noData, ...scanStatus(id), ...session() });
    },
  };
}
export type CryptoSearchService = ReturnType<typeof createCryptoSearchService>;
