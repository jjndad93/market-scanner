// Stock news and "why it may be moving". Every article, ticker and price here is SYNTHETIC TEST
// DATA; providers are mocked; no test contacts the internet or needs a credential.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { type MoveContext, type NewsArticle, assessNews, coreName, headlineMentions, timingOf } from '../src/news/assess.ts';
import type { FetchLike } from '../src/providers/http.ts';
import { cleanText, parseMassiveNews, safeLink } from '../src/providers/massive-news.ts';
import { MassiveResponseError } from '../src/providers/massive.ts';
import { type LastScan, NEWS_CACHE_TTL_MS, createNewsService, validateNewsRequest } from '../src/web/news.ts';
import type { DashboardRow } from '../src/web/rows.ts';
import { WEB_HOST, createScanService, handleRequest } from '../src/web/server.ts';

globalThis.fetch = (() => {
  throw new Error('Network access is not allowed in tests.');
}) as typeof fetch;

const KEY = 'TEST-NEWS-KEY-not-real-7777';
const PORT = 4173;
const HEADERS = { host: `${WEB_HOST}:${PORT}`, 'content-type': 'application/json', 'x-market-scanner': '1' };
const HOUR = 3_600_000;

// The SYNA session move from the synthetic stock fixture: close 2026-10-19 to close 2026-10-20 (4 pm ET = 20:00Z).
const MOVE: MoveContext = {
  market: 'stocks', symbol: 'SYNA', name: 'Synthetic Alpha Corp', changePct: 9, direction: 'rising', significant: true, volatile: false,
  windowStart: '2026-10-19T20:00:00.000Z', windowEnd: '2026-10-20T20:00:00.000Z', windowLabel: 'the latest session', leadMs: 72 * HOUR,
};
const NOW = new Date('2026-10-21T11:30:00Z');

function art(over: Partial<NewsArticle> & { id: string }): NewsArticle {
  return {
    title: 'Synthetic Alpha Corp news', publisher: 'Synthetic Wire (TEST DATA)', publishedUtc: '2026-10-20T12:00:00.000Z', publishedNote: null,
    url: `https://example.com/test-news/${over.id}`, description: 'TEST DATA.', tickers: ['SYNA'], sentiment: null, sentimentReasoning: null, ...over,
  };
}

// ---- matching, timing, focus ----------------------------------------------------------------------

test('only articles the provider tagged with the asset are kept; unrelated headlines are dropped, not shown', () => {
  const r = assessNews(MOVE, [art({ id: 'a' }), art({ id: 'other', tickers: ['TSTX'], title: 'Unrelated company wins contract' }), art({ id: 'lower', tickers: ['syna'] })], NOW);
  assert.deepEqual(r.articles.map((x) => x.article.id), ['a']);
  assert.equal(r.droppedUnrelated, 2); // tickers match exactly: a lower-case tag is not this asset
  // A headline naming the company is NOT enough without the provider's tag.
  const r2 = assessNews(MOVE, [art({ id: 'name-only', tickers: ['TSTX'], title: 'Synthetic Alpha Corp rival cuts prices' })], NOW);
  assert.equal(r2.articles.length, 0);
  assert.equal(r2.verdict.kind, 'no_news');
});

test('headline matching: ticker as a whole word or the core company name, nothing looser', () => {
  assert.equal(coreName('Apple Inc.'), 'Apple');
  assert.equal(coreName('Synthetic Gamma Holdings'), 'Synthetic Gamma');
  assert.equal(headlineMentions('SYNA rallies', 'SYNA', 'Synthetic Alpha Corp'), true);
  assert.equal(headlineMentions('Shares of $SYNA rise', 'SYNA', 'Synthetic Alpha Corp'), true);
  assert.equal(headlineMentions('SYNAPSE launches a product', 'SYNA', 'Synthetic Alpha Corp'), false);
  assert.equal(headlineMentions('Why synthetic alpha shares jumped', 'SYNA', 'Synthetic Alpha Corp'), true);
  assert.equal(headlineMentions('Synthetic Alphabet soup', 'SYNA', 'Synthetic Alpha Corp'), false);
});

test('timing: before, during and after the move window, stale, and unknown', () => {
  const t = (iso: string | null) => timingOf(iso, MOVE);
  assert.equal(t('2026-10-20T12:00:00Z'), 'during');
  assert.equal(t('2026-10-19T20:00:00Z'), 'during'); // window start is inclusive
  assert.equal(t('2026-10-18T09:00:00Z'), 'shortly_before'); // within 72 h before the window
  assert.equal(t('2026-10-10T09:00:00Z'), 'stale');
  assert.equal(t('2026-10-20T20:00:01Z'), 'after');
  assert.equal(t(null), 'unknown_time');
});

test('an article published AFTER the move is never its cause, even when it is about the move', () => {
  const r = assessNews(MOVE, [art({ id: 'recap', title: 'Why Synthetic Alpha shares jumped today', publishedUtc: '2026-10-20T22:10:00.000Z', sentiment: 'positive' })], NOW);
  assert.equal(r.articles[0]!.role, 'reported_after');
  assert.equal(r.articles[0]!.strength, 'none');
  assert.match(r.articles[0]!.relevance, /published after the move was observed.*not evidence of its cause/);
  assert.equal(r.verdict.kind, 'unconfirmed');
  assert.match(r.verdict.text, /the reason is unknown/);
});

test('a focused article before or during the move is a POSSIBLE catalyst only; strength never "strong"', () => {
  const during = assessNews(MOVE, [art({ id: 'd', title: 'Synthetic Alpha Corp raises outlook' })], NOW);
  assert.deepEqual([during.articles[0]!.role, during.articles[0]!.strength], ['possible_catalyst', 'moderate']);
  assert.equal(during.verdict.kind, 'possible_catalyst');
  assert.match(during.verdict.text, /possible catalysts only: timing and topic do not confirm the cause/);
  assert.doesNotMatch(JSON.stringify(during), /"strength":"strong"|caused by|because of/i);
  const before = assessNews(MOVE, [art({ id: 'b', title: 'Board meeting scheduled', publishedUtc: '2026-10-18T15:00:00.000Z' })], NOW);
  assert.deepEqual([before.articles[0]!.focus, before.articles[0]!.role, before.articles[0]!.strength], ['sole_ticker', 'possible_catalyst', 'weak']);
});

test('a passing mention among many tickers is background, even during the move', () => {
  const r = assessNews(MOVE, [art({ id: 'list', title: 'Ten stocks to watch this week', tickers: ['SYNA', 'SYNB', 'SYNC', 'TSTX'] })], NOW);
  assert.deepEqual([r.articles[0]!.focus, r.articles[0]!.role], ['mentioned', 'background']);
  assert.equal(r.verdict.kind, 'unconfirmed');
});

test('missing publication time: shown, but never placed in time or treated as a catalyst', () => {
  const r = assessNews(MOVE, [art({ id: 'nt', title: 'Synthetic Alpha Corp CEO interview', publishedUtc: null, publishedNote: 'no publication time given' })], NOW);
  assert.deepEqual([r.articles[0]!.timing, r.articles[0]!.role], ['unknown_time', 'unplaced']);
  assert.match(r.articles[0]!.relevance, /missing or invalid \(no publication time given\), so it cannot be placed before or after the move/);
  assert.ok(r.notes.some((n) => /1 article\(s\) have no usable publication time/.test(n)));
  assert.equal(r.verdict.kind, 'unconfirmed');
});

test('stale news is background and flagged', () => {
  const r = assessNews(MOVE, [art({ id: 's', title: 'Synthetic Alpha Corp opens a plant', publishedUtc: '2026-09-01T14:00:00.000Z' })], NOW);
  assert.deepEqual([r.articles[0]!.timing, r.articles[0]!.role], ['stale', 'background']);
  assert.ok(r.notes.some((n) => /newest related article is 49 days old; the news may be stale/.test(n)));
});

test('duplicates (same id or same link) are removed; newest first', () => {
  const r = assessNews(MOVE, [
    art({ id: 'x', publishedUtc: '2026-10-20T10:00:00.000Z' }),
    art({ id: 'x', title: 'same id' }),
    art({ id: 'y', url: 'https://example.com/test-news/x', publishedUtc: '2026-10-20T11:00:00.000Z' }), // same link as x
    art({ id: 'z', publishedUtc: '2026-10-20T15:00:00.000Z' }),
  ], NOW);
  assert.deepEqual(r.articles.map((x) => x.article.id), ['z', 'x']);
  assert.equal(r.droppedDuplicates, 2);
});

test('conflicting reports: catalysts disagree, or all point against the move', () => {
  const fall: MoveContext = { ...MOVE, symbol: 'SYNB', name: 'Synthetic Beta Inc', changePct: -5, direction: 'falling' };
  const mixed = assessNews(fall, [
    art({ id: 'm1', tickers: ['SYNB'], title: 'Synthetic Beta misses estimates', sentiment: 'negative' }),
    art({ id: 'm2', tickers: ['SYNB'], title: 'Synthetic Beta expands buyback', sentiment: 'positive' }),
  ], NOW);
  assert.equal(mixed.verdict.kind, 'conflicting');
  assert.match(mixed.verdict.text, /point in different directions.*insufficient/);
  const against = assessNews(MOVE, [art({ id: 'neg', title: 'Synthetic Alpha Corp faces a probe', sentiment: 'negative' })], NOW);
  assert.equal(against.verdict.kind, 'conflicting');
  assert.match(against.verdict.text, /read as negative .* while the asset is rising/);
  // Neutral or missing sentiment never creates a conflict.
  assert.equal(assessNews(MOVE, [art({ id: 'n', title: 'Synthetic Alpha Corp update', sentiment: 'neutral' })], NOW).verdict.kind, 'possible_catalyst');
});

test('no news, no source, and a modest move are all stated plainly', () => {
  const none = assessNews(MOVE, [], NOW);
  assert.equal(none.verdict.kind, 'no_news');
  assert.match(none.verdict.text, /No relevant news found.*The reason for the move is unknown/);
  const crypto = assessNews({ ...MOVE, market: 'crypto' }, null, NOW);
  assert.equal(crypto.verdict.kind, 'no_source');
  assert.match(crypto.verdict.text, /No news source is configured.*unknown/);
  const small = assessNews({ ...MOVE, changePct: 0.3, direction: 'flat', significant: false }, [], NOW);
  assert.match(small.movement, /roughly flat \(\+0\.3%.*below the scanner's mover threshold/);
  assert.ok(small.notes.some((n) => /may be no specific event/.test(n)));
});

// ---- provider parsing: untrusted data ------------------------------------------------------------

test('Massive news parsing: unsafe links dropped, fields cleaned and capped, malformed items skipped', () => {
  const longTitle = 'T'.repeat(5000);
  const { articles, skipped } = parseMassiveNews({
    status: 'OK',
    results: [
      { id: 'ok', title: 'Synthetic Alpha Corp\u0007 update\n\twith‮ tricks', published_utc: '2026-10-20T12:00:00Z', article_url: 'https://example.com/a', tickers: ['SYNA', 'bad ticker!', 7], publisher: { name: 'Wire' },
        insights: [{ ticker: 'SYNB', sentiment: 'negative' }, { ticker: 'SYNA', sentiment: 'positive', sentiment_reasoning: 'r' }] },
      { id: 'js', title: 'x', article_url: 'javascript:alert(1)', tickers: ['SYNA'], published_utc: '2026-10-20T12:00:00Z' },
      { id: 'cred', title: 'x', article_url: 'https://user:pw@example.com/', tickers: ['SYNA'] },
      { id: 'long', title: longTitle, description: 'D'.repeat(5000), article_url: 'ftp://example.com/x', tickers: ['SYNA'], published_utc: 'not a date' },
      { id: 'future', title: 'x', tickers: ['SYNA'], published_utc: '2027-01-01T00:00:00Z', publisher: 'not an object' },
      { title: 'no id' }, { id: 'no-title' }, 'string item', null,
    ],
  }, 'SYNA', NOW);
  assert.equal(skipped, 4);
  const [ok, js, cred, long, future] = articles;
  assert.equal(ok!.title, 'Synthetic Alpha Corp update with tricks'); // control and bidi characters removed
  assert.deepEqual(ok!.tickers, ['SYNA']);
  assert.deepEqual([ok!.sentiment, ok!.sentimentReasoning], ['positive', 'r']); // this ticker's insight only
  assert.equal(ok!.publishedUtc, '2026-10-20T12:00:00.000Z');
  assert.equal(js!.url, null);
  assert.equal(cred!.url, null);
  assert.equal(long!.url, null);
  assert.equal(long!.title.length, 300);
  assert.equal(long!.description!.length, 600);
  assert.deepEqual([long!.publishedUtc, long!.publishedNote], [null, 'publication time is not a valid timestamp']);
  assert.deepEqual([future!.publishedUtc, future!.publishedNote], [null, 'publication time is in the future']);
  assert.equal(future!.publisher, 'Unknown publisher');
  assert.equal(cred!.publishedNote, 'no publication time given');
  // Not an object, or results not an array: rejected as a provider error.
  for (const bad of [null, [], 'x', { results: 'x' }]) assert.throws(() => parseMassiveNews(bad, 'SYNA', NOW), MassiveResponseError);
  assert.deepEqual(parseMassiveNews({ status: 'OK' }, 'SYNA', NOW), { articles: [], skipped: 0 }); // no results = empty
  assert.equal(safeLink('https://example.com/a b'), 'https://example.com/a%20b');
  assert.equal(cleanText('   ', 10), null);
});

// ---- service: offline fixture, live, cache, limits -------------------------------------------------

/** Rows from the real offline stock scan, through the web API (zero requests). */
async function offlineStockRows(): Promise<{ rows: DashboardRow[]; evaluatedAt: string }> {
  const svc = createScanService({ env: {}, fetch: async () => { throw new Error('no fetch'); }, clock: () => NOW, sleep: async () => {} }, 160);
  const r = await handleRequest({ method: 'POST', url: '/api/scan/stocks', headers: HEADERS, body: '{"mode":"offline"}' }, svc, {}, PORT);
  const d = JSON.parse(r.body);
  return { rows: d.rows, evaluatedAt: d.result.evaluatedAt };
}

function provider(answer: (url: string) => { status: number; body?: unknown; headers?: Record<string, string> }) {
  const urls: string[] = [];
  const auth: string[] = [];
  const fn: FetchLike = async (url, init) => {
    urls.push(url);
    auth.push(init?.headers?.authorization ?? '');
    const a = answer(url);
    return { ok: a.status < 300, status: a.status, headers: { get: (h: string) => a.headers?.[h.toLowerCase()] ?? null }, text: async () => (typeof a.body === 'string' ? a.body : JSON.stringify(a.body ?? {})) };
  };
  return { fn, urls, auth };
}

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/stock-news.synthetic.json', import.meta.url), 'utf8'));

async function liveService(fetchFn: FetchLike, opts: { env?: Record<string, string>; scanRunning?: () => boolean } = {}) {
  const { rows, evaluatedAt } = await offlineStockRows();
  let clock = Date.parse('2026-10-21T12:00:00Z');
  const last: LastScan = { mode: 'live', rows, evaluatedAt };
  const svc = createNewsService({ env: opts.env ?? { POLYGON_API_KEY: KEY }, fetch: fetchFn, clock: () => new Date(clock), sleep: async () => {} },
    { getLast: (m) => (m === 'stocks' ? last : undefined), scanRunning: opts.scanRunning ?? (() => false), minIntervalMs: 12_500 });
  return { svc, advance: (ms: number) => { clock += ms; } };
}
const reqFor = (key: string, more: Partial<{ limit: number; refresh: boolean; confirmLive: boolean }> = {}) => ({ key, limit: 5, refresh: false, confirmLive: false, ...more });

test('offline: the synthetic fixture gives the expected verdict per asset, with zero requests', async () => {
  const { rows, evaluatedAt } = await offlineStockRows();
  let calls = 0;
  const svc = createNewsService({ env: {}, fetch: async () => { calls++; throw new Error('no'); }, clock: () => NOW },
    { getLast: () => ({ mode: 'offline', rows, evaluatedAt }), scanRunning: () => false });
  const verdict = async (sym: string) => {
    const r = await svc.get('stocks', reqFor(`stocks:${sym}`));
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data as { assessment: { verdict: { kind: string }; articles: { article: { id: string; url: string | null }; role: string }[]; droppedDuplicates: number }; dataKind: string; requestsUsed: number };
  };
  const a = await verdict('SYNA');
  assert.equal(a.dataKind, 'test_data');
  assert.equal(a.requestsUsed, 0);
  assert.equal(a.assessment.verdict.kind, 'possible_catalyst');
  assert.deepEqual(a.assessment.articles.map((x) => [x.article.id, x.role]), [['syn-news-a2', 'reported_after'], ['syn-news-a1', 'possible_catalyst'], ['syn-news-roundup', 'background']]);
  assert.equal(a.assessment.droppedDuplicates, 1);
  assert.equal((await verdict('SYNB')).assessment.verdict.kind, 'conflicting');
  const c = await verdict('SYNC');
  assert.equal(c.assessment.verdict.kind, 'unconfirmed');
  assert.ok(c.assessment.articles.some((x) => x.role === 'unplaced' && x.article.url === null)); // unsafe link dropped
  assert.equal((await verdict('SYND')).assessment.verdict.kind, 'no_news');
  // Limit is honoured.
  const one = await svc.get('stocks', reqFor('stocks:SYNA', { limit: 1 }));
  assert.equal((one.data.assessment as { articles: unknown[] }).articles.length, 1);
  assert.equal(calls, 0);
});

test('live: needs confirmation, sends exactly one request with the key in a header, then serves the cache', async () => {
  const p = provider(() => ({ status: 200, body: FIXTURE }));
  const { svc, advance } = await liveService(p.fn);
  const unconfirmed = await svc.get('stocks', reqFor('stocks:SYNA'));
  assert.equal(unconfirmed.status, 428);
  assert.equal(unconfirmed.data.needsConfirm, true);
  assert.equal(p.urls.length, 0);

  const first = await svc.get('stocks', reqFor('stocks:SYNA', { confirmLive: true }));
  assert.equal(first.status, 200);
  assert.equal(p.urls.length, 1);
  assert.match(p.urls[0]!, /^https:\/\/api\.massive\.com\/v2\/reference\/news\?limit=5&order=desc&published_utc\.gte=2026-08-20&sort=published_utc&ticker=SYNA$/);
  assert.equal(p.auth[0], `Bearer ${KEY}`);
  assert.ok(!p.urls[0]!.includes(KEY));
  assert.deepEqual([first.data.requestsUsed, first.data.fromCache, first.data.dataKind], [1, false, 'verified_market_data']);
  assert.match(String(first.data.attribution), /Massive/);

  // Re-opening within the hour: cache, no request, no confirmation needed.
  advance(30 * 60_000);
  const cached = await svc.get('stocks', reqFor('stocks:SYNA'));
  assert.deepEqual([cached.status, cached.data.fromCache, cached.data.requestsUsed], [200, true, 0]);
  assert.equal(p.urls.length, 1);

  // A different limit is a different query: not served from that cache.
  assert.equal((await svc.get('stocks', reqFor('stocks:SYNA', { limit: 3 }))).status, 428);

  // Expired cache: confirmation needed again, then a new request.
  advance(NEWS_CACHE_TTL_MS);
  assert.equal((await svc.get('stocks', reqFor('stocks:SYNA'))).status, 428);
  assert.equal((await svc.get('stocks', reqFor('stocks:SYNA', { confirmLive: true }))).data.fromCache, false);
  assert.equal(p.urls.length, 2);
});

test('live: explicit refresh bypasses the cache only with confirmation, and respects the rate spacing', async () => {
  const p = provider(() => ({ status: 200, body: FIXTURE }));
  const { svc, advance } = await liveService(p.fn);
  await svc.get('stocks', reqFor('stocks:SYNA', { confirmLive: true }));
  assert.equal((await svc.get('stocks', reqFor('stocks:SYNA', { refresh: true }))).status, 428);
  const tooSoon = await svc.get('stocks', reqFor('stocks:SYNA', { refresh: true, confirmLive: true }));
  assert.equal(tooSoon.status, 429);
  assert.match(String(tooSoon.data.error), /wait 13 s/);
  // Another asset within the spacing is refused too (the limit is per provider, not per asset).
  assert.equal((await svc.get('stocks', reqFor('stocks:SYNB', { confirmLive: true }))).status, 429);
  assert.equal(p.urls.length, 1);
  advance(12_500);
  const refreshed = await svc.get('stocks', reqFor('stocks:SYNA', { refresh: true, confirmLive: true }));
  assert.deepEqual([refreshed.status, refreshed.data.fromCache], [200, false]);
  assert.equal(p.urls.length, 2);
});

test('live: blocked while a scan runs, without a key, or for assets not in the last scan', async () => {
  let scanning = true;
  const p = provider(() => ({ status: 200, body: FIXTURE }));
  const { svc } = await liveService(p.fn, { scanRunning: () => scanning });
  const blocked = await svc.get('stocks', reqFor('stocks:SYNA', { confirmLive: true }));
  assert.equal(blocked.status, 409);
  assert.match(String(blocked.data.error), /A scan is running/);
  scanning = false;
  assert.equal((await svc.get('stocks', reqFor('stocks:NOPE', { confirmLive: true }))).status, 404);
  assert.equal((await svc.get('stocks', reqFor('stocks:SYNF', { confirmLive: true }))).status, 404); // excluded by the scan, so no row
  assert.equal((await svc.get('stocks', reqFor('crypto:syn-alpha', { confirmLive: true }))).status, 400);
  assert.equal((await svc.get('crypto', reqFor('crypto:syn-alpha'))).status, 409); // no crypto scan yet
  const noKey = await liveService(p.fn, { env: {} });
  const r = await noKey.svc.get('stocks', reqFor('stocks:SYNA', { confirmLive: true }));
  assert.equal(r.status, 422);
  assert.match(String(r.data.error), /POLYGON_API_KEY is not set/);
  assert.equal(p.urls.length, 0);
});

test('live errors: friendly, sanitized, one request at most, and a previous result is kept', async () => {
  const cases: [{ status: number; body?: unknown; headers?: Record<string, string> }, RegExp, number][] = [
    [{ status: 401 }, /rejected the API key \(HTTP 401\)/, 502],
    [{ status: 403 }, /refused access to news \(HTTP 403\)/, 502],
    [{ status: 429, headers: { 'retry-after': '30' } }, /rate-limiting.*5 per minute/, 502], // no 30 s wait, no retry
    [{ status: 503 }, /HTTP 503.*temporary/, 502],
    [{ status: 200, body: 'not json' }, /not valid JSON/, 502],
    [{ status: 200, body: { results: 'nope' } }, /could not be used/, 502],
    [{ status: 200, body: { status: 'OK', results: [] } }, /./, 200],
  ];
  for (const [answer, expect, status] of cases) {
    let slept = 0;
    const p = provider(() => answer);
    const { rows, evaluatedAt } = await offlineStockRows();
    const svc = createNewsService({ env: { POLYGON_API_KEY: KEY }, fetch: p.fn, clock: () => NOW, sleep: async (ms) => { slept += ms; } },
      { getLast: () => ({ mode: 'live', rows, evaluatedAt }), scanRunning: () => false });
    const r = await svc.get('stocks', reqFor('stocks:SYNA', { confirmLive: true }));
    assert.equal(r.status, status, `${answer.status}`);
    assert.equal(p.urls.length, 1, `${answer.status}: exactly one request`);
    assert.equal(slept, 0, `${answer.status}: no retry wait`);
    if (status === 200) assert.equal((r.data.assessment as { verdict: { kind: string } }).verdict.kind, 'no_news');
    else assert.match(String(r.data.error), expect);
    assert.ok(!JSON.stringify(r.data).includes(KEY));
  }
  // A failed refresh keeps the earlier result visible, clearly marked.
  let fail = false;
  const p = provider(() => (fail ? { status: 500 } : { status: 200, body: FIXTURE }));
  const { svc, advance } = await liveService(p.fn);
  await svc.get('stocks', reqFor('stocks:SYNA', { confirmLive: true }));
  fail = true;
  advance(13_000);
  const r = await svc.get('stocks', reqFor('stocks:SYNA', { refresh: true, confirmLive: true }));
  assert.equal(r.status, 200);
  assert.equal(r.data.fromCache, true);
  assert.match(String(r.data.warning), /Refresh failed: Massive returned HTTP 500.*Showing the earlier result/);
});

// ---- API routes --------------------------------------------------------------------------------------

test('news request validation', () => {
  assert.deepEqual(validateNewsRequest('{"key":"stocks:SYNA"}'), { key: 'stocks:SYNA', limit: 5, refresh: false, confirmLive: false });
  assert.deepEqual(validateNewsRequest('{"key":"stocks:SYNA","limit":20,"refresh":true,"confirmLive":true}'), { key: 'stocks:SYNA', limit: 20, refresh: true, confirmLive: true });
  for (const [body, expect] of [
    ['{}', /key must identify/], ['{"key":"SYNA"}', /key must identify/], ['{"key":"stocks:../../x y"}', /key must identify/],
    ['{"key":"stocks:SYNA","limit":0}', /1 to 20/], ['{"key":"stocks:SYNA","limit":21}', /1 to 20/], ['{"key":"stocks:SYNA","limit":"5"}', /1 to 20/],
    ['nope', /must be JSON/], ['null', /JSON object/], ['x'.repeat(2000), /too large/],
  ] as const) {
    const v = validateNewsRequest(body);
    assert.ok('error' in v, body.slice(0, 40));
    assert.match(v.error, expect);
  }
});

test('API: news routes need the scan first, the same cross-site guards, and return offline results with zero requests', async () => {
  let calls = 0;
  const svc = createScanService({ env: { POLYGON_API_KEY: KEY }, fetch: async () => { calls++; throw new Error('no'); }, clock: () => NOW, sleep: async () => {} }, 160);
  const env = { POLYGON_API_KEY: KEY };
  const post = (url: string, body: unknown, headers: Record<string, string | undefined> = HEADERS) => handleRequest({ method: 'POST', url, headers, body: JSON.stringify(body) }, svc, env, PORT);
  assert.equal((await post('/api/news/stocks', { key: 'stocks:SYNA' })).status, 409); // before any scan
  await post('/api/scan/stocks', { mode: 'offline' });
  const ok = await post('/api/news/stocks', { key: 'stocks:SYNA' });
  assert.equal(ok.status, 200);
  const d = JSON.parse(ok.body);
  assert.deepEqual([d.ok, d.market, d.symbol, d.mode, d.dataKind], [true, 'stocks', 'SYNA', 'offline', 'test_data']);
  assert.ok(Array.isArray(d.coverage) && d.coverage.length > 0);
  assert.equal((await post('/api/news/stocks', { key: 'stocks:SYNA', limit: 99 })).status, 400);
  assert.equal((await post('/api/news/stocks', { key: 'stocks:SYNA' }, { ...HEADERS, 'x-market-scanner': undefined })).status, 403);
  assert.equal((await post('/api/news/stocks', { key: 'stocks:SYNA' }, { ...HEADERS, origin: 'http://evil.example' })).status, 403);
  assert.equal((await post('/api/news/stocks', { key: 'stocks:SYNA' }, { ...HEADERS, host: 'evil.example:4173' })).status, 403);
  assert.equal((await handleRequest({ method: 'GET', url: '/api/news/stocks', headers: HEADERS, body: '' }, svc, env, PORT)).status, 405);
  // Crypto: after a crypto scan, the panel answers "no source" without any request.
  await post('/api/scan/crypto', { mode: 'offline' });
  const c = JSON.parse((await post('/api/news/crypto', { key: 'crypto:syn-alpha' })).body);
  assert.deepEqual([c.ok, c.source, c.requestsUsed, c.assessment.verdict.kind], [true, null, 0, 'no_source']);
  assert.match(c.coverage[0], /No crypto news source is configured/);
  assert.equal(calls, 0);
  assert.ok(!ok.body.includes(KEY));
});

test('a scan is refused while a live news request is running', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const env = { POLYGON_API_KEY: KEY };
  const slow: FetchLike = async () => {
    await gate;
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(FIXTURE) };
  };
  // The scan service's own news service; seed it with an offline scan, then make the stored scan "live".
  const svc = createScanService({ env, fetch: slow, clock: () => NOW, sleep: async () => {} }, 160);
  await handleRequest({ method: 'POST', url: '/api/scan/stocks', headers: HEADERS, body: '{"mode":"offline"}' }, svc, env, PORT);
  const { rows, evaluatedAt } = await offlineStockRows();
  const news = createNewsService({ env, fetch: slow, clock: () => NOW }, { getLast: () => ({ mode: 'live', rows, evaluatedAt }), scanRunning: () => svc.running });
  const pending = news.get('stocks', reqFor('stocks:SYNA', { confirmLive: true }));
  await new Promise((r) => setImmediate(r));
  assert.equal(news.busy, true);
  assert.equal((await news.get('stocks', reqFor('stocks:SYNB', { confirmLive: true }))).status, 409);
  release();
  assert.equal((await pending).status, 200);
  assert.equal(news.busy, false);
});

// ---- dashboard states (static checks; the rendered states are checked in the browser) ------------

test('dashboard news panel: states and safety properties are present in the page code', () => {
  const app = readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
  for (const s of ['No relevant news found for this asset.', 'Loading news…', 'TEST DATA: synthetic articles', 'No news source is configured for crypto', 'View original article', 'Fetch live news (1 Massive request)', 'publication time unknown']) {
    assert.ok(app.includes(s), s);
  }
  assert.match(app, /rel: 'noopener noreferrer nofollow'/);
  assert.match(app, /target: '_blank'/);
  assert.match(app, /\/\^https\?:\\\/\\\/\/\.test\(a\.url\)/); // links re-checked in the browser
  assert.doesNotMatch(app, /innerHTML|insertAdjacentHTML|outerHTML|eval\(|new Function/);
  // News is requested only from user actions (opening a panel, confirm, refresh), never on scan or render.
  const lines = app.split('\n').filter((l) => l.includes('loadNews(')).map((l) => l.trim());
  assert.deepEqual(lines, [
    'async function loadNews(row, { refresh = false, confirmLive = false } = {}) {', // definition
    'loadNews(row);', // toggleNews: the user opened the panel
    'if (ok) loadNews(row, { refresh, confirmLive: true });', // confirmAndLoad: after window.confirm
  ]);
  assert.equal((app.match(/\/api\/news\//g) ?? []).length, 1); // the only place news is requested
});
