// CoinMarketCap Stage A: one listings request as a second source for research leads. Every coin
// and value is SYNTHETIC TEST DATA; CoinMarketCap is mocked; no test contacts the internet or
// needs a credential.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ProviderResponseError } from '../src/providers/coingecko.ts';
import { type CmcRecord, classifyCmcFailure, parseCmcListings } from '../src/providers/coinmarketcap.ts';
import { type FetchLike, HttpError, createHttpClient } from '../src/providers/http.ts';
import { crossCheckLead, crossCheckLeads, matchLead } from '../src/scanner/cross-check.ts';
import type { Discovery, DiscoveryEntry } from '../src/scanner/types.ts';
import { CMC_CACHE_TTL_MS, type CmcLastCrypto, createCmcCheckService, validateCmcBody } from '../src/web/cmc-check.ts';
import { WEB_HOST, createScanService, handleRequest } from '../src/web/server.ts';

globalThis.fetch = (() => {
  throw new Error('Network access is not allowed in tests.');
}) as typeof fetch;

const KEY = 'TEST-CMC-KEY-not-real-31337';
const NOW = new Date('2026-10-21T12:00:00Z');
const PORT = 4173;
const HEADERS = { host: `${WEB_HOST}:${PORT}`, 'content-type': 'application/json', 'x-market-scanner': '1' };
const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/cmc-listings.synthetic.json', import.meta.url), 'utf8'));
const RECORDS = parseCmcListings(FIXTURE).records;

function lead(over: Partial<DiscoveryEntry> & { id: string; symbol: string; name: string }): DiscoveryEntry {
  return { tier: 'high_priority', status: 'shortlisted', kind: 'mover', score: 6, maxScore: 8, reasons: [], caveats: [], activity: [], price: 1, marketCap: 1e9, lastUpdated: '2026-10-21T11:57:00.000Z', ...over };
}
const rec = (over: Partial<CmcRecord> & { id: number; symbol: string; name: string }): CmcRecord => ({ slug: null, rank: 50, price: 1, marketCap: 1e9, volume24h: 1e7, change24hPct: 1, lastUpdated: '2026-10-21T11:57:00.000Z', tags: [], ...over });

// ---- parsing ---------------------------------------------------------------------------------------

test('listings parsing: documented shape, both tag forms, validation, credit count', () => {
  const p = parseCmcListings(FIXTURE);
  assert.equal(p.records.length, 9);
  assert.equal(p.creditCount, 2);
  const alpha = p.records[0]!;
  assert.deepEqual([alpha.id, alpha.symbol, alpha.slug, alpha.rank, alpha.price, alpha.marketCap, alpha.lastUpdated], [900001, 'SALP', 'synthetic-alpha', 38, 1.236, 4_180_000_000, '2026-10-21T11:57:30.000Z']);
  assert.deepEqual(p.records.find((r) => r.symbol === 'SBRV')!.tags, ['defi']); // {slug, name} object form
  assert.deepEqual(p.records.find((r) => r.symbol === 'SCHR')!.tags, ['memes', 'test-data']); // string form
  const bad = parseCmcListings({ status: { error_code: 0 }, data: [
    { id: 1, name: 'Ok\u0007 Coin', symbol: 'ok', slug: 'ok-coin', quote: { USD: { price: -5, market_cap: Number.NaN, last_updated: 'yesterday' } }, tags: ['<b>x</b>', 'fine-tag', 42] },
    { id: 1, name: 'Duplicate', symbol: 'ok' }, { id: 'x', name: 'n', symbol: 's' }, { id: 2, symbol: 'nn' }, null, 'str',
    { id: 3, name: 'Bad slug', symbol: 'bs', slug: '../../etc' },
  ] });
  assert.equal(bad.skipped, 5);
  assert.deepEqual([bad.records[0]!.name, bad.records[0]!.symbol, bad.records[0]!.price, bad.records[0]!.marketCap, bad.records[0]!.lastUpdated, bad.records[0]!.tags], ['Ok Coin', 'OK', null, null, null, ['fine-tag']]);
  assert.equal(bad.records[1]!.slug, null);
  for (const b of [null, [], { data: 'x' }, { status: {} }]) assert.throws(() => parseCmcListings(b), ProviderResponseError);
  assert.throws(() => parseCmcListings({ status: { error_code: 1006 }, data: [] }), /error code 1006/);
});

// ---- conservative matching -------------------------------------------------------------------

test('matching needs the symbol AND the name or slug; a symbol alone never matches', () => {
  const byName = matchLead(lead({ id: 'syn-alpha', symbol: 'SALP', name: 'Synthetic Alpha' }), RECORDS);
  assert.deepEqual([byName.status, byName.basis, byName.cmc?.id], ['matched', 'name', 900001]);
  assert.equal(byName.candidates.length, 1); // the other SALP coin is disclosed, not chosen
  const bySlug = matchLead(lead({ id: 'syn-charlie', symbol: 'SCHR', name: 'Synthetic Charlie' }), RECORDS);
  assert.deepEqual([bySlug.status, bySlug.basis], ['matched', 'slug']);
  const both = matchLead(lead({ id: 'synthetic-gap', symbol: 'SGAP', name: 'Synthetic  GAP!' }), RECORDS); // case, spacing and punctuation ignored
  assert.deepEqual([both.status, both.basis], ['matched', 'name_and_slug']);
  const unmatched = matchLead(lead({ id: 'syn-echo', symbol: 'SECH', name: 'Synthetic Echo' }), RECORDS);
  assert.deepEqual([unmatched.status, unmatched.cmc, unmatched.candidates.map((c) => c.name)], ['unmatched', null, ['Echo Protocol']]);
  const ambiguous = matchLead(lead({ id: 'syn-delta', symbol: 'SDLT', name: 'Synthetic Delta' }), RECORDS);
  assert.deepEqual([ambiguous.status, ambiguous.cmc, ambiguous.candidates.map((c) => c.id)], ['ambiguous', null, [900005, 900006]]);
  assert.equal(matchLead(lead({ id: 'syn-newcoin', symbol: 'SNEW', name: 'Synthetic Newcoin' }), RECORDS).status, 'not_found');
  // Same symbol, unrelated name, even as the only candidate: no match.
  assert.equal(matchLead(lead({ id: 'a', symbol: 'ONE', name: 'Alpha One' }), [rec({ id: 1, symbol: 'ONE', name: 'Harmony' })]).status, 'unmatched');
  // An empty name can never "match" another empty name.
  assert.equal(matchLead(lead({ id: 'a', symbol: 'X', name: '!!!' }), [rec({ id: 1, symbol: 'X', name: '???' })]).status, 'unmatched');
});

test('cross-check values: agreement, differences, missing values, timing gaps and tags', () => {
  const r = crossCheckLeads([
    lead({ id: 'syn-alpha', symbol: 'SALP', name: 'Synthetic Alpha', price: 1.234, marketCap: 4.2e9 }),
    lead({ id: 'syn-bravo', symbol: 'SBRV', name: 'Synthetic Bravo', price: 0.5821, marketCap: 1.1e9 }),
    lead({ id: 'syn-stale', symbol: 'SSTL', name: 'Synthetic Stale', price: 5.6, marketCap: 1.2e9 }),
    lead({ id: 'syn-gap', symbol: 'SGAP', name: 'Synthetic Gap', price: 9.1, marketCap: 1.4e9 }),
    lead({ id: 'syn-charlie', symbol: 'SCHR', name: 'Synthetic Charlie', price: 3.17, marketCap: 6e8 }),
    lead({ id: 'syn-echo', symbol: 'SECH', name: 'Synthetic Echo', price: 12.85, marketCap: 2.5e9 }),
  ], RECORDS);
  const [alpha, bravo, stale, gap, charlie, echo] = r.results;
  assert.equal(alpha!.verdict, 'agrees');
  assert.ok(Math.abs(alpha!.price.diffPct! - 0.162) < 0.01);
  assert.equal(bravo!.verdict, 'differs');
  assert.match(bravo!.notes.join(' '), /Prices differ by 5\.2% \(tolerance 2%\)/);
  assert.equal(stale!.verdict, 'partial');
  assert.match(stale!.notes.join(' '), /Market cap not compared: missing on one side/);
  assert.match(gap!.notes.join(' '), /snapshots are 40 minutes apart/);
  assert.deepEqual(charlie!.providerCategory, { category: 'meme', tag: 'memes' });
  assert.deepEqual([echo!.verdict, echo!.price.coinmarketcap, echo!.tags], ['not_compared', null, []]); // unmatched: no CMC values or tags attached
  assert.deepEqual(r.summary, { leads: 6, matched: 5, ambiguous: 0, unmatched: 1, notFound: 0, agrees: 3, differs: 1 });
  // A lead without its own price is not compared, never compared against CMC alone.
  assert.equal(crossCheckLead(lead({ id: 'syn-alpha', symbol: 'SALP', name: 'Synthetic Alpha', price: null, marketCap: null }), RECORDS).verdict, 'not_compared');
});

// ---- service: offline, live, cache, stop rules ---------------------------------------------------

const DISCOVERY: Discovery = {
  highPriority: [lead({ id: 'syn-alpha', symbol: 'SALP', name: 'Synthetic Alpha', price: 1.234, marketCap: 4.2e9 })],
  watchlist: [lead({ id: 'syn-delta', symbol: 'SDLT', name: 'Synthetic Delta', tier: 'watchlist' })],
  insufficientData: [],
  coverage: { universe: 0, evaluated: 0, withActivity: 0, withActivityNotEvaluated: 0, notes: [] },
};

function provider(answer: () => { status: number; body?: unknown; headers?: Record<string, string> }) {
  const urls: string[] = [];
  const keys: string[] = [];
  const fn: FetchLike = async (url, init) => {
    urls.push(url);
    keys.push(init?.headers?.['X-CMC_PRO_API_KEY'] ?? '');
    const a = answer();
    return { ok: a.status < 300, status: a.status, headers: { get: (h: string) => a.headers?.[h.toLowerCase()] ?? null }, text: async () => (typeof a.body === 'string' ? a.body : JSON.stringify(a.body ?? {})) };
  };
  return { fn, urls, keys };
}
function service(fetchFn: FetchLike, opts: { mode?: 'offline' | 'live'; env?: Record<string, string>; scanRunning?: () => boolean; sessionLimit?: number; last?: CmcLastCrypto | undefined } = {}) {
  let clock = NOW.getTime();
  const last: CmcLastCrypto | undefined = 'last' in opts ? opts.last : { mode: opts.mode ?? 'live', evaluatedAt: NOW.toISOString(), discovery: DISCOVERY };
  const svc = createCmcCheckService({ env: opts.env ?? { COINMARKETCAP_API_KEY: KEY }, fetch: fetchFn, clock: () => new Date(clock), sleep: async () => {} },
    { getLastCrypto: () => last, scanRunning: opts.scanRunning ?? (() => false), sessionLimit: opts.sessionLimit });
  return { svc, advance: (ms: number) => { clock += ms; } };
}
const ok = () => ({ status: 200, body: FIXTURE });
const cmcError = (status: number, code: number | null) => () => ({ status, body: code === null ? '' : { status: { error_code: code, error_message: 'x', credit_count: 0 } } });

test('offline scan: the fixture is used, zero requests, attribution always present', async () => {
  const p = provider(() => { throw new Error('must not fetch'); });
  const { svc } = service(p.fn, { mode: 'offline' });
  const r = await svc.check({ refresh: false, confirmLive: false });
  assert.equal(r.status, 200);
  assert.deepEqual([r.data.dataKind, r.data.requestsUsed, r.data.creditsUsed], ['test_data', 0, 0]);
  assert.deepEqual(r.data.attribution, { text: 'Data provided by CoinMarketCap.com', url: 'https://coinmarketcap.com/' });
  assert.deepEqual((r.data.summary as Record<string, number>), { leads: 2, matched: 1, ambiguous: 1, unmatched: 0, notFound: 0, agrees: 1, differs: 0 });
  assert.equal(p.urls.length, 0);
  // Errors carry the attribution too (it is on every response from this service).
  assert.ok((await service(p.fn, { last: undefined }).svc.check({ refresh: false, confirmLive: false })).data.attribution);
});

test('live: confirmation first, exactly one listings request, key only in the header, then the in-memory cache', async () => {
  const p = provider(ok);
  const { svc, advance } = service(p.fn);
  const first = await svc.check({ refresh: false, confirmLive: false });
  assert.deepEqual([first.status, first.data.needsConfirm], [428, true]);
  assert.match(String(first.data.error), /1 CoinMarketCap request \(top 500 listings, about 2 credits/);
  assert.equal(p.urls.length, 0);
  const r = await svc.check({ refresh: false, confirmLive: true });
  assert.equal(r.status, 200);
  assert.deepEqual(p.urls, ['https://pro-api.coinmarketcap.com/v3/cryptocurrency/listings/latest?aux=cmc_rank%2Ctags&convert=USD&limit=500&start=1']);
  assert.equal(p.keys[0], KEY);
  assert.ok(!p.urls[0]!.includes(KEY));
  assert.deepEqual([r.data.requestsUsed, r.data.creditsUsed, r.data.cmcRequestsThisSession], [1, 2, 1]);
  assert.ok(!JSON.stringify(r.data).includes(KEY));
  advance(5 * 60_000);
  const cached = await svc.check({ refresh: false, confirmLive: false });
  assert.deepEqual([cached.status, cached.data.fromCache, cached.data.requestsUsed], [200, true, 0]);
  assert.equal((await svc.check({ refresh: true, confirmLive: false })).status, 428); // refresh asks again
  advance(CMC_CACHE_TTL_MS);
  assert.equal((await svc.check({ refresh: false, confirmLive: false })).status, 428); // expired: dropped, not reused
  assert.equal(p.urls.length, 1);
});

test('plan-access, key, payment and credit-limit errors stop all further requests for the session', async () => {
  const cases: [() => { status: number; body?: unknown }, RegExp][] = [
    [cmcError(403, 1006), /plan does not include the listings endpoint \(HTTP 403, error 1006\)/],
    [cmcError(403, 1007), /refused access \(HTTP 403 \(error 1007\)\)/],
    [cmcError(401, 1001), /rejected the API key \(HTTP 401 \(error 1001\)\)/],
    [cmcError(402, 1004), /needs payment or activation/],
    [cmcError(429, 1010), /monthly credit limit was reached \(error 1010\)/],
    [cmcError(429, 1009), /daily credit limit/],
    [cmcError(429, null), /rate- or credit-limited the request \(HTTP 429, no error code\)/],
  ];
  for (const [answer, expect] of cases) {
    const p = provider(answer);
    const { svc, advance } = service(p.fn);
    const r = await svc.check({ refresh: false, confirmLive: true });
    assert.equal(r.status, 403, String(expect));
    assert.match(String(r.data.error), expect);
    assert.equal(r.data.stopped, true);
    advance(10 * 60_000);
    const again = await svc.check({ refresh: false, confirmLive: true });
    assert.equal(again.status, 403);
    assert.match(String(again.data.error), /stopped for this session/);
    assert.equal(p.urls.length, 1, `${expect}: no request after the stop`);
    assert.ok(svc.stoppedReason);
  }
});

test('a per-minute limit pauses for 60 s; transient errors do not stop; neither retries or waits', async () => {
  let answer = cmcError(429, 1008);
  let slept = 0;
  const p = provider(() => answer());
  const svc = createCmcCheckService({ env: { COINMARKETCAP_API_KEY: KEY }, fetch: p.fn, clock: () => NOW, sleep: async (ms) => { slept += ms; } },
    { getLastCrypto: () => ({ mode: 'live', evaluatedAt: NOW.toISOString(), discovery: DISCOVERY }), scanRunning: () => false });
  const r = await svc.check({ refresh: false, confirmLive: true });
  assert.equal(r.status, 502);
  assert.match(String(r.data.error), /per-minute rate limit was reached \(error 1008\)/);
  assert.equal((await svc.check({ refresh: false, confirmLive: true })).status, 429); // paused, no request
  assert.equal(p.urls.length, 1);
  assert.equal(slept, 0);
  // After the pause: a server error is reported but does not stop the session.
  const t = createCmcCheckService({ env: { COINMARKETCAP_API_KEY: KEY }, fetch: p.fn, clock: () => NOW },
    { getLastCrypto: () => ({ mode: 'live', evaluatedAt: NOW.toISOString(), discovery: DISCOVERY }), scanRunning: () => false });
  answer = () => ({ status: 503 });
  const e = await t.check({ refresh: false, confirmLive: true });
  assert.match(String(e.data.error), /HTTP 503; this is usually temporary/);
  assert.equal(t.stoppedReason, null);
  answer = ok;
  assert.equal((await t.check({ refresh: false, confirmLive: true })).status, 200);
});

test('live: blocked without a key, during a scan, without a scan, and after the session limit', async () => {
  const p = provider(ok);
  const noKey = await service(p.fn, { env: {} }).svc.check({ refresh: false, confirmLive: true });
  assert.equal(noKey.status, 422);
  assert.match(String(noKey.data.error), /COINMARKETCAP_API_KEY is not set on the server, so no request was made/);
  assert.equal((await service(p.fn, { scanRunning: () => true }).svc.check({ refresh: false, confirmLive: true })).status, 409);
  assert.equal((await service(p.fn, { last: undefined }).svc.check({ refresh: false, confirmLive: true })).status, 409);
  assert.equal(p.urls.length, 0);
  const { svc } = service(p.fn, { sessionLimit: 1 });
  await svc.check({ refresh: false, confirmLive: true });
  const capped = await svc.check({ refresh: true, confirmLive: true });
  assert.equal(capped.status, 429);
  assert.match(String(capped.data.error), /used its 1 CoinMarketCap requests/);
  assert.equal(p.urls.length, 1);
});

test('error bodies: kept apart from the message, capped and redacted', async () => {
  const fn: FetchLike = async () => ({ ok: false, status: 403, headers: { get: () => null }, text: async () => `{"status":{"error_code":1006,"error_message":"echo ${KEY}"}}${'x'.repeat(5000)}` });
  const client = createHttpClient({ fetch: fn, baseUrl: 'https://api.example.test', apiKeyHeader: 'X-CMC_PRO_API_KEY', apiKey: KEY, maxCalls: 1 });
  const err = await client.getJson('/x').catch((e) => e) as HttpError;
  assert.ok(err instanceof HttpError);
  assert.equal(err.message, 'HTTP 403 from /x.');
  assert.ok(err.responseBody!.length <= 2000);
  assert.ok(!err.responseBody!.includes(KEY));
  assert.match(err.responseBody!, /\[REDACTED\]/);
  assert.equal(classifyCmcFailure(err).stop, 'session');
  assert.deepEqual(validateCmcBody('{"refresh":true,"confirmLive":true}'), { refresh: true, confirmLive: true });
  for (const b of ['nope', '[]', 'x'.repeat(2000)]) assert.ok('error' in validateCmcBody(b));
});

// ---- API route and dashboard --------------------------------------------------------------------

test('API: the route needs a crypto scan, uses the same guards, and never starts a scan or reveals the key', async () => {
  const env = { COINMARKETCAP_API_KEY: KEY };
  const svc = createScanService({ env, fetch: async () => { throw new Error('no fetch'); }, clock: () => NOW, sleep: async () => {} }, 160);
  const post = (url: string, body: unknown, headers: Record<string, string | undefined> = HEADERS) => handleRequest({ method: 'POST', url, headers, body: JSON.stringify(body) }, svc, env, PORT);
  assert.equal((await post('/api/crypto/cmc-check', {})).status, 409);
  await post('/api/scan/crypto', { mode: 'offline' });
  const r = await post('/api/crypto/cmc-check', {});
  assert.equal(r.status, 200);
  const d = JSON.parse(r.body);
  assert.equal(d.summary.leads, 8);
  assert.deepEqual(d.summary, { leads: 8, matched: 5, ambiguous: 1, unmatched: 1, notFound: 1, agrees: 3, differs: 1 });
  assert.equal(d.results.find((x: { id: string }) => x.id === 'syn-charlie').providerCategory.category, 'meme');
  assert.equal(svc.running, false);
  for (const h of [{ ...HEADERS, 'x-market-scanner': undefined }, { ...HEADERS, origin: 'http://evil.example' }, { ...HEADERS, host: 'evil.example:4173' }]) {
    assert.equal((await post('/api/crypto/cmc-check', {}, h)).status, 403);
  }
  assert.equal((await handleRequest({ method: 'GET', url: '/api/crypto/cmc-check', headers: HEADERS, body: '' }, svc, env, PORT)).status, 405);
  const st = await handleRequest({ method: 'GET', url: '/api/status', headers: HEADERS, body: '' }, svc, env, PORT);
  assert.equal(JSON.parse(st.body).cmcKeyConfigured, true);
  for (const res of [r, st]) assert.ok(!res.body.includes(KEY));
});

test('dashboard: prominent attribution with a link, runs only on click, text only', () => {
  const app = readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
  assert.match(app, /'Data provided by ', link/);
  assert.match(app, /'CoinMarketCap\.com'/);
  assert.match(app, /box\.append\(cmcAttribution\(d\.attribution\)\)/); // panel-level, before the results
  assert.match(app, /x\.match\.status === 'matched' \? cmcAttribution\(attribution, true\)/); // on every matched lead
  const calls = app.split('\n').filter((l) => l.includes('loadCmc(')).map((l) => l.trim());
  assert.equal(calls.length, 2); // the definition and the button's click handler only
  assert.equal((app.match(/\/api\/crypto\/cmc-check/g) ?? []).length, 1);
  assert.doesNotMatch(app, /innerHTML|insertAdjacentHTML|eval\(|new Function/);
  const css = readFileSync(new URL('../src/web/public/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.attribution \{[^}]*font-weight: 600/);
});
