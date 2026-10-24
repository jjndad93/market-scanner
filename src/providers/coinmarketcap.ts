/**
 * CoinMarketCap (CMC) adapter, Stage A: ONE listings request, used only as a second source to
 * cross-check the crypto scan's research leads and to read CMC's category tags. No history.
 *
 * Documented facts (official docs and terms, read 2026-10-22; no live call has been made yet):
 * - GET /v3/cryptocurrency/listings/latest: active coins by CMC market-cap rank, paginated with
 *   start/limit, updated every 60 s, "1 call credit per 250 cryptocurrencies returned (rounded
 *   up)". `aux` can add `cmc_rank` and `tags`. Records carry id, name, symbol, slug and
 *   quote.USD.{price, volume_24h, percent_change_24h, market_cap, last_updated}.
 * - Free Basic plan: 15,000 credits/month, 50 requests/minute, 1 key. Auth header X-CMC_PRO_API_KEY.
 * - Errors: 401 (1001 invalid, 1002 missing key), 402 (1003/1004 plan payment), 403 (1005 key
 *   required, 1006 plan does not include the endpoint, 1007 key disabled), 429 (1008 minute,
 *   1009 daily, 1010 monthly limit, 1011 IP limit). The code is in the body's status.error_code.
 * - Terms: prominent attribution "Data provided by CoinMarketCap.com" with a hyperlink; content
 *   may be stored only temporarily, as needed to show it.
 * - Symbols are not unique (CMC's own docs); the CMC id is.
 *
 * Assumptions (to confirm on the first approved live response): the exact v3 response shape
 * matches the documented example; tags arrive as slug strings or {slug, name} objects; the
 * slugs "memes" and "stablecoin" exist. Anything that does not parse is rejected, never guessed.
 */

import { ProviderResponseError } from './coingecko.ts';
import { HttpError, type HttpClient } from './http.ts';
import { cleanText } from './massive-news.ts';

export const CMC_BASE_URL = 'https://pro-api.coinmarketcap.com';
export const CMC_KEY_ENV = 'COINMARKETCAP_API_KEY';
export const CMC_KEY_HEADER = 'X-CMC_PRO_API_KEY';
export const CMC_LISTINGS_PATH = '/v3/cryptocurrency/listings/latest';
/** Top 500 by CMC rank: 2 credits by the documented rule; wide enough to cover CoinGecko's top 250. */
export const CMC_LISTINGS_LIMIT = 500;
export const CMC_ATTRIBUTION = { text: 'Data provided by CoinMarketCap.com', url: 'https://coinmarketcap.com/' } as const;
export const CMC_SOURCE = 'CoinMarketCap API /v3/cryptocurrency/listings/latest (top 500 by CMC rank, USD)';

export interface CmcRecord {
  id: number;
  name: string;
  symbol: string;
  slug: string | null;
  rank: number | null;
  price: number | null;
  marketCap: number | null;
  volume24h: number | null;
  change24hPct: number | null;
  lastUpdated: string | null;
  /** CMC tag slugs (provider classification), capped. */
  tags: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const positive = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
const finite = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const iso = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);

function tagsOf(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const t of v) {
    const raw = typeof t === 'string' ? t : isRecord(t) ? (t.slug ?? t.name) : null;
    const s = cleanText(raw, 60)?.toLowerCase();
    if (s && /^[a-z0-9][a-z0-9 ._-]*$/.test(s) && !out.includes(s)) out.push(s);
    if (out.length >= 30) break;
  }
  return out;
}

/** Listings response -> validated records. Malformed records are skipped and counted. */
export function parseCmcListings(json: unknown): { records: CmcRecord[]; skipped: number; creditCount: number | null; timestamp: string | null } {
  if (!isRecord(json) || !Array.isArray(json.data)) throw new ProviderResponseError('CoinMarketCap listings did not return an object with a data array.');
  const status = isRecord(json.status) ? json.status : {};
  if (typeof status.error_code === 'number' && status.error_code !== 0) {
    throw new ProviderResponseError(`CoinMarketCap reported error code ${status.error_code}.`);
  }
  const records: CmcRecord[] = [];
  let skipped = 0;
  const seen = new Set<number>();
  for (const d of json.data) {
    const id = isRecord(d) && typeof d.id === 'number' && Number.isInteger(d.id) && d.id > 0 ? d.id : null;
    const name = isRecord(d) ? cleanText(d.name, 120) : null;
    const symbol = isRecord(d) ? cleanText(d.symbol, 30) : null;
    if (id === null || name === null || symbol === null || seen.has(id)) {
      skipped++;
      continue;
    }
    seen.add(id);
    const r = d as Record<string, unknown>;
    const usd = isRecord(r.quote) && isRecord(r.quote.USD) ? r.quote.USD : {};
    const slug = cleanText(r.slug, 120);
    const rank = r.cmc_rank;
    records.push({
      id, name, symbol: symbol.toUpperCase(),
      slug: slug && /^[a-z0-9][a-z0-9-]*$/.test(slug) ? slug : null,
      rank: typeof rank === 'number' && Number.isInteger(rank) && rank >= 1 ? rank : null,
      price: positive(usd.price), marketCap: positive(usd.market_cap), volume24h: positive(usd.volume_24h),
      change24hPct: finite(usd.percent_change_24h), lastUpdated: iso(usd.last_updated) ?? iso(r.last_updated),
      tags: tagsOf(r.tags),
    });
  }
  return { records, skipped, creditCount: typeof status.credit_count === 'number' ? status.credit_count : null, timestamp: iso(status.timestamp) };
}

/** One request: the top `limit` coins by CMC rank, with cmc_rank and tags. */
export async function fetchCmcListings(client: HttpClient, limit = CMC_LISTINGS_LIMIT) {
  return parseCmcListings(await client.getJson(CMC_LISTINGS_PATH, { start: '1', limit: String(limit), convert: 'USD', aux: 'cmc_rank,tags' }));
}

/** CMC's machine-readable error code from an error response body, or null. */
export function cmcErrorCode(err: HttpError): number | null {
  if (!err.responseBody) return null;
  try {
    const j = JSON.parse(err.responseBody) as { status?: { error_code?: unknown } };
    return typeof j.status?.error_code === 'number' ? j.status.error_code : null;
  } catch {
    return null;
  }
}

/**
 * A failed request -> a user-facing message, and whether further requests must stop:
 * - 'session': key, payment, plan-access or credit (daily/monthly) problems, or an unexplained
 *   429. Repeating would fail the same way or spend credits; no more requests until restart.
 * - 'minute': the per-minute or IP rate limit (codes 1008, 1011); wait 60 s.
 * - null: a transient problem (timeout, network, server error, malformed response).
 */
export function classifyCmcFailure(err: unknown): { message: string; stop: 'session' | 'minute' | null } {
  if (err instanceof ProviderResponseError) return { message: `CoinMarketCap sent a response that could not be used (${err.message})`, stop: null };
  if (!(err instanceof HttpError)) return { message: 'The CoinMarketCap request failed unexpectedly.', stop: null };
  const code = cmcErrorCode(err);
  const tag = code !== null ? ` (error ${code})` : '';
  if (err.status === 401) return { message: `CoinMarketCap rejected the API key (HTTP 401${tag}). Check ${CMC_KEY_ENV}, then restart the dashboard.`, stop: 'session' };
  if (err.status === 402) return { message: `CoinMarketCap says the key's plan needs payment or activation (HTTP 402${tag}).`, stop: 'session' };
  if (err.status === 403) {
    return { message: code === 1006
      ? 'CoinMarketCap: this key\'s plan does not include the listings endpoint (HTTP 403, error 1006).'
      : `CoinMarketCap refused access (HTTP 403${tag}); the key may be disabled or the plan may not include this endpoint.`, stop: 'session' };
  }
  if (err.status === 429 || err.kind === 'rate_limited' || err.kind === 'budget') {
    if (code === 1008 || code === 1011) return { message: `CoinMarketCap's per-minute rate limit was reached (error ${code}). Wait a minute, then try again.`, stop: 'minute' };
    if (code === 1009 || code === 1010) return { message: `CoinMarketCap's ${code === 1009 ? 'daily' : 'monthly'} credit limit was reached (error ${code}). Cross-checks are stopped so no further credits are requested.`, stop: 'session' };
    return { message: 'CoinMarketCap rate- or credit-limited the request (HTTP 429, no error code). Cross-checks are stopped for this session to avoid spending credits.', stop: 'session' };
  }
  if (err.kind === 'timeout') return { message: 'The CoinMarketCap request timed out. Try again later.', stop: null };
  if (err.kind === 'network') return { message: 'Could not reach CoinMarketCap. Check your internet connection.', stop: null };
  if (err.kind === 'invalid_json') return { message: 'CoinMarketCap sent a response that was not valid JSON.', stop: null };
  return { message: `CoinMarketCap returned HTTP ${err.status}${tag}${err.status !== null && err.status >= 500 ? '; this is usually temporary' : ''}.`, stop: null };
}
