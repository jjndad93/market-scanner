import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DAY_MS } from '../src/core/time.ts';
import { COINGECKO_ATTRIBUTION, ProviderResponseError, classifyPoint, describeHistory, fetchLiveDataset, parseDailyVolumes, parseMarkets } from '../src/providers/coingecko.ts';
import { type HistoryCache, isFreshHistory } from '../src/providers/history-cache.ts';
import { type FetchLike, createHttpClient } from '../src/providers/http.ts';
import { runScan } from '../src/scanner/analyze.ts';
import { normalizeDataset } from '../src/scanner/normalize.ts';
import { renderScanReport } from '../src/scanner/render.ts';

// Network guard: every request below goes through an injected mock fetch.
globalThis.fetch = (() => {
  throw new Error('Network access is not allowed in tests.');
}) as typeof fetch;

// SYNTHETIC response-shaped data: invented coins and numbers in CoinGecko's documented format.
const NOW = new Date('2026-10-21T12:00:00Z');
const TODAY = Date.UTC(2026, 9, 21);
const KEY = 'TEST-KEY-not-real-abcdef';

const coin = (o: Record<string, unknown>) => ({
  id: 'syn-coin', symbol: 'syn', name: 'Synthetic Coin', current_price: 5, market_cap: 1e9, total_volume: 50e6,
  price_change_percentage_24h: 10, price_change_percentage_7d_in_currency: 12, last_updated: '2026-10-21T11:57:00.000Z', ...o,
});
/** Daily points for the `days` completed UTC days before today, oldest first, plus a trailing "now" point. */
const chart = (base: number, days = 91) => ({
  prices: [],
  total_volumes: [
    ...Array.from({ length: days }, (_, i) => [TODAY - (days - i) * DAY_MS, Math.round(base * (i % 2 ? 1.05 : 0.95))]),
    [NOW.getTime() - 60_000, base * 3],
  ],
});

type Route = { status: number; body?: unknown; headers?: Record<string, string> };
function router(routes: (url: string) => Route) {
  const urls: string[] = [];
  const fn: FetchLike = async (url) => {
    urls.push(url);
    const r = routes(url);
    return { ok: r.status < 300, status: r.status, headers: { get: (n: string) => r.headers?.[n.toLowerCase()] ?? null }, text: async () => (r.body === undefined ? '' : JSON.stringify(r.body)) };
  };
  return { fn, urls };
}
const historyCalls = (urls: string[]) => urls.filter((u) => u.includes('/market_chart'));

async function live(markets: unknown, history: (id: string) => Route, maxCalls = 160) {
  const r = router((url) => {
    if (url.includes('/coins/markets')) return { status: 200, body: markets };
    const id = decodeURIComponent(/\/coins\/([^/]+)\/market_chart/.exec(url)![1]!);
    return history(id);
  });
  const client = createHttpClient({ fetch: r.fn, baseUrl: 'https://api.example.test/api/v3', apiKeyHeader: 'x-cg-demo-api-key', apiKey: KEY, maxCalls, sleep: async () => {} });
  const data = await fetchLiveDataset({ client, clock: () => NOW, maxCalls, sleep: async () => {} });
  return { data, urls: r.urls };
}
const scan = (data: Awaited<ReturnType<typeof live>>['data']) => runScan(normalizeDataset(data), NOW);

// ---- S2: parsers ------------------------------------------------------------------------------

test('parseMarkets maps documented fields one-to-one and passes values through unchanged', () => {
  const [a] = parseMarkets([coin({ current_price: 'abc' })]);
  assert.deepEqual(a, {
    id: 'syn-coin', symbol: 'syn', name: 'Synthetic Coin', price: 'abc', change24hPct: 10, change7dPct: 12,
    volume24h: 50e6, marketCap: 1e9, lastUpdated: '2026-10-21T11:57:00.000Z', dailyVolumes: null, tags: [],
  });
  // The invalid price is reported by the normalizer, not replaced.
  const n = normalizeDataset({ dataset: { kind: 'live', label: 'l', source: 's', asOf: NOW.toISOString(), attribution: 'a' }, assets: [a] });
  assert.match(n.assets[0]!.price.note!, /invalid \(abc/);
});

test('parseMarkets rejects a non-array response and keeps malformed entries as invalid records', () => {
  assert.throws(() => parseMarkets({ error: 'x' }), ProviderResponseError);
  const assets = parseMarkets([coin({}), 'junk', null]);
  const n = normalizeDataset({ dataset: { kind: 'live', label: 'l', source: 's', asOf: NOW.toISOString(), attribution: 'a' }, assets });
  assert.equal(n.assets.length, 1);
  assert.equal(n.invalid.length, 2);
});

test('parseDailyVolumes keeps completed UTC days only, oldest first, and reports what it dropped', () => {
  const d = (n: number) => TODAY - n * DAY_MS;
  const { volumes, stats } = parseDailyVolumes({
    total_volumes: [
      [d(1), 30], [d(3), 10], [d(2), 20], // unsorted
      [d(2), 20], // identical duplicate
      [d(4), 5], [d(4), 6], // conflicting duplicate
      [d(7), 1], // gap of days 6 and 5
      [d(1) + 3_600_000, 99], // not at 00:00 UTC
      [TODAY, 77], [NOW.getTime(), 88], // current, incomplete UTC day
      ['x', 1], [5], 'bad', // malformed
    ],
  }, NOW);
  assert.deepEqual(volumes, [1, null, null, null, 10, 20, 30]);
  // S7a: the old `currentDay: 2` is split into today-at-00:00 (TODAY) and later today (NOW);
  // the old `notAtMidnight` is renamed `priorIntraday`; accepted 00:00 points are counted too.
  assert.deepEqual(stats, { points: 13, invalid: 3, priorMidnight: 7, priorIntraday: 1, todayMidnight: 1, todayAfterMidnight: 1, future: 0, duplicates: 1, conflicts: 1, gaps: 2, missingRecent: 0 });
});

test('parseDailyVolumes counts missing recent days up to yesterday, so a stale history cannot look current', () => {
  // 35 daily points ending N days before today (N = 1 means the last point is yesterday 00:00 UTC).
  const ending = (daysAgo: number) => ({ total_volumes: Array.from({ length: 35 }, (_, i) => [TODAY - (daysAgo + 34 - i) * DAY_MS, 20e6]) });
  const fresh = parseDailyVolumes(ending(1), NOW);
  assert.equal(fresh.stats.missingRecent, 0);
  assert.equal(fresh.volumes.at(-1), 20e6);
  const twoDays = parseDailyVolumes(ending(3), NOW);
  assert.equal(twoDays.stats.missingRecent, 2);
  assert.deepEqual(twoDays.volumes.slice(-3), [20e6, null, null]);
  // A history that stopped 40 days ago must not produce a usable baseline.
  const stale = parseDailyVolumes(ending(40), NOW);
  const r = runScan(normalizeDataset({ dataset: { kind: 'live', label: 'l', source: 's', asOf: NOW.toISOString(), attribution: 'a' }, assets: [{ ...parseMarkets([coin({})])[0]!, dailyVolumes: stale.volumes }] }), NOW);
  assert.equal(r.movers.length, 0);
  assert.ok(r.excluded[0]!.reasons.some((x) => x.code === 'unreliable_history'), JSON.stringify(r.excluded));
});

test('parseDailyVolumes passes invalid values through for the normalizer and rejects a malformed body', () => {
  const { volumes } = parseDailyVolumes({ total_volumes: [[TODAY - DAY_MS, 'n/a']] }, NOW);
  assert.deepEqual(volumes, ['n/a']);
  assert.throws(() => parseDailyVolumes({ prices: [] }, NOW), ProviderResponseError);
  assert.throws(() => parseDailyVolumes([], NOW), ProviderResponseError);
});

// ---- S4: provider assembly --------------------------------------------------------------------

test('a live run requests history only for assets that pass the non-history filters', async () => {
  const markets = [
    coin({ id: 'syn-mover', symbol: 'smv', total_volume: 50e6 }),
    coin({ id: 'tether', symbol: 'usdt', current_price: 1, price_change_percentage_24h: 0.01, price_change_percentage_7d_in_currency: 0 }),
    coin({ id: 'syn-small', symbol: 'ssm', market_cap: 5e6 }),
  ];
  const { data, urls } = await live(markets, () => ({ status: 200, body: chart(20e6) }));
  assert.deepEqual(historyCalls(urls).map((u) => /coins\/([^/]+)\//.exec(u)![1]), ['syn-mover']);
  // Exact requests: documented daily (00:00 UTC) auto-granularity needs days > 90 and NO interval.
  assert.equal(urls[0], 'https://api.example.test/api/v3/coins/markets?order=market_cap_desc&page=1&per_page=250&price_change_percentage=24h%2C7d&sparkline=false&vs_currency=usd');
  assert.deepEqual(historyCalls(urls), ['https://api.example.test/api/v3/coins/syn-mover/market_chart?days=91&vs_currency=usd']);
  assert.equal(data.dataset.kind, 'live');
  assert.equal(data.dataset.attribution, COINGECKO_ATTRIBUTION);
  const r = scan(data);
  assert.deepEqual(r.movers.map((c) => c.asset.id), ['syn-mover']);
  assert.equal(r.movers[0]!.asset.price.kind, 'verified_market_data');
  assert.equal(r.movers[0]!.asset.dailyVolumes.length, 30); // 91 completed days supplied, last 30 used
  assert.deepEqual([r.movers[0]!.asset.history.supplied, r.movers[0]!.asset.history.windowDays], [91, 30]);
  assert.deepEqual(r.excluded.map((e) => [e.id, e.reasons[0]!.code]), [['syn-small', 'below_market_cap'], ['tether', 'stablecoin']]);
  // Complete coverage: the one eligible asset's history was fetched.
  assert.deepEqual(data.dataset.coverage, {
    historyEligible: 1, historyFetched: 1, historyFromCache: 0, historyRequestFailed: 0, historyNotRequested: 0, complete: true, stopReason: null, requestsUsed: 2, requestLimit: 160,
  });
  assert.ok(data.assets.every((a) => !('historyStatus' in a)));
});

/** Every eligible asset is counted exactly once, and the per-asset statuses match the counts. */
function assertCoverageAddsUp(data: Awaited<ReturnType<typeof live>>['data']) {
  const c = data.dataset.coverage;
  assert.equal(c.historyFetched + c.historyRequestFailed + c.historyNotRequested, c.historyEligible);
  const withStatus = (s: string) => new Set(data.assets.filter((a) => a.historyStatus === s).map((a) => a.id)).size;
  assert.equal(withStatus('request_failed'), c.historyRequestFailed);
  assert.equal(withStatus('not_requested'), c.historyNotRequested);
}

test('a failed history request leaves that asset without history; nothing is invented', async () => {
  const markets = [coin({ id: 'syn-a' }), coin({ id: 'syn-b', symbol: 'sb' })];
  const { data } = await live(markets, (id) => (id === 'syn-a' ? { status: 500 } : { status: 200, body: chart(20e6) }));
  const r = scan(data);
  assert.deepEqual(r.movers.map((c) => c.asset.id), ['syn-b']);
  // A failed request is not "too little history": the asset was not evaluated.
  assert.deepEqual(r.excluded.map((e) => [e.id, e.reasons.map((x) => x.code)]), [['syn-a', ['history_request_failed']]]);
  assert.ok(data.dataset.notes.some((n) => /History request failed for 1 asset\(s\) \(syn-a\)/.test(n)), data.dataset.notes.join(' | '));
  assert.deepEqual(data.dataset.coverage, {
    historyEligible: 2, historyFetched: 1, historyFromCache: 0, historyRequestFailed: 1, historyNotRequested: 0, complete: false, stopReason: null, requestsUsed: 3, requestLimit: 160,
  });
  assertCoverageAddsUp(data);
});

test('a malformed history body, or too little history, leaves the asset excluded with nothing invented', async () => {
  const markets = [coin({ id: 'syn-bad' }), coin({ id: 'syn-short', symbol: 'ssh' }), coin({ id: 'syn-ok', symbol: 'sok' })];
  const { data } = await live(markets, (id) =>
    id === 'syn-bad' ? { status: 200, body: { prices: [] } } // no total_volumes
      : id === 'syn-short' ? { status: 200, body: chart(20e6, 10) } // only 10 completed days
        : { status: 200, body: chart(20e6) });
  const r = scan(data);
  assert.deepEqual(r.movers.map((c) => c.asset.id), ['syn-ok']);
  const reasons = Object.fromEntries(r.excluded.map((e) => [e.id, e.reasons.map((x) => x.code)]));
  // No usable volume data counts as a failed request; a genuinely short series is "too little history".
  assert.deepEqual(reasons['syn-bad'], ['history_request_failed']);
  assert.deepEqual(reasons['syn-short'], ['insufficient_history']);
  // historyFetched means obtained and parsed: syn-short counts as fetched even though it is too short.
  assert.deepEqual([data.dataset.coverage.historyFetched, data.dataset.coverage.historyRequestFailed, data.dataset.coverage.complete], [2, 1, false]);
  assertCoverageAddsUp(data);
  assert.ok(data.dataset.notes.some((n) => n.includes('History request failed for 1 asset(s) (syn-bad)')), data.dataset.notes.join(' | '));
  // The short series really did supply only its own 10 days (no padding with invented values).
  const short = data.assets.find((a) => a.id === 'syn-short')!;
  assert.deepEqual(short.dailyVolumes!.length, 10);
});

test('a rate limit on history stops further history requests and is reported', async () => {
  const markets = ['a', 'b', 'c'].map((x) => coin({ id: `syn-${x}`, symbol: `s${x}` }));
  const { data, urls } = await live(markets, (id) => (id === 'syn-a' ? { status: 200, body: chart(20e6) } : { status: 429 }));
  assert.equal(historyCalls(urls).length, 2); // syn-a ok, syn-b 429 without Retry-After, syn-c never requested
  // Remediation F1: syn-b WAS requested (it got a 429), so it is reported as failed, not "not requested".
  assert.ok(data.dataset.notes.some((n) => n.includes('History request failed for 1 asset(s) (syn-b)')), data.dataset.notes.join(' | '));
  assert.ok(data.dataset.notes.some((n) => n.includes('History not requested for 1 asset(s) (syn-c) because the provider rate-limited the run')), data.dataset.notes.join(' | '));
  const codes = Object.fromEntries(scan(data).excluded.map((e) => [e.id, e.reasons.map((x) => x.code)]));
  assert.deepEqual([codes['syn-b'], codes['syn-c']], [['history_request_failed'], ['history_not_requested']]);
  assert.deepEqual(data.dataset.coverage, {
    historyEligible: 3, historyFetched: 1, historyFromCache: 0, historyRequestFailed: 1, historyNotRequested: 1, complete: false, stopReason: 'the provider rate-limited the run', requestsUsed: 3, requestLimit: 160,
  });
  assertCoverageAddsUp(data);
});

test('a rate limit on the last eligible asset leaves nothing unrequested, so stopReason is null', async () => {
  const markets = ['a', 'b'].map((x) => coin({ id: `syn-${x}`, symbol: `s${x}` }));
  const { data } = await live(markets, (id) => (id === 'syn-a' ? { status: 200, body: chart(20e6) } : { status: 429 }));
  assert.deepEqual(data.dataset.coverage, {
    historyEligible: 2, historyFetched: 1, historyFromCache: 0, historyRequestFailed: 1, historyNotRequested: 0, complete: false, stopReason: null, requestsUsed: 3, requestLimit: 160,
  });
  assertCoverageAddsUp(data);
  scan(data); // the normalizer accepts it
});

test('the per-run request cap is enforced and reported', async () => {
  const markets = ['a', 'b', 'c', 'd', 'e'].map((x) => coin({ id: `syn-${x}`, symbol: `s${x}` }));
  const { data, urls } = await live(markets, () => ({ status: 200, body: chart(20e6) }), 3);
  assert.equal(urls.length, 3); // 1 markets + 2 history
  assert.ok(data.dataset.notes.some((n) => /not requested for 3 asset\(s\) \(syn-c, syn-d, syn-e\) because the per-run limit of 3 requests was reached/.test(n)), data.dataset.notes.join(' | '));
  // Never-requested assets are excluded as not requested, not as "too little history".
  const r = scan(data);
  assert.deepEqual(r.excluded.map((e) => [e.id, e.reasons.map((x) => x.code)]), [
    ['syn-c', ['history_not_requested']], ['syn-d', ['history_not_requested']], ['syn-e', ['history_not_requested']],
  ]);
  assert.deepEqual(data.dataset.coverage, {
    historyEligible: 5, historyFetched: 2, historyFromCache: 0, historyRequestFailed: 0, historyNotRequested: 3, complete: false,
    stopReason: 'the per-run limit of 3 requests was reached', requestsUsed: 3, requestLimit: 3,
  });
  assertCoverageAddsUp(data);
  const report = renderScanReport(r).replace(/\s+/g, ' ');
  assert.ok(report.includes('History coverage: fetched for 2 of 5 assets that passed the non-history filters; 0 failed; 3 not requested (the per-run limit of 3 requests was reached). PARTIAL SCAN.'), report);
  assert.ok(report.includes('PARTIAL SCAN: these results cover only the 2 of 5 eligible assets whose history was fetched; 3 were not evaluated.'), report);
  assert.ok(report.includes('history not requested (request/rate limit): SC, SD, SE'), report);
});

// ---- S6: history cache (in-memory stand-in for the file cache; freshness is the real rule) ------

function memoryCache(seed: Record<string, { fetchedAt: string; totalVolumes: unknown[] }> = {}) {
  const store = new Map(Object.entries(seed));
  const writes: string[] = [];
  const cache: HistoryCache = {
    get: (id, days, now) => {
      const e = store.get(`${id}|${days}`);
      return e && isFreshHistory(new Date(e.fetchedAt), now) ? e : null;
    },
    set: (id, days, fetchedAt, totalVolumes) => {
      writes.push(id);
      store.set(`${id}|${days}`, { fetchedAt: fetchedAt.toISOString(), totalVolumes });
      return true;
    },
  };
  return { cache, writes };
}
async function liveCached(markets: unknown, history: (id: string) => Route, cache: HistoryCache, maxCalls = 160) {
  const r = router((url) => (url.includes('/coins/markets') ? { status: 200, body: markets } : history(decodeURIComponent(/\/coins\/([^/]+)\/market_chart/.exec(url)![1]!))));
  const client = createHttpClient({ fetch: r.fn, baseUrl: 'https://api.example.test/api/v3', apiKeyHeader: 'x-cg-demo-api-key', apiKey: KEY, maxCalls, sleep: async () => {} });
  const data = await fetchLiveDataset({ client, clock: () => NOW, maxCalls, sleep: async () => {}, historyCache: cache });
  return { data, urls: r.urls };
}

test('S6: a miss is fetched and stored; a same-day rerun reuses it with no history request and identical results', async () => {
  const markets = [coin({ id: 'syn-a' }), coin({ id: 'syn-b', symbol: 'sb' })];
  const { cache, writes } = memoryCache();
  const first = await liveCached(markets, () => ({ status: 200, body: chart(20e6) }), cache);
  assert.equal(historyCalls(first.urls).length, 2);
  assert.deepEqual(writes, ['syn-a', 'syn-b']);
  assert.equal(first.data.dataset.coverage.historyFromCache, 0);

  const second = await liveCached(markets, () => {
    throw new Error('history must come from the cache');
  }, cache);
  assert.deepEqual(second.urls.map((u) => u.includes('/coins/markets')), [true]); // only the markets request
  assert.deepEqual(second.data.dataset.coverage, {
    historyEligible: 2, historyFetched: 2, historyFromCache: 2, historyRequestFailed: 0, historyNotRequested: 0, complete: true, stopReason: null, requestsUsed: 1, requestLimit: 160,
  });
  assert.deepEqual(second.data.assets.map((a) => a.dailyVolumes), first.data.assets.map((a) => a.dailyVolumes));
  assert.deepEqual(JSON.stringify(scan(second.data).movers), JSON.stringify(scan(first.data).movers));
  assert.ok(second.data.dataset.notes.some((n) => n.includes('Volume history for 2 of those asset(s) was reused from the local cache')), second.data.dataset.notes.join(' | '));
  const report = renderScanReport(scan(second.data)).replace(/\s+/g, ' ');
  assert.ok(report.includes("History coverage: fetched for 2 of 2 assets that passed the non-history filters (2 reused from this UTC day's local cache). Complete."), report);
});

test('S6: cached histories cost no request and are still used after the request limit is reached', async () => {
  // Limit 2 = markets + one history request. syn-a is requested, syn-b is cached, the limit is then
  // reached so syn-c (uncached) is not requested, and syn-d (cached) is still used afterwards.
  const markets = ['a', 'b', 'c', 'd'].map((x) => coin({ id: `syn-${x}`, symbol: `s${x}` }));
  const fresh = { fetchedAt: '2026-10-21T08:00:00.000Z', totalVolumes: chart(20e6).total_volumes };
  const { cache } = memoryCache({ 'syn-b|91': fresh, 'syn-d|91': fresh });
  const { data, urls } = await liveCached(markets, () => ({ status: 200, body: chart(20e6) }), cache, 2);
  assert.deepEqual(historyCalls(urls).map((u) => /coins\/([^/]+)\//.exec(u)![1]), ['syn-a']);
  assert.deepEqual(data.dataset.coverage, {
    historyEligible: 4, historyFetched: 3, historyFromCache: 2, historyRequestFailed: 0, historyNotRequested: 1, complete: false,
    stopReason: 'the per-run limit of 2 requests was reached', requestsUsed: 2, requestLimit: 2,
  });
  assert.deepEqual(data.assets.filter((a) => a.historyStatus === 'not_requested').map((a) => a.id), ['syn-c']);
  assert.equal(data.assets.find((a) => a.id === 'syn-d')!.dailyVolumes!.length, 91);
  scan(data); // the normalizer accepts the coverage
});

test('S6: failed requests and malformed bodies are never cached; stale entries are requested again', async () => {
  const markets = [coin({ id: 'syn-fail' }), coin({ id: 'syn-bad', symbol: 'sbd' }), coin({ id: 'syn-old', symbol: 'sol' })];
  const yesterday = { fetchedAt: '2026-10-20T18:00:00.000Z', totalVolumes: chart(5e6).total_volumes };
  const { cache, writes } = memoryCache({ 'syn-old|91': yesterday });
  const { data, urls } = await liveCached(markets, (id) =>
    id === 'syn-fail' ? { status: 500 } : id === 'syn-bad' ? { status: 200, body: { prices: [] } } : { status: 200, body: chart(20e6) }, cache);
  assert.equal(historyCalls(urls).length, 3); // the stale entry was not used
  assert.deepEqual(writes, ['syn-old']); // only the successful response was stored
  assert.deepEqual([data.dataset.coverage.historyFromCache, data.dataset.coverage.historyRequestFailed], [0, 2]);
  const old = data.assets.find((a) => a.id === 'syn-old')!;
  assert.equal(old.dailyVolumes!.at(-1), Math.round(20e6 * 0.95)); // today's fetch (the stale entry's would be 4.75M)
});

test('S6: a cache write failure is reported and does not affect the scan', async () => {
  const cache: HistoryCache = { get: () => null, set: () => false };
  const { data } = await liveCached([coin({ id: 'syn-a' })], () => ({ status: 200, body: chart(20e6) }), cache);
  assert.equal(scan(data).movers.length, 1);
  assert.ok(data.dataset.notes.some((n) => n.includes('1 fetched history response(s) could not be written to the local cache')), data.dataset.notes.join(' | '));
});

test('a failed or malformed markets response produces no dataset', async () => {
  await assert.rejects(live(null, () => ({ status: 200, body: chart(1) })).then(() => {}), ProviderResponseError);
  const r = router(() => ({ status: 503 }));
  const client = createHttpClient({ fetch: r.fn, baseUrl: 'https://api.example.test', apiKeyHeader: 'h', apiKey: KEY, maxCalls: 5, sleep: async () => {} });
  await assert.rejects(fetchLiveDataset({ client, clock: () => NOW, sleep: async () => {} }), /HTTP 503/);
});

test('live output is deterministic, attributed, states the volume meaning and its limits, and never contains the key', async () => {
  const markets = [coin({ id: 'syn-a' }), coin({ id: 'syn-b', symbol: 'sb', price_change_percentage_24h: 1, total_volume: 60e6 })];
  const one = await live(markets, () => ({ status: 200, body: chart(20e6) }));
  const two = await live(markets, () => ({ status: 200, body: chart(20e6) }));
  assert.equal(JSON.stringify(one.data), JSON.stringify(two.data));
  const report = renderScanReport(scan(one.data));
  assert.match(report, /^Attribution: Data provided by CoinGecko \(https:\/\/www\.coingecko\.com\)$/m);
  assert.match(report.replace(/\s+/g, ' '), /rolling 24h volume ending at 00:00 UTC, i\.e\. the previous UTC day \(confirmed by a one-coin live check; not a data-quality guarantee for every coin\)/);
  assert.doesNotMatch(report, /TEST DATA/);
  assert.ok(!JSON.stringify(one.data).includes(KEY) && !report.includes(KEY));
  // Each synthetic chart ends with an intraday "now" point, which must be dropped and reported.
  assert.ok(one.data.dataset.notes.some((n) => n.includes('2 from the current (incomplete) UTC day')), one.data.dataset.notes.join(' | '));
});

// ---- S7a: timestamp classification and history diagnostics (SYNTHETIC inputs) ----------------

test('S7a: every history point gets exactly one documented classification', () => {
  assert.deepEqual(classifyPoint([TODAY - DAY_MS, 1], TODAY), { ts: TODAY - DAY_MS, cls: 'prior-midnight' });
  assert.deepEqual(classifyPoint([TODAY - 3_600_000, 1], TODAY), { ts: TODAY - 3_600_000, cls: 'prior-intraday' });
  assert.deepEqual(classifyPoint([TODAY, 1], TODAY), { ts: TODAY, cls: 'today-midnight' });
  assert.deepEqual(classifyPoint([TODAY + 1, 1], TODAY), { ts: TODAY + 1, cls: 'today-after-midnight' });
  for (const bad of [['x', 1], [Number.NaN, 1], [9e15, 1], [5], 'p', null]) {
    assert.deepEqual(classifyPoint(bad, TODAY), { ts: null, cls: 'invalid' }, JSON.stringify(bad));
  }
});

test('S7a: the parser counts today 00:00 and later-today points separately; neither is used', () => {
  const { volumes, stats } = parseDailyVolumes({ total_volumes: [[TODAY - DAY_MS, 7], [TODAY, 8], [NOW.getTime(), 9]] }, NOW);
  assert.deepEqual(volumes, [7]);
  assert.deepEqual([stats.priorMidnight, stats.todayMidnight, stats.todayAfterMidnight], [1, 1, 1]);
});

test('S7a: describeHistory shows the first 2 and last 3 timestamps in raw order, with classes and duplicates, never values', () => {
  const pts = [[TODAY - 3 * DAY_MS, 111], [TODAY - 2 * DAY_MS, 222], [TODAY - 2 * DAY_MS, 333], ['bad', 444], [TODAY - DAY_MS + 5, 555], [TODAY, 666], [NOW.getTime(), 777]];
  const d = describeHistory({ total_volumes: pts }, NOW)!;
  assert.equal(d.points, 7);
  assert.equal(d.omitted, 2);
  assert.deepEqual(d.shown, [
    { index: 0, time: '2026-10-18T00:00:00.000Z', cls: 'prior-midnight', duplicate: false },
    { index: 1, time: '2026-10-19T00:00:00.000Z', cls: 'prior-midnight', duplicate: false },
    { index: 4, time: '2026-10-20T00:00:00.005Z', cls: 'prior-intraday', duplicate: false },
    { index: 5, time: '2026-10-21T00:00:00.000Z', cls: 'today-midnight', duplicate: false },
    { index: 6, time: '2026-10-21T12:00:00.000Z', cls: 'today-after-midnight', duplicate: false },
  ]);
  for (const v of ['111', '222', '555', '666', '777']) assert.ok(!JSON.stringify(d).includes(v), `volume ${v} leaked`);
  // Short series are shown in full; duplicates are flagged; a malformed body describes nothing.
  const small = describeHistory({ total_volumes: [[TODAY - DAY_MS, 1], [TODAY - DAY_MS, 2], 'x'] }, NOW)!;
  assert.deepEqual(small.shown.map((p) => [p.cls, p.duplicate]), [['prior-midnight', false], ['prior-midnight', true], ['invalid', false]]);
  assert.equal(small.omitted, 0);
  assert.equal(describeHistory({ prices: [] }, NOW), null);
});

test('S7a: fetchLiveDataset collects diagnostics only when asked, for every history request made', async () => {
  const markets = [coin({ id: 'syn-a' }), coin({ id: 'syn-b', symbol: 'sb' })];
  const routes = (url: string): Route => (url.includes('/coins/markets') ? { status: 200, body: markets } : url.includes('syn-a') ? { status: 200, body: chart(20e6) } : { status: 500 });
  const mk = () => createHttpClient({ fetch: router(routes).fn, baseUrl: 'https://api.example.test/api/v3', apiKeyHeader: 'x-cg-demo-api-key', apiKey: KEY, maxCalls: 10, sleep: async () => {} });
  const withDiag = await fetchLiveDataset({ client: mk(), clock: () => NOW, sleep: async () => {}, diagnostics: true });
  assert.deepEqual(withDiag.diagnostics!.map((x) => [x.id, x.outcome]), [['syn-a', 'parsed'], ['syn-b', 'request failed (HTTP 500)']]);
  assert.equal(withDiag.diagnostics![0]!.history!.points, 92);
  assert.equal((await fetchLiveDataset({ client: mk(), clock: () => NOW, sleep: async () => {} })).diagnostics, undefined);
});

// ---- S7a remediation (all inputs SYNTHETIC; mocked fetch only) --------------------------------

/** A client over a scripted mock fetch: `answer(url, attemptForThisUrl)` returns a reply, 'hang' or 'throw'. */
function scripted(answer: (url: string, n: number) => Route | 'hang' | 'throw', maxCalls: number, timeoutMs = 15_000) {
  const urls: string[] = [];
  const fn: FetchLike = (url, init) => {
    urls.push(url);
    const a = answer(url, urls.filter((u) => u === url).length);
    if (a === 'throw') return Promise.reject(new TypeError(`fetch failed ${url} ${KEY}`));
    if (a === 'hang') return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    return Promise.resolve({ ok: a.status < 300, status: a.status, headers: { get: (n: string) => a.headers?.[n.toLowerCase()] ?? null }, text: async () => (a.body === undefined ? '' : typeof a.body === 'string' ? a.body : JSON.stringify(a.body)) });
  };
  const client = createHttpClient({ fetch: fn, baseUrl: 'https://api.example.test/api/v3', apiKeyHeader: 'x-cg-demo-api-key', apiKey: KEY, maxCalls, timeoutMs, sleep: async () => {} });
  return { client, urls };
}
const idOf = (url: string) => decodeURIComponent(/\/coins\/([^/?]+)\/market_chart/.exec(url)?.[1] ?? 'markets');

test('F1: a history request whose 429 retry is blocked by the budget is reported as attempted and failed', async () => {
  const markets = ['a', 'b', 'c'].map((x) => coin({ id: `syn-${x}`, symbol: `s${x}` }));
  const { client, urls } = scripted((url, n) => (url.includes('/coins/markets') ? { status: 200, body: markets }
    : url.includes('syn-b') && n === 1 ? { status: 429, headers: { 'retry-after': '0' } } : { status: 200, body: chart(20e6) }), 3);
  const data = await fetchLiveDataset({ client, clock: () => NOW, sleep: async () => {}, maxCalls: 3, diagnostics: true });
  assert.deepEqual(urls.map(idOf), ['markets', 'syn-a', 'syn-b']); // 3 requests: the cap is never exceeded
  assert.deepEqual(data.diagnostics!.map((d) => [d.id, d.outcome]), [
    ['syn-a', 'parsed'],
    ['syn-b', 'request failed (HTTP 429; retry not sent: per-run request limit reached)'],
  ]);
  assert.ok(data.dataset.notes.some((n) => n.includes('History request failed for 1 asset(s) (syn-b)')), data.dataset.notes.join(' | '));
  assert.ok(data.dataset.notes.some((n) => n.includes('History not requested for 1 asset(s) (syn-c) because the per-run limit of 3 requests was reached')), data.dataset.notes.join(' | '));
});

test('F3: failure outcomes distinguish HTTP status, invalid JSON, timeout and network errors', async () => {
  const markets = ['json', 'time', 'net', 'http'].map((x) => coin({ id: `syn-${x}`, symbol: `s${x}` }));
  const { client } = scripted((url) => (url.includes('/coins/markets') ? { status: 200, body: markets }
    : url.includes('syn-json') ? { status: 200, body: '<html>not json</html>' }
      : url.includes('syn-time') ? 'hang' : url.includes('syn-net') ? 'throw' : { status: 503 }), 10, 20);
  const data = await fetchLiveDataset({ client, clock: () => NOW, sleep: async () => {}, diagnostics: true });
  assert.deepEqual(data.diagnostics!.map((d) => [d.id, d.outcome]), [
    ['syn-json', 'request failed (response was not valid JSON)'],
    ['syn-time', 'request failed (timed out)'],
    ['syn-net', 'request failed (network error)'],
    ['syn-http', 'request failed (HTTP 503)'],
  ]);
  assert.ok(!JSON.stringify(data).includes(KEY));
});

test('F2: provider ids with control characters are escaped in report notes; internal ids are unchanged', async () => {
  const evil = 'evil\u001b[2J\nFAKE: line\r\u0000\u007f\u009b';
  const markets = [coin({ id: evil, symbol: 'ev' })];
  const { client, urls } = scripted((url) => (url.includes('/coins/markets') ? { status: 200, body: markets } : { status: 500 }), 5);
  const data = await fetchLiveDataset({ client, clock: () => NOW, sleep: async () => {} });
  assert.equal(idOf(urls[1]!), evil, 'the request still uses the real id');
  assert.equal((data.assets[0] as { id: string }).id, evil, 'data matching still uses the real id');
  const note = data.dataset.notes.find((n) => n.startsWith('History request failed'))!;
  assert.ok(note.includes('evil\\u001b[2J\\u000aFAKE: line\\u000d\\u0000\\u007f\\u009b'), note);
  const report = renderScanReport(runScan(normalizeDataset(data), NOW));
  const notesBlock = report.slice(report.indexOf('DATA NOTES'));
  assert.doesNotMatch(notesBlock, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/, 'no raw control characters in the notes');
  assert.ok(!notesBlock.split('\n').some((l) => l.startsWith('FAKE')), 'no forged line');
});

test('F4: timestamps at or after tomorrow 00:00 UTC are "future" and never enter the history', () => {
  const TOMORROW = TODAY + DAY_MS;
  assert.equal(classifyPoint([TOMORROW - 1, 1], TODAY).cls, 'today-after-midnight');
  assert.equal(classifyPoint([TOMORROW, 1], TODAY).cls, 'future');
  assert.equal(classifyPoint([TODAY + 5 * DAY_MS, 1], TODAY).cls, 'future');
  assert.equal(classifyPoint([8.64e15, 1], TODAY).cls, 'future');
  assert.equal(classifyPoint([8.64e15 + 1, 1], TODAY).cls, 'invalid');
  const { volumes, stats } = parseDailyVolumes({ total_volumes: [[TODAY - DAY_MS, 7], [TOMORROW, 8], [TODAY + 5 * DAY_MS, 9], [8.64e15, 10]] }, NOW);
  assert.deepEqual(volumes, [7]);
  assert.deepEqual([stats.priorMidnight, stats.future, stats.todayAfterMidnight], [1, 3, 0]);
  const d = describeHistory({ total_volumes: [[TOMORROW, 1]] }, NOW)!;
  assert.deepEqual(d.shown.map((p) => p.cls), ['future']);
});
