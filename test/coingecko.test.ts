import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DAY_MS } from '../src/core/time.ts';
import { COINGECKO_ATTRIBUTION, ProviderResponseError, fetchLiveDataset, parseDailyVolumes, parseMarkets } from '../src/providers/coingecko.ts';
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
  assert.deepEqual(stats, { points: 13, malformed: 3, notAtMidnight: 1, currentDay: 2, duplicates: 1, conflicts: 1, gaps: 2, missingRecent: 0 });
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
});

test('a failed history request leaves that asset without history; nothing is invented', async () => {
  const markets = [coin({ id: 'syn-a' }), coin({ id: 'syn-b', symbol: 'sb' })];
  const { data } = await live(markets, (id) => (id === 'syn-a' ? { status: 500 } : { status: 200, body: chart(20e6) }));
  const r = scan(data);
  assert.deepEqual(r.movers.map((c) => c.asset.id), ['syn-b']);
  assert.deepEqual(r.excluded.map((e) => [e.id, e.reasons[0]!.code]), [['syn-a', 'insufficient_history']]);
  assert.ok(data.dataset.notes.some((n) => /History request failed for 1 asset\(s\) \(syn-a\)/.test(n)), data.dataset.notes.join(' | '));
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
  assert.deepEqual(reasons['syn-bad'], ['insufficient_history']);
  assert.deepEqual(reasons['syn-short'], ['insufficient_history']);
  assert.ok(data.dataset.notes.some((n) => n.includes('History request failed for 1 asset(s) (syn-bad)')), data.dataset.notes.join(' | '));
  // The short series really did supply only its own 10 days (no padding with invented values).
  const short = data.assets.find((a) => a.id === 'syn-short')!;
  assert.deepEqual(short.dailyVolumes!.length, 10);
});

test('a rate limit on history stops further history requests and is reported', async () => {
  const markets = ['a', 'b', 'c'].map((x) => coin({ id: `syn-${x}`, symbol: `s${x}` }));
  const { data, urls } = await live(markets, (id) => (id === 'syn-a' ? { status: 200, body: chart(20e6) } : { status: 429 }));
  assert.equal(historyCalls(urls).length, 2); // syn-a ok, syn-b 429 without Retry-After, syn-c never requested
  assert.ok(data.dataset.notes.some((n) => /History not requested for 2 asset\(s\) \(syn-b, syn-c\) because the provider rate-limited the run/.test(n)), data.dataset.notes.join(' | '));
});

test('the per-run request cap is enforced and reported', async () => {
  const markets = ['a', 'b', 'c', 'd', 'e'].map((x) => coin({ id: `syn-${x}`, symbol: `s${x}` }));
  const { data, urls } = await live(markets, () => ({ status: 200, body: chart(20e6) }), 3);
  assert.equal(urls.length, 3); // 1 markets + 2 history
  assert.ok(data.dataset.notes.some((n) => /not requested for 3 asset\(s\) \(syn-c, syn-d, syn-e\) because the per-run limit of 3 requests was reached/.test(n)), data.dataset.notes.join(' | '));
});

test('a failed or malformed markets response produces no dataset', async () => {
  await assert.rejects(live(null, () => ({ status: 200, body: chart(1) })).then(() => {}), ProviderResponseError);
  const r = router(() => ({ status: 503 }));
  const client = createHttpClient({ fetch: r.fn, baseUrl: 'https://api.example.test', apiKeyHeader: 'h', apiKey: KEY, maxCalls: 5, sleep: async () => {} });
  await assert.rejects(fetchLiveDataset({ client, clock: () => NOW, sleep: async () => {} }), /HTTP 503/);
});

test('live output is deterministic, attributed, flags the unverified volume meaning, and never contains the key', async () => {
  const markets = [coin({ id: 'syn-a' }), coin({ id: 'syn-b', symbol: 'sb', price_change_percentage_24h: 1, total_volume: 60e6 })];
  const one = await live(markets, () => ({ status: 200, body: chart(20e6) }));
  const two = await live(markets, () => ({ status: 200, body: chart(20e6) }));
  assert.equal(JSON.stringify(one.data), JSON.stringify(two.data));
  const report = renderScanReport(scan(one.data));
  assert.match(report, /^Attribution: Data provided by CoinGecko \(https:\/\/www\.coingecko\.com\)$/m);
  assert.match(report.replace(/\s+/g, ' '), /not yet verified against live data/);
  assert.doesNotMatch(report, /TEST DATA/);
  assert.ok(!JSON.stringify(one.data).includes(KEY) && !report.includes(KEY));
  // Each synthetic chart ends with an intraday "now" point, which must be dropped and reported.
  assert.ok(one.data.dataset.notes.some((n) => n.includes('2 from the current (incomplete) UTC day')), one.data.dataset.notes.join(' | '));
});
