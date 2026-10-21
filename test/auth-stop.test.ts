import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COINGECKO_INFO, authStopReason } from '../src/core/errors.ts';
import { DAY_MS, nyWallTimeToUtc } from '../src/core/time.ts';
import { fetchLiveDataset } from '../src/providers/coingecko.ts';
import { type HistoryCache, isFreshHistory } from '../src/providers/history-cache.ts';
import { type FetchLike, HttpError, createHttpClient } from '../src/providers/http.ts';
import { fetchStockDataset } from '../src/providers/massive.ts';
import { runScan } from '../src/scanner/analyze.ts';
import { normalizeDataset } from '../src/scanner/normalize.ts';
import { renderScanReport } from '../src/scanner/render.ts';
import { runStockScan } from '../src/stocks/analyze.ts';
import { normalizeStockDataset } from '../src/stocks/normalize.ts';
import { renderStockReport } from '../src/stocks/render.ts';

// Network guard: every request goes through an injected mock fetch.
globalThis.fetch = (() => {
  throw new Error('Network access is not allowed in tests.');
}) as typeof fetch;

// SYNTHETIC response-shaped data: invented coins, tickers and numbers.
const NOW = new Date('2026-10-21T12:00:00Z');
const TODAY = Date.UTC(2026, 9, 21);
const KEY = 'TEST-AUTH-KEY-not-real-999';
type Route = { status: number; body?: unknown; headers?: Record<string, string> };
function router(route: (url: string) => Route) {
  const urls: string[] = [];
  const fn: FetchLike = async (url) => {
    urls.push(url);
    const r = route(url);
    return { ok: r.status < 300, status: r.status, headers: { get: (h: string) => r.headers?.[h.toLowerCase()] ?? null }, text: async () => (r.body === undefined ? '' : JSON.stringify(r.body)) };
  };
  return { fn, urls };
}
const client = (fn: FetchLike, maxCalls: number) => createHttpClient({ fetch: fn, baseUrl: 'https://api.example.test', apiKeyHeader: 'h', apiKey: KEY, maxCalls, sleep: async () => {} });

// ---- crypto ------------------------------------------------------------------------------------
const coin = (id: string) => ({
  id, symbol: id.slice(4), name: `Synthetic ${id}`, current_price: 5, market_cap: 1e9, total_volume: 50e6,
  price_change_percentage_24h: 10, price_change_percentage_7d_in_currency: 12, last_updated: '2026-10-21T11:57:00.000Z',
});
const MARKETS = ['syn-a', 'syn-b', 'syn-c', 'syn-d'].map(coin);
const chart = () => ({ total_volumes: Array.from({ length: 91 }, (_, i) => [TODAY - (91 - i) * DAY_MS, Math.round(20e6 * (i % 2 ? 1.05 : 0.95))]) });
const coinOf = (url: string) => /\/coins\/([^/]+)\/market_chart/.exec(url)?.[1];
async function crypto(history: (id: string) => Route, maxCalls = 160, historyCache?: HistoryCache) {
  const r = router((url) => (url.includes('/coins/markets') ? { status: 200, body: MARKETS } : history(coinOf(url)!)));
  const c = client(r.fn, maxCalls);
  const data = await fetchLiveDataset({ client: c, clock: () => NOW, maxCalls, sleep: async () => {}, historyCache });
  return { data, urls: r.urls, used: c.callsMade };
}

test('crypto: a 401 on the first history request stops every later request; nothing is retried', async () => {
  const { data, urls, used } = await crypto(() => ({ status: 401, headers: { 'retry-after': '0' } }));
  assert.deepEqual(urls.map((u) => coinOf(u) ?? 'markets'), ['markets', 'syn-a']); // no retry, no further coins
  assert.equal(used, 2);
  const c = data.dataset.coverage;
  assert.deepEqual([c.historyFetched, c.historyRequestFailed, c.historyNotRequested, c.requestsUsed], [0, 1, 3, 2]);
  assert.match(c.stopReason!, /^CoinGecko rejected the API key \(HTTP 401\), so the remaining requests were not sent .* check COINGECKO_DEMO_API_KEY and your CoinGecko account$/);
  assert.ok(data.dataset.notes.some((n) => n.includes('History not requested for 3 asset(s) (syn-b, syn-c, syn-d) because CoinGecko rejected the API key (HTTP 401)')));
  const report = renderScanReport(runScan(normalizeDataset(data), NOW)).replace(/\s+/g, ' ');
  assert.match(report, /PARTIAL SCAN/);
  assert.match(report, /Status: PARTIAL - 3 eligible asset\(s\) not evaluated because CoinGecko rejected the API key \(HTTP 401\)/);
  assert.ok(!report.includes(KEY));
});

test('crypto: a 403 on a later request stops the rest; data already fetched is kept', async () => {
  const { data, urls } = await crypto((id) => (id === 'syn-b' ? { status: 403 } : { status: 200, body: chart() }));
  assert.deepEqual(urls.map((u) => coinOf(u) ?? 'markets'), ['markets', 'syn-a', 'syn-b']);
  const c = data.dataset.coverage;
  assert.deepEqual([c.historyFetched, c.historyRequestFailed, c.historyNotRequested, c.requestsUsed], [1, 1, 2, 3]);
  assert.match(c.stopReason!, /CoinGecko refused access \(HTTP 403\).* check your CoinGecko plan and permissions/);
  const r = runScan(normalizeDataset(data), NOW);
  assert.deepEqual(r.movers.map((m) => m.asset.id), ['syn-a']); // the valid history fetched before the 403 is used
});

test('crypto: cached histories cost no request and stay usable after an authentication stop', async () => {
  const fresh = { fetchedAt: '2026-10-21T08:00:00.000Z', totalVolumes: chart().total_volumes };
  const store = new Map([['syn-c|91', fresh], ['syn-d|91', fresh]]);
  const cache: HistoryCache = { get: (id, days, now) => { const e = store.get(`${id}|${days}`); return e && isFreshHistory(new Date(e.fetchedAt), now) ? e : null; }, set: () => true };
  const { data, urls } = await crypto(() => ({ status: 401 }), 160, cache);
  assert.deepEqual(urls.map((u) => coinOf(u) ?? 'markets'), ['markets', 'syn-a']); // syn-b never requested; syn-c/d from cache
  const c = data.dataset.coverage;
  assert.deepEqual([c.historyFetched, c.historyFromCache, c.historyRequestFailed, c.historyNotRequested], [2, 2, 1, 1]);
  assert.match(c.stopReason!, /HTTP 401/);
});

test('crypto: rate limits, server errors and timeouts keep their existing handling (not auth stops)', async () => {
  const fiveHundred = await crypto((id) => (id === 'syn-a' ? { status: 500 } : { status: 200, body: chart() }));
  assert.equal(fiveHundred.urls.length, 5); // a 500 on one coin does not stop the others
  assert.equal(fiveHundred.data.dataset.coverage.historyNotRequested, 0);
  const limited = await crypto((id) => (id === 'syn-a' ? { status: 429 } : { status: 200, body: chart() }));
  assert.equal(limited.data.dataset.coverage.stopReason, 'the provider rate-limited the run');
  assert.equal(authStopReason(new HttpError('rate_limited', '/x', 'm', 429), COINGECKO_INFO), null);
  assert.equal(authStopReason(new HttpError('timeout', '/x', 'm'), COINGECKO_INFO), null);
  assert.equal(authStopReason(new HttpError('network', '/x', 'm'), COINGECKO_INFO), null);
  assert.equal(authStopReason(new HttpError('invalid_json', '/x', 'm', 401), COINGECKO_INFO), null); // a 200-ish bad body is not auth
  assert.equal(authStopReason(new HttpError('http', '/x', 'm', 404), COINGECKO_INFO), null);
});

// ---- stocks ------------------------------------------------------------------------------------
const UNIVERSE = ['AAA', 'BBB', 'CCC', 'DDD'];
function bars() {
  const out: { t: number; c: number; v: number }[] = [];
  for (let t = Date.parse('2026-10-20T00:00:00Z'); out.length < 26; t -= DAY_MS) {
    const d = new Date(t).getUTCDay();
    if (d !== 0 && d !== 6) out.unshift({ t: nyWallTimeToUtc(new Date(t).toISOString().slice(0, 10), 0, 0).getTime(), c: 100, v: 5e6 });
  }
  return { status: 'OK', results: out };
}
const tickerOf = (url: string) => /\/ticker\/([^/]+)\//.exec(url)![1]!;
async function stocks(route: (t: string) => Route, maxCalls = 10) {
  const r = router((url) => route(tickerOf(url)));
  const c = client(r.fn, maxCalls);
  const data = await fetchStockDataset({ client: c, clock: () => NOW, universe: UNIVERSE, maxCalls, sleep: async () => {} });
  return { data, urls: r.urls, used: c.callsMade };
}

test('stocks: a 401 on the first request stops every later request; nothing is retried', async () => {
  const { data, urls, used } = await stocks(() => ({ status: 401, headers: { 'retry-after': '0' } }));
  assert.deepEqual(urls.map(tickerOf), ['AAA']);
  assert.equal(used, 1);
  assert.deepEqual(data.stocks.map((s) => s.historyStatus), ['request_failed', 'not_requested', 'not_requested', 'not_requested']);
  const notes = data.dataset.notes.join(' ');
  assert.match(notes, /1 of 10 allowed requests used/);
  assert.match(notes, /Daily bars not requested for 3 ticker\(s\) \(BBB, CCC, DDD\) because Massive rejected the API key \(HTTP 401\), so the remaining requests were not sent .* check POLYGON_API_KEY and your Massive account/);
  const report = renderStockReport(runStockScan(normalizeStockDataset(data), NOW)).replace(/\s+/g, ' ');
  assert.match(report, /Universe: 4 tickers; 0 passed all filters; 4 excluded \(4 not evaluated: bars not requested or failed\)\. PARTIAL SCAN\./);
  assert.ok(!report.includes(KEY));
});

test('stocks: a 403 on a later request stops the rest; bars already fetched are kept', async () => {
  const { data, urls } = await stocks((t) => (t === 'BBB' ? { status: 403 } : { status: 200, body: bars() }));
  assert.deepEqual(urls.map(tickerOf), ['AAA', 'BBB']);
  assert.deepEqual(data.stocks.map((s) => s.historyStatus ?? 'fetched'), ['fetched', 'request_failed', 'not_requested', 'not_requested']);
  assert.match(data.dataset.notes.join(' '), /because Massive refused access \(HTTP 403\).* check your Massive plan and permissions/);
  assert.equal(runStockScan(normalizeStockDataset(data), NOW).passedFilters, 1); // AAA's real bars are still evaluated
});

test('stocks: an ordinary per-ticker failure does not stop the scan', async () => {
  const { urls } = await stocks((t) => (t === 'AAA' ? { status: 404 } : { status: 200, body: bars() }));
  assert.deepEqual(urls.map(tickerOf), ['AAA', 'BBB', 'CCC', 'DDD']);
});
