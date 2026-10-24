/**
 * "Where to buy" for one dashboard candidate, fetched only when the user opens its panel.
 *
 * - The asset comes from the server's own copy of the last scan (the browser names a row key only).
 * - Crypto, live scan: CoinGecko /coins/{id}/tickers, exactly ONE request per fetch (first page,
 *   up to 100 markets, highest volume first), with an explicit browser confirmation, the key only on
 *   the server, results cached in memory for WTB_CACHE_TTL_MS. Refused while a scan runs.
 * - Crypto, offline scan: the synthetic tickers fixture (TEST DATA, invented exchanges), zero requests.
 * - Stocks: no request. Every stock in the scan universe is a large NYSE/Nasdaq listing, which any
 *   US broker can trade; the panel says so.
 * - Markets are grouped by exchange. Stale or anomalous tickers (CoinGecko's own flags) are dropped.
 *   US access is a FIXED list below (not from the provider) and is shown as a hint to check, not a fact.
 */

import { readFileSync } from 'node:fs';
import { COINGECKO_ATTRIBUTION, COINGECKO_DEMO_BASE_URL, COINGECKO_KEY_ENV, COINGECKO_KEY_HEADER } from '../providers/coingecko.ts';
import { HttpError, type FetchLike, createHttpClient } from '../providers/http.ts';
import type { LastScan } from './news.ts';

export const WTB_CACHE_TTL_MS = 60 * 60_000;
/** CoinGecko's free Demo plan allows about 30 calls a minute; stay well under it. */
export const WTB_MIN_INTERVAL_MS = 2_500;
export const WTB_MAX_CEX = 15;
export const WTB_MAX_DEX = 8;
export const WTB_SOURCE = 'CoinGecko Demo API (/coins/{id}/tickers, first page: up to 100 markets by volume)';
export const BUNDLED_TICKERS_FIXTURE = new URL('../../test/fixtures/crypto-tickers.synthetic.json', import.meta.url);

export type UsAccess = 'serves_us' | 'restricts_us' | 'unknown';

/**
 * CoinGecko market identifiers -> general US-customer policy, as understood when this list was
 * written (Oct 2026). Policies change and some states are stricter: always check the exchange's
 * own terms. Anything not listed is "unknown".
 */
export const US_ACCESS: Readonly<Record<string, UsAccess>> = {
  kraken: 'serves_us', gdax: 'serves_us', binance_us: 'serves_us', gemini: 'serves_us',
  crypto_com: 'serves_us', bitstamp: 'serves_us', uphold: 'serves_us',
  binance: 'restricts_us', kucoin: 'restricts_us', mxc: 'restricts_us', gate: 'restricts_us',
  bybit_spot: 'restricts_us', okex: 'restricts_us', huobi: 'restricts_us', bitget: 'restricts_us',
  bingx: 'restricts_us', coinex: 'restricts_us', lbank: 'restricts_us', bitmart: 'restricts_us', xt: 'restricts_us',
};
const US_RANK: Record<UsAccess, number> = { serves_us: 0, unknown: 1, restricts_us: 2 };

const DEX_NAME = /swap|uniswap|pancake|sushi|curve|balancer|raydium|orca|jupiter|aerodrome|velodrome|trader_?joe|camelot|meteora|thena|biswap|dex/i;
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/i;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const isAddress = (s: string) => EVM_ADDRESS.test(s) || SOLANA_ADDRESS.test(s);

export interface Venue {
  exchange: string;
  identifier: string;
  kind: 'cex' | 'dex';
  usAccess: UsAccess;
  /** Trading pairs as BASE/TARGET; DEX contract addresses are shortened to the coin's symbol. */
  pairs: string[];
  /** Sum of CoinGecko's converted USD volume over this venue's pairs; null when none was given. */
  volumeUsd: number | null;
  /** Best CoinGecko trust score among the pairs ('green' best). */
  trust: 'green' | 'yellow' | 'red' | null;
  /** First https trade link CoinGecko gave, or null. */
  tradeUrl: string | null;
}
export interface WhereToBuy { cex: Venue[]; dex: Venue[]; contracts: string[]; dropped: number; totalMarkets: number }

const TRUST_RANK = { green: 0, yellow: 1, red: 2 } as const;

export class TickersResponseError extends Error {}

/** Groups CoinGecko tickers by exchange. Pure; tolerant of missing fields, strict about shape. */
export function parseTickers(json: unknown, symbol: string): WhereToBuy {
  if (typeof json !== 'object' || json === null || !Array.isArray((json as { tickers?: unknown }).tickers)) {
    throw new TickersResponseError('no tickers list in the response');
  }
  const sym = symbol.toUpperCase();
  const byVenue = new Map<string, Venue>();
  const contracts = new Set<string>();
  let dropped = 0;
  const tickers = (json as { tickers: unknown[] }).tickers;
  for (const t of tickers) {
    if (typeof t !== 'object' || t === null) { dropped++; continue; }
    const x = t as Record<string, any>;
    const name = typeof x.market?.name === 'string' ? x.market.name : null;
    const id = typeof x.market?.identifier === 'string' ? x.market.identifier : null;
    if (!name || !id || typeof x.base !== 'string' || typeof x.target !== 'string' || x.is_stale === true || x.is_anomaly === true) { dropped++; continue; }
    const baseIsAddr = isAddress(x.base);
    const targetIsAddr = isAddress(x.target);
    const kind: 'cex' | 'dex' = DEX_NAME.test(id) || DEX_NAME.test(name) || baseIsAddr ? 'dex' : 'cex';
    if (kind === 'dex' && baseIsAddr) contracts.add(x.base);
    const pair = `${baseIsAddr ? sym : x.base.toUpperCase()}/${targetIsAddr ? 'token' : x.target.toUpperCase()}`;
    const usd = typeof x.converted_volume?.usd === 'number' && Number.isFinite(x.converted_volume.usd) ? x.converted_volume.usd : null;
    const trust = x.trust_score === 'green' || x.trust_score === 'yellow' || x.trust_score === 'red' ? x.trust_score : null;
    const url = typeof x.trade_url === 'string' && /^https:\/\//.test(x.trade_url) ? x.trade_url : null;
    const v = byVenue.get(id) ?? { exchange: name, identifier: id, kind, usAccess: kind === 'dex' ? 'unknown' : US_ACCESS[id] ?? 'unknown', pairs: [], volumeUsd: null, trust: null, tradeUrl: null };
    if (!v.pairs.includes(pair)) v.pairs.push(pair);
    if (usd !== null) v.volumeUsd = (v.volumeUsd ?? 0) + usd;
    if (trust && (v.trust === null || TRUST_RANK[trust] < TRUST_RANK[v.trust])) v.trust = trust;
    v.tradeUrl ??= url;
    byVenue.set(id, v);
  }
  const vol = (v: Venue) => v.volumeUsd ?? -1;
  const all = [...byVenue.values()];
  const cex = all.filter((v) => v.kind === 'cex').sort((a, b) => US_RANK[a.usAccess] - US_RANK[b.usAccess] || vol(b) - vol(a)).slice(0, WTB_MAX_CEX);
  const dex = all.filter((v) => v.kind === 'dex').sort((a, b) => vol(b) - vol(a)).slice(0, WTB_MAX_DEX);
  return { cex, dex, contracts: [...contracts], dropped, totalMarkets: tickers.length };
}

export const WTB_NOTES = {
  crypto: [
    'US access is a fixed list kept in this tool (src/web/where-to-buy.ts), not provider data. Exchange policies change and some states (for example New York) are stricter: check the exchange\'s own terms before signing up.',
    'Volume is CoinGecko\'s USD estimate for the pairs shown. Markets CoinGecko flags as stale or anomalous are left out.',
    'On a decentralized exchange, swap only the exact contract address, confirmed on the coin\'s CoinGecko page: copycat tokens with the same name and symbol are common.',
    'A listing shows where a coin trades, not that it is safe or a good buy.',
  ],
  stocks: [
    'Every stock in this scan\'s list is a large NYSE or Nasdaq listing. Any US brokerage account can buy it (for example Fidelity, Charles Schwab, E*TRADE, Robinhood or Webull); no lookup is needed, so no request was made.',
    'Many brokers allow fractional shares, so a high unit price does not set the minimum you can invest.',
  ],
};

export interface WtbDeps { env: Record<string, string | undefined>; fetch: FetchLike; clock: () => Date; sleep?: (ms: number) => Promise<void> }
export interface WtbRequest { key: string; refresh: boolean; confirmLive: boolean }
export interface WtbReply { status: number; data: Record<string, unknown> }

export function validateWtbRequest(body: string): WtbRequest | { error: string } {
  if (body.length > 1024) return { error: 'Request body too large.' };
  let d: unknown;
  try {
    d = JSON.parse(body);
  } catch {
    return { error: 'Request body must be JSON.' };
  }
  if (typeof d !== 'object' || d === null) return { error: 'Request body must be a JSON object.' };
  const r = d as Record<string, unknown>;
  if (typeof r.key !== 'string' || !/^(crypto|stocks):[A-Za-z0-9._-]{1,80}$/.test(r.key)) return { error: 'key must identify a row of the last scan.' };
  return { key: r.key, refresh: r.refresh === true, confirmLive: r.confirmLive === true };
}

function failureMessage(e: unknown): string {
  if (e instanceof TickersResponseError) return `CoinGecko sent a markets response that could not be used (${e.message}). Try again later.`;
  if (!(e instanceof HttpError)) return 'The markets request failed unexpectedly. Try again later.';
  if (e.status === 401) return `CoinGecko rejected the API key (HTTP 401). Check ${COINGECKO_KEY_ENV}, then restart the dashboard.`;
  if (e.status === 404) return 'CoinGecko has no markets page for this coin id (HTTP 404).';
  if (e.status === 429 || e.kind === 'rate_limited' || e.kind === 'budget') return 'CoinGecko is rate-limiting requests (HTTP 429). Wait a minute, then try again.';
  if (e.kind === 'timeout') return 'The markets request timed out. Check your connection and try again later.';
  if (e.kind === 'network') return 'Could not reach CoinGecko. Check your internet connection, then try again.';
  if (e.kind === 'invalid_json') return 'CoinGecko sent a markets response that was not valid JSON; this is usually temporary.';
  return `CoinGecko returned HTTP ${e.status} for markets${e.status !== null && e.status >= 500 ? '; this is usually temporary' : ''}. Try again later.`;
}

export function createWhereToBuyService(deps: WtbDeps, opts: { getLast: (m: 'crypto' | 'stocks') => LastScan | undefined; scanRunning: () => boolean; fixture?: URL; minIntervalMs?: number }) {
  const cache = new Map<string, { at: number; result: WhereToBuy }>();
  let busy = false;
  let lastLiveAt = -Infinity;
  const minInterval = opts.minIntervalMs ?? WTB_MIN_INTERVAL_MS;
  let fixtureCache: unknown;
  const fixture = () => (fixtureCache ??= JSON.parse(readFileSync(opts.fixture ?? BUNDLED_TICKERS_FIXTURE, 'utf8')));
  const reply = (status: number, data: Record<string, unknown>): WtbReply => ({ status, data: { ok: status === 200, ...data } });

  return {
    get busy() {
      return busy;
    },
    async get(market: 'crypto' | 'stocks', req: WtbRequest): Promise<WtbReply> {
      if (!req.key.startsWith(`${market}:`)) return reply(400, { error: 'The row key does not belong to this market.' });
      const last = opts.getLast(market);
      if (!last) return reply(409, { error: `Run a ${market === 'stocks' ? 'US stock' : 'crypto'} scan first; "where to buy" is available for the assets it evaluated.` });
      const row = last.rows.find((r) => r.key === req.key);
      if (!row) return reply(404, { error: 'That asset is not in the last scan\'s results.' });
      const base = { market, key: row.key, symbol: row.symbol, name: row.name, id: row.id, notes: WTB_NOTES[market] };

      if (market === 'stocks') return reply(200, { ...base, mode: last.mode, source: null, requestsUsed: 0, fromCache: false });

      const page = `https://www.coingecko.com/en/coins/${encodeURIComponent(row.id)}`;
      if (last.mode === 'offline') {
        const result = parseTickers(fixture(), row.symbol);
        return reply(200, { ...base, mode: 'offline', dataKind: 'test_data', source: 'Synthetic tickers fixture (TEST DATA, invented exchanges)', coingeckoPage: null, fetchedAt: last.evaluatedAt, fromCache: false, requestsUsed: 0, result });
      }

      const now = deps.clock();
      const hit = cache.get(row.id);
      const live = { mode: 'live', dataKind: 'verified_market_data', source: WTB_SOURCE, attribution: COINGECKO_ATTRIBUTION, coingeckoPage: page };
      if (hit && now.getTime() - hit.at < WTB_CACHE_TTL_MS && !req.refresh) {
        return reply(200, { ...base, ...live, fetchedAt: new Date(hit.at).toISOString(), fromCache: true, requestsUsed: 0, result: hit.result });
      }
      if (!req.confirmLive) return reply(428, { error: 'Looking up live markets spends 1 CoinGecko request. Confirm to continue.', needsConfirm: true });
      const key = deps.env[COINGECKO_KEY_ENV]?.trim();
      if (!key) return reply(422, { error: `${COINGECKO_KEY_ENV} is not set on the server, so no request was made.` });
      if (opts.scanRunning()) return reply(409, { error: 'A scan is running; market lookups wait until it finishes (they share CoinGecko\'s rate limit).' });
      if (busy) return reply(409, { error: 'A market lookup is already running.' });
      const waitMs = lastLiveAt + minInterval - now.getTime();
      if (waitMs > 0) return reply(429, { error: `To stay under CoinGecko's free-plan limit, wait ${Math.ceil(waitMs / 1000)} s before the next market lookup.` });
      busy = true;
      lastLiveAt = now.getTime();
      const client = createHttpClient({ fetch: deps.fetch, baseUrl: COINGECKO_DEMO_BASE_URL, apiKeyHeader: COINGECKO_KEY_HEADER, apiKey: key, maxCalls: 1, sleep: deps.sleep, maxRetryWaitMs: 0 });
      try {
        const json = await client.getJson(`/coins/${encodeURIComponent(row.id)}/tickers`, { order: 'volume_desc', include_exchange_logo: 'false', depth: 'false' });
        const result = parseTickers(json, row.symbol);
        cache.set(row.id, { at: now.getTime(), result });
        return reply(200, { ...base, ...live, fetchedAt: now.toISOString(), fromCache: false, requestsUsed: client.callsMade, result });
      } catch (e) {
        const message = failureMessage(e).split(key).join('[REDACTED]');
        if (hit) return reply(200, { ...base, ...live, fetchedAt: new Date(hit.at).toISOString(), fromCache: true, requestsUsed: client.callsMade, result: hit.result, warning: `Refresh failed: ${message} Showing the earlier result.` });
        return reply(502, { error: message, requestsUsed: client.callsMade });
      } finally {
        busy = false;
      }
    },
  };
}
export type WhereToBuyService = ReturnType<typeof createWhereToBuyService>;
