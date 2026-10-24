// Crypto asset search. Every coin and value here is SYNTHETIC TEST DATA; CoinGecko is mocked; no
// test contacts the internet or needs a credential.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ProviderResponseError } from '../src/providers/coingecko.ts';
import { parseSearchCoins } from '../src/providers/coingecko-search.ts';
import type { FetchLike } from '../src/providers/http.ts';
import { ASSET_CACHE_TTL_MS, SEARCH_CACHE_TTL_MS, assetView, createCryptoSearchService, normalizeQuery, rankResults, validateSearchBody } from '../src/web/crypto-search.ts';
import { WEB_HOST, createScanService, handleRequest } from '../src/web/server.ts';

globalThis.fetch = (() => {
  throw new Error('Network access is not allowed in tests.');
}) as typeof fetch;

const KEY = 'TEST-CG-KEY-not-real-5150';
const PORT = 4173;
const HEADERS = { host: `${WEB_HOST}:${PORT}`, 'content-type': 'application/json', 'x-market-scanner': '1' };
const NOW = new Date('2026-10-21T12:00:00Z');
const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/crypto-search.synthetic.json', import.meta.url), 'utf8'));

function provider(answer: (url: string) => { status: number; body?: unknown; headers?: Record<string, string> }) {
  const urls: string[] = [];
  const keys: string[] = [];
  const fn: FetchLike = async (url, init) => {
    urls.push(url);
    keys.push(init?.headers?.['x-cg-demo-api-key'] ?? '');
    const a = answer(url);
    return { ok: a.status < 300, status: a.status, headers: { get: (h: string) => a.headers?.[h.toLowerCase()] ?? null }, text: async () => (typeof a.body === 'string' ? a.body : JSON.stringify(a.body ?? {})) };
  };
  return { fn, urls, keys };
}
const liveAnswer = (url: string) => ({ status: 200, body: url.includes('/search') ? FIXTURE.search : FIXTURE.markets.filter((m: { id: string }) => url.includes(`ids=${m.id}&`) || url.endsWith(`ids=${m.id}`)) });

function service(fetchFn: FetchLike, opts: { env?: Record<string, string>; scanRunning?: () => boolean; sessionLimit?: number } = {}) {
  let clock = NOW.getTime();
  const svc = createCryptoSearchService({ env: opts.env ?? { COINGECKO_DEMO_API_KEY: KEY }, fetch: fetchFn, clock: () => new Date(clock), sleep: async () => {} },
    { getLastCrypto: () => undefined, scanRunning: opts.scanRunning ?? (() => false), minIntervalMs: 2_000, sessionLimit: opts.sessionLimit });
  return { svc, advance: (ms: number) => { clock += ms; } };
}

// ---- query handling and ranking --------------------------------------------------------------------

test('queries are trimmed and validated; nothing else reaches the provider', () => {
  assert.equal(normalizeQuery('  bit   coin '), 'bit coin');
  assert.equal(normalizeQuery('$SALP'), 'SALP');
  assert.equal(normalizeQuery('Synthetic Alpha (Bridged)'), 'Synthetic Alpha (Bridged)');
  assert.equal(normalizeQuery('Ünïcode'), 'Ünïcode');
  for (const bad of ['', 'a', ' $b ', 'x'.repeat(51), 'btc&vs=eur', '<script>', 'a/b', 42, null]) assert.equal(normalizeQuery(bad), null, String(bad));
  assert.deepEqual(validateSearchBody('{"mode":"live","query":"btc"}', 'search'), { mode: 'live', value: 'btc', refresh: false, confirmLive: false });
  assert.match((validateSearchBody('{"mode":"live","id":"../etc"}', 'asset') as { error: string }).error, /CoinGecko coin id/);
  assert.match((validateSearchBody('{"mode":"shell","query":"btc"}', 'search') as { error: string }).error, /mode must be/);
  assert.match((validateSearchBody('nope', 'search') as { error: string }).error, /JSON/);
  assert.match((validateSearchBody('x'.repeat(2000), 'search') as { error: string }).error, /too large/);
});

test('ambiguous symbols: every coin sharing a symbol is listed and flagged; none is selected', () => {
  const { coins } = parseSearchCoins(FIXTURE.search);
  const r = rankResults(coins.filter((c) => c.symbol === 'SALP' || c.name.includes('Alpha')), 'salp');
  assert.deepEqual(r.results.map((c) => [c.id, c.match]), [['syn-alpha', 'symbol'], ['syn-alpha-classic', 'symbol'], ['syn-alpha-bridged', 'symbol']]);
  assert.deepEqual(r.ambiguousSymbols, [{ symbol: 'SALP', ids: ['syn-alpha', 'syn-alpha-classic', 'syn-alpha-bridged'] }]);
  assert.match(r.guidance!, /3 different coins use the symbol SALP\. Symbols are not unique: choose by name and CoinGecko id/);
  assert.ok(!('selected' in r));
});

test('exact matches come first, then the provider order (market cap); results are capped', () => {
  const coins = [
    { id: 'big-partial', name: 'Echo Network', symbol: 'ECHN', rank: 5 },
    { id: 'exact-name', name: 'Echo', symbol: 'ECX', rank: 900 },
    { id: 'echo', name: 'Something', symbol: 'SMT', rank: null },
  ];
  assert.deepEqual(rankResults(coins, 'echo').results.map((c) => [c.id, c.match]), [['exact-name', 'name'], ['echo', 'id'], ['big-partial', 'partial']]);
  const many = Array.from({ length: 40 }, (_, i) => ({ id: `coin-${i}`, name: `Coin ${i}`, symbol: `C${i}`, rank: i + 1 }));
  const capped = rankResults(many, 'coin');
  assert.deepEqual([capped.results.length, capped.total], [25, 40]);
  const none = rankResults([], 'zzz');
  assert.match(none.guidance!, /No CoinGecko coin matches "zzz"/);
});

test('/search parsing: malformed and duplicate entries skipped, text cleaned, unusable ids rejected', () => {
  const { coins, skipped } = parseSearchCoins({ coins: [
    { id: 'ok-coin', name: 'Okay\u0007 Coin\n', symbol: 'ok', market_cap_rank: 3 },
    { id: 'ok-coin', name: 'Duplicate', symbol: 'ok' },
    { id: '../../etc', name: 'Path', symbol: 'p' },
    { id: 'UPPER', name: 'Upper', symbol: 'u' },
    { id: 'no-symbol', name: 'No symbol' },
    { id: 'bad-rank', name: 'Bad rank', symbol: 'br', market_cap_rank: -4 },
    'string', null,
  ], exchanges: [], categories: [] });
  assert.deepEqual(coins, [{ id: 'ok-coin', name: 'Okay Coin', symbol: 'OK', rank: 3 }, { id: 'bad-rank', name: 'Bad rank', symbol: 'BR', rank: null }]);
  assert.equal(skipped, 6);
  for (const bad of [null, [], { coins: 'x' }, { exchanges: [] }]) assert.throws(() => parseSearchCoins(bad), ProviderResponseError);
});

// ---- offline service -----------------------------------------------------------------------------

test('offline: finds coins beyond the scan shortlist, with zero requests', async () => {
  const p = provider(() => { throw new Error('must not fetch'); });
  const { svc } = service(p.fn);
  const r = await svc.search('offline', 'outsider', false, false);
  assert.equal(r.status, 200);
  assert.deepEqual((r.data.results as { id: string; rank: number }[]).map((c) => [c.id, c.rank]), [['syn-outside', 612]]); // rank 612: outside the top 250 the scan covers
  assert.equal(r.data.dataKind, 'test_data');
  const a = await svc.asset('offline', 'syn-outside', false, false);
  const asset = a.data.asset as Record<string, { value: unknown }>;
  assert.deepEqual([asset.price!.value, asset.change24hPct!.value, asset.volume24h!.value, asset.marketCap!.value, asset.lastUpdated!.value], [0.0437, 6.3, 1_900_000, 21_000_000, '2026-10-21T11:55:00.000Z']);
  assert.match(String(a.data.scanNote), /No crypto scan has run/);
  const none = await svc.search('offline', 'zzzz', false, false);
  assert.equal((none.data.results as unknown[]).length, 0);
  assert.match(String(none.data.guidance), /No CoinGecko coin matches/);
  assert.equal(p.urls.length, 0);
});

test('lookup: missing fields stay missing, a coin without market data says so, and a different coin is never shown', async () => {
  const { svc } = service(provider(() => ({ status: 500 })).fn);
  const bridged = (await svc.asset('offline', 'syn-alpha-bridged', false, false)).data.asset as Record<string, { value: unknown; kind: string; note: string | null }>;
  assert.equal(bridged.price!.value, null);
  assert.equal(bridged.price!.kind, 'missing');
  assert.equal(bridged.marketCap!.value, null); // 0 is not a valid market cap
  const dormant = await svc.asset('offline', 'syn-dormant', false, false);
  assert.deepEqual([dormant.status, dormant.data.asset], [200, null]);
  assert.match(String(dormant.data.message), /no market data for this coin/);
  // The provider answering with another coin is treated as "no data", not shown under this id.
  assert.equal(assetView([{ id: 'syn-alpha', symbol: 'salp', name: 'Synthetic Alpha', price: 1 }], 'syn-alpha-classic', 'live', NOW.toISOString()), null);
});

// ---- live service: confirmation, budget, cache, spacing, errors ---------------------------------

test('live search: confirmation first, exactly one request with the key in a header, then the cache', async () => {
  const p = provider(liveAnswer);
  const { svc, advance } = service(p.fn);
  const unconfirmed = await svc.search('live', 'salp', false, false);
  assert.deepEqual([unconfirmed.status, unconfirmed.data.needsConfirm], [428, true]);
  assert.equal(p.urls.length, 0);
  const r = await svc.search('live', 'salp', false, true);
  assert.equal(r.status, 200);
  assert.deepEqual(p.urls, ['https://api.coingecko.com/api/v3/search?query=salp']);
  assert.equal(p.keys[0], KEY);
  assert.ok(!p.urls[0]!.includes(KEY));
  assert.deepEqual([r.data.requestsUsed, r.data.fromCache, r.data.liveRequestsThisSession], [1, false, 1]);
  assert.equal((r.data.ambiguousSymbols as unknown[]).length, 1);
  advance(60_000);
  const cached = await svc.search('live', 'SALP', false, false); // case-insensitive cache key
  assert.deepEqual([cached.status, cached.data.fromCache, cached.data.requestsUsed], [200, true, 0]);
  advance(SEARCH_CACHE_TTL_MS);
  assert.equal((await svc.search('live', 'salp', false, false)).status, 428); // expired: ask again
  assert.equal(p.urls.length, 1);
});

test('live lookup: by unique id, cached, and refresh needs confirmation and respects spacing', async () => {
  const p = provider(liveAnswer);
  const { svc, advance } = service(p.fn);
  const r = await svc.asset('live', 'syn-alpha-classic', false, true);
  assert.equal(r.status, 200);
  assert.match(p.urls[0]!, /\/coins\/markets\?ids=syn-alpha-classic&price_change_percentage=24h%2C7d&sparkline=false&vs_currency=usd$/);
  assert.equal((r.data.asset as { name: string }).name, 'Synthetic Alpha Classic');
  assert.equal((r.data.asset as { price: { kind: string } }).price.kind, 'verified_market_data');
  assert.match(String(r.data.attribution), /CoinGecko/);
  assert.equal((await svc.asset('live', 'syn-alpha-classic', false, false)).data.fromCache, true);
  assert.equal((await svc.asset('live', 'syn-alpha-classic', true, false)).status, 428);
  const tooSoon = await svc.asset('live', 'syn-alpha-classic', true, true);
  assert.equal(tooSoon.status, 429);
  assert.match(String(tooSoon.data.error), /wait 2 s/);
  advance(2_000);
  assert.equal((await svc.asset('live', 'syn-alpha-classic', true, true)).data.fromCache, false);
  advance(ASSET_CACHE_TTL_MS);
  assert.equal((await svc.asset('live', 'syn-alpha-classic', false, false)).status, 428);
  assert.equal(p.urls.length, 2);
});

test('live: blocked during a scan, without a key, and after the session request limit', async () => {
  let scanning = true;
  const p = provider(liveAnswer);
  const { svc, advance } = service(p.fn, { scanRunning: () => scanning, sessionLimit: 2 });
  const blocked = await svc.search('live', 'salp', false, true);
  assert.equal(blocked.status, 409);
  assert.match(String(blocked.data.error), /A scan is running/);
  scanning = false;
  await svc.search('live', 'salp', false, true);
  advance(2_000);
  await svc.search('live', 'bravo', false, true);
  advance(2_000);
  const capped = await svc.search('live', 'echo', false, true);
  assert.equal(capped.status, 429);
  assert.match(String(capped.data.error), /used its 2 live search requests/);
  assert.equal(p.urls.length, 2);
  const noKey = service(p.fn, { env: {} });
  const r = await noKey.svc.search('live', 'salp', false, true);
  assert.equal(r.status, 422);
  assert.match(String(r.data.error), /COINGECKO_DEMO_API_KEY is not set/);
  assert.equal(p.urls.length, 2);
});

test('live errors: rate limits, auth, outages and bad responses become sanitized messages; one request each, no waiting', async () => {
  const cases: [{ status: number; body?: unknown; headers?: Record<string, string> }, RegExp][] = [
    [{ status: 429, headers: { 'retry-after': '20' } }, /rate-limiting.*100 per minute/],
    [{ status: 429, headers: { 'retry-after': '0' } }, /rate-limiting/],
    [{ status: 401 }, /rejected the API key \(HTTP 401\)/],
    [{ status: 403 }, /refused access \(HTTP 403\)/],
    [{ status: 503 }, /HTTP 503; this is usually temporary/],
    [{ status: 200, body: 'not json' }, /not valid JSON/],
    [{ status: 200, body: { exchanges: [] } }, /could not be used/],
  ];
  for (const [answer, expect] of cases) {
    let slept = 0;
    const p = provider(() => answer);
    const svc = createCryptoSearchService({ env: { COINGECKO_DEMO_API_KEY: KEY }, fetch: p.fn, clock: () => NOW, sleep: async (ms) => { slept += ms; } },
      { getLastCrypto: () => undefined, scanRunning: () => false });
    const r = await svc.search('live', 'salp', false, true);
    assert.equal(r.status, 502, `${answer.status}`);
    assert.match(String(r.data.error), expect);
    assert.equal(p.urls.length, 1, `${answer.status}: one request`);
    assert.equal(slept, 0, `${answer.status}: no retry wait`);
    assert.ok(!JSON.stringify(r.data).includes(KEY));
    assert.equal(svc.busy, false);
  }
  // Errors are never cached: the next search asks again.
  const p = provider(() => ({ status: 500 }));
  const { svc, advance } = service(p.fn);
  await svc.search('live', 'salp', false, true);
  advance(2_000);
  assert.equal((await svc.search('live', 'salp', false, false)).status, 428);
});

// ---- API routes and separation from scans -------------------------------------------------------

test('API: search routes use the same guards; search never starts a scan; lookups report scan membership', async () => {
  const p = provider(() => { throw new Error('must not fetch'); });
  const svc = createScanService({ env: { COINGECKO_DEMO_API_KEY: KEY }, fetch: p.fn, clock: () => NOW, sleep: async () => {} }, 160);
  const env = { COINGECKO_DEMO_API_KEY: KEY };
  const post = (url: string, body: unknown, headers: Record<string, string | undefined> = HEADERS) => handleRequest({ method: 'POST', url, headers, body: JSON.stringify(body) }, svc, env, PORT);
  const s = await post('/api/crypto/search', { mode: 'offline', query: 'alpha' });
  assert.equal(s.status, 200);
  assert.equal(JSON.parse(s.body).results.length, 3);
  assert.equal(svc.running, false); // no scan was started
  // Before any scan: lookup works and says so.
  assert.match(JSON.parse((await post('/api/crypto/asset', { mode: 'offline', id: 'syn-alpha' })).body).scanNote, /No crypto scan has run/);
  // After an offline crypto scan: membership is reported, and outsiders are labelled as not evaluated.
  await post('/api/scan/crypto', { mode: 'offline' });
  const inScan = JSON.parse((await post('/api/crypto/asset', { mode: 'offline', id: 'syn-alpha' })).body);
  assert.deepEqual([inScan.inLastScan.status, inScan.inLastScan.category, inScan.inLastScan.score], ['qualified', 'Mover', 8]);
  const outside = JSON.parse((await post('/api/crypto/asset', { mode: 'offline', id: 'syn-outside' })).body);
  assert.equal(outside.inLastScan, null);
  assert.match(outside.scanNote, /Not among the 6 assets the latest offline crypto scan evaluated/);
  // Guards and validation.
  assert.equal((await post('/api/crypto/search', { mode: 'offline', query: 'x' })).status, 400);
  assert.equal((await post('/api/crypto/asset', { mode: 'offline', id: 'Bad Id' })).status, 400);
  assert.equal((await post('/api/crypto/search', { mode: 'offline', query: 'alpha' }, { ...HEADERS, 'x-market-scanner': undefined })).status, 403);
  assert.equal((await post('/api/crypto/search', { mode: 'offline', query: 'alpha' }, { ...HEADERS, origin: 'http://evil.example' })).status, 403);
  assert.equal((await post('/api/crypto/search', { mode: 'offline', query: 'alpha' }, { ...HEADERS, host: 'evil.example:4173' })).status, 403);
  assert.equal((await handleRequest({ method: 'GET', url: '/api/crypto/search', headers: HEADERS, body: '' }, svc, env, PORT)).status, 405);
  // A live search without confirmation never reaches the provider.
  const live = await post('/api/crypto/search', { mode: 'live', query: 'alpha' });
  assert.equal(live.status, 428);
  assert.equal(p.urls.length, 0);
  assert.ok(!live.body.includes(KEY));
});

test('a scan is refused while a live search request is running (search during a scan: see "blocked during a scan")', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const slow: FetchLike = async () => {
    await gate;
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(FIXTURE.search) };
  };
  const env = { COINGECKO_DEMO_API_KEY: KEY };
  const svc = createScanService({ env, fetch: slow, clock: () => NOW, sleep: async () => {} }, 160);
  const pending = handleRequest({ method: 'POST', url: '/api/crypto/search', headers: HEADERS, body: '{"mode":"live","query":"salp","confirmLive":true}' }, svc, env, PORT);
  await new Promise((r) => setImmediate(r));
  assert.equal(svc.search.busy, true);
  const scan = await handleRequest({ method: 'POST', url: '/api/scan/crypto', headers: HEADERS, body: '{"mode":"offline"}' }, svc, env, PORT);
  assert.equal(scan.status, 409);
  assert.match(JSON.parse(scan.body).error, /crypto search request is running/);
  release();
  assert.equal((await pending).status, 200);
  assert.equal(svc.search.busy, false);
});

test('page code: search runs only on submit, never auto-selects, and inserts text only', () => {
  const app = readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
  assert.equal((app.match(/runSearch\(/g) ?? []).length, 3); // definition, form submit, refresh button
  assert.equal((app.match(/loadAsset\(/g) ?? []).length, 3); // definition, a result's button, refresh button
  assert.doesNotMatch(app, /addEventListener\('input', \(\) => runSearch|keyup|innerHTML|insertAdjacentHTML|eval\(|new Function/);
  for (const s of ['TEST DATA: invented coins', 'Show market data', 'CoinGecko id:']) assert.ok(app.includes(s), s);
});
