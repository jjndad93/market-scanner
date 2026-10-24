/**
 * News for one dashboard candidate, fetched only when the user opens its news panel.
 *
 * - The asset and its observed move come from the server's own copy of the last scan (the browser
 *   names a row key only), so a page cannot inject a move, a symbol or a time window.
 * - The data mode follows that scan: an offline scan uses the synthetic news fixture (zero
 *   requests); a live scan uses Massive ticker news, exactly ONE request per fetch, with an
 *   explicit browser confirmation, the key only on the server, and the client's 1-call budget.
 * - Results are cached in memory for NEWS_CACHE_TTL_MS (the provider updates hourly); "Refresh"
 *   bypasses the cache and needs confirmation again. Live fetches are spaced like stock scans
 *   (free plan: 5 calls/minute) and refused while a scan runs.
 * - Crypto: no news source is configured (CoinGecko's /news needs a paid plan; alternatives need a
 *   new key). The panel says so and the verdict is "unknown"; nothing is fetched.
 */

import { readFileSync } from 'node:fs';
import { DAY_MS } from '../core/time.ts';
import { type MoveContext, type NewsArticle, type NewsAssessment, assessNews } from '../news/assess.ts';
import { HttpError, type FetchLike, createHttpClient } from '../providers/http.ts';
import { MASSIVE_ATTRIBUTION, MASSIVE_BASE_URL, MASSIVE_KEY_ENV, MASSIVE_KEY_HEADER, MASSIVE_MIN_INTERVAL_MS, MassiveResponseError } from '../providers/massive.ts';
import { MASSIVE_NEWS_SOURCE, fetchMassiveNews, parseMassiveNews } from '../providers/massive-news.ts';
import type { Discovery } from '../scanner/types.ts';
import type { DashboardRow } from './rows.ts';

export const NEWS_DEFAULT_LIMIT = 5;
export const NEWS_MAX_LIMIT = 20;
export const NEWS_CACHE_TTL_MS = 60 * 60_000;
/** Articles older than this before the move window are not requested. */
export const NEWS_LOOKBACK_DAYS = 60;
export const BUNDLED_STOCK_NEWS_FIXTURE = new URL('../../test/fixtures/stock-news.synthetic.json', import.meta.url);

export const NEWS_COVERAGE = {
  stocks: [
    'Live source: Massive ticker news (/v2/reference/news), included in the free Stocks Basic plan; the provider updates it hourly.',
    'Only articles the provider tagged with this ticker are shown; the newest ones first, up to the limit.',
    'The tool reads headlines and the provider\'s descriptions only, never the full article. Summaries are the publisher\'s or provider\'s text, not verified.',
    'Sentiment, when shown, is the provider\'s automated (AI-generated) label; it is used only to detect disagreement.',
  ],
  crypto: [
    'No crypto news source is configured. CoinGecko\'s /news endpoint needs a paid plan (Analyst or higher; the free Demo key used here excludes it), and the other documented crypto news APIs need a new key or a paid plan.',
    'Adding one needs your approval; until then the reason for a crypto move is shown as unknown.',
  ],
};

export interface LastScan { mode: 'offline' | 'live'; rows: DashboardRow[]; evaluatedAt: string; /** Crypto only: the scan's research leads. */ discovery?: Discovery }
export interface NewsDeps {
  env: Record<string, string | undefined>;
  fetch: FetchLike;
  clock: () => Date;
  sleep?: (ms: number) => Promise<void>;
}
export interface NewsRequest { key: string; limit: number; refresh: boolean; confirmLive: boolean }
export interface NewsReply { status: number; data: Record<string, unknown> }

interface CacheEntry { at: number; articles: NewsArticle[]; skipped: number }

/** Validates a news request body; the market comes from the route. */
export function validateNewsRequest(body: string): NewsRequest | { error: string } {
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
  const limit = r.limit === undefined ? NEWS_DEFAULT_LIMIT : r.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > NEWS_MAX_LIMIT) return { error: `limit must be a whole number from 1 to ${NEWS_MAX_LIMIT}.` };
  return { key: r.key, limit, refresh: r.refresh === true, confirmLive: r.confirmLive === true };
}

function failureMessage(e: unknown): string {
  if (e instanceof MassiveResponseError) return `Massive sent a news response that could not be used (${e.message}). Try again later.`;
  if (!(e instanceof HttpError)) return 'The news request failed unexpectedly. Try again later.';
  if (e.status === 401) return `Massive rejected the API key (HTTP 401). Check ${MASSIVE_KEY_ENV}, then restart the dashboard.`;
  if (e.status === 403) return 'Massive refused access to news (HTTP 403). Its docs list ticker news in all Stocks plans, including the free one; check the key\'s plan.';
  if (e.status === 429 || e.kind === 'rate_limited') return 'Massive is rate-limiting requests (HTTP 429; the free plan allows 5 per minute, shared with stock scans). Wait a minute, then refresh.';
  if (e.kind === 'budget') return 'The single allowed news request was used (a rate-limit retry would need another). Wait a minute, then refresh.';
  if (e.kind === 'timeout') return 'The news request timed out. Check your connection and try again later.';
  if (e.kind === 'network') return 'Could not reach Massive. Check your internet connection, then try again.';
  if (e.kind === 'invalid_json') return 'Massive sent a news response that was not valid JSON; this is usually temporary.';
  return `Massive returned HTTP ${e.status} for news${e.status !== null && e.status >= 500 ? '; this is usually temporary' : ''}. Try again later.`;
}

export function createNewsService(deps: NewsDeps, opts: { getLast: (m: 'crypto' | 'stocks') => LastScan | undefined; scanRunning: () => boolean; fixture?: URL; minIntervalMs?: number }) {
  const cache = new Map<string, CacheEntry>();
  let busy = false;
  let lastLiveAt = -Infinity;
  const minInterval = opts.minIntervalMs ?? MASSIVE_MIN_INTERVAL_MS;
  let fixtureCache: unknown;
  const fixture = () => (fixtureCache ??= JSON.parse(readFileSync(opts.fixture ?? BUNDLED_STOCK_NEWS_FIXTURE, 'utf8')));

  const reply = (status: number, data: Record<string, unknown>): NewsReply => ({ status, data: { ok: status === 200, ...data } });
  const result = (market: 'crypto' | 'stocks', row: DashboardRow, move: MoveContext, assessment: NewsAssessment, extra: Record<string, unknown>) =>
    reply(200, { market, key: row.key, symbol: row.symbol, name: row.name, assessment, coverage: NEWS_COVERAGE[market], move, ...extra });

  return {
    get busy() {
      return busy;
    },
    async get(market: 'crypto' | 'stocks', req: NewsRequest): Promise<NewsReply> {
      if (!req.key.startsWith(`${market}:`)) return reply(400, { error: 'The row key does not belong to this market.' });
      const last = opts.getLast(market);
      if (!last) return reply(409, { error: `Run a ${market === 'stocks' ? 'US stock' : 'crypto'} scan first; news is available for the assets it evaluated.` });
      const row = last.rows.find((r) => r.key === req.key);
      if (!row) return reply(404, { error: 'That asset is not in the last scan\'s results.' });
      if (!row.move) return reply(422, { error: 'This asset has no usable price time, so its move cannot be placed in time.' });
      const move = row.move;

      if (market === 'crypto') {
        return result(market, row, move, assessNews(move, null, new Date(last.evaluatedAt)), { mode: last.mode, source: null, fetchedAt: null, fromCache: false, requestsUsed: 0, limit: req.limit });
      }

      const since = new Date(Date.parse(move.windowStart) - NEWS_LOOKBACK_DAYS * DAY_MS);
      if (last.mode === 'offline') {
        // Emulates the provider's filters (ticker tag, date, newest first, limit) over the TEST DATA fixture.
        const now = new Date(last.evaluatedAt);
        const parsed = parseMassiveNews(fixture(), row.symbol, now);
        const articles = parsed.articles.filter((a) => a.tickers.includes(row.symbol) && (a.publishedUtc === null || Date.parse(a.publishedUtc) >= since.getTime()))
          .sort((x, y) => (Date.parse(y.publishedUtc ?? '') || 0) - (Date.parse(x.publishedUtc ?? '') || 0)).slice(0, req.limit);
        return result(market, row, move, assessNews(move, articles, now), {
          mode: 'offline', dataKind: 'test_data', source: 'Synthetic news fixture (TEST DATA, invented articles)', fetchedAt: last.evaluatedAt, fromCache: false, requestsUsed: 0, limit: req.limit, skipped: parsed.skipped,
        });
      }

      const now = deps.clock();
      const cacheKey = `${row.symbol}|${req.limit}`;
      const hit = cache.get(cacheKey);
      const fresh = hit !== undefined && now.getTime() - hit.at < NEWS_CACHE_TTL_MS;
      const live = { mode: 'live', dataKind: 'verified_market_data', source: MASSIVE_NEWS_SOURCE, attribution: MASSIVE_ATTRIBUTION, limit: req.limit };
      if (fresh && !req.refresh) {
        return result(market, row, move, assessNews(move, hit.articles, now), { ...live, fetchedAt: new Date(hit.at).toISOString(), fromCache: true, requestsUsed: 0, skipped: hit.skipped });
      }
      if (!req.confirmLive) return reply(428, { error: 'Fetching live news spends 1 Massive request. Confirm to continue.', needsConfirm: true });
      const key = deps.env[MASSIVE_KEY_ENV]?.trim();
      if (!key) return reply(422, { error: `${MASSIVE_KEY_ENV} is not set on the server, so no news request was made.` });
      if (opts.scanRunning()) return reply(409, { error: 'A scan is running; news requests wait until it finishes (they share the provider\'s rate limit).' });
      if (busy) return reply(409, { error: 'A news request is already running.' });
      const waitMs = lastLiveAt + minInterval - now.getTime();
      if (waitMs > 0) return reply(429, { error: `To stay under Massive's free-plan limit (5 requests per minute), wait ${Math.ceil(waitMs / 1000)} s before the next news request.` });
      busy = true;
      lastLiveAt = now.getTime();
      try {
        const client = createHttpClient({ fetch: deps.fetch, baseUrl: MASSIVE_BASE_URL, apiKeyHeader: MASSIVE_KEY_HEADER, apiKey: `Bearer ${key}`, maxCalls: 1, sleep: deps.sleep,
          // One call only: a 429 retry could never be sent, so fail at once instead of waiting.
          maxRetryWaitMs: 0 });
        try {
          const got = await fetchMassiveNews(client, row.symbol, req.limit, since, now);
          cache.set(cacheKey, { at: now.getTime(), articles: got.articles, skipped: got.skipped });
          return result(market, row, move, assessNews(move, got.articles, now), { ...live, fetchedAt: now.toISOString(), fromCache: false, requestsUsed: client.callsMade, skipped: got.skipped });
        } catch (e) {
          // Keep showing an older cached result if there is one, clearly marked.
          const message = failureMessage(e).split(key).join('[REDACTED]');
          if (hit) {
            return result(market, row, move, assessNews(move, hit.articles, now), { ...live, fetchedAt: new Date(hit.at).toISOString(), fromCache: true, requestsUsed: client.callsMade, skipped: hit.skipped, warning: `Refresh failed: ${message} Showing the earlier result.` });
          }
          return reply(502, { error: message, requestsUsed: client.callsMade });
        }
      } finally {
        busy = false;
      }
    },
  };
}
export type NewsService = ReturnType<typeof createNewsService>;
