import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nyWallTimeToUtc } from '../src/core/time.ts';
import { type FetchLike, createHttpClient } from '../src/providers/http.ts';
import { MASSIVE_MIN_INTERVAL_MS, MassiveResponseError, fetchStockDataset, parseDailyBars } from '../src/providers/massive.ts';
import { type ScanCommandDeps, runScanCommand } from '../src/scanner/command.ts';
import { STOCK_UNIVERSE } from '../src/stocks/rules.ts';

// Network guard: every request below goes through an injected mock fetch.
globalThis.fetch = (() => {
  throw new Error('Network access is not allowed in tests.');
}) as typeof fetch;

// SYNTHETIC response-shaped data in the provider's documented format: invented numbers.
const KEY = 'TEST-MASSIVE-KEY-not-real-123';
const NOW = new Date('2026-10-21T11:30:00Z'); // Wednesday 07:30 ET
/** A bar for a New York session date; `t` is the start of the window (00:00 ET), as documented. */
const bar = (date: string, c: number, v: number) => ({ t: nyWallTimeToUtc(date, 0, 0).getTime(), o: c, h: c, l: c, c, v, vw: c, n: 1000 });
function sessions(n: number, last = '2026-10-20') {
  const out: string[] = [];
  for (let t = Date.parse(`${last}T00:00:00Z`); out.length < n; t -= 86_400_000) {
    const d = new Date(t).getUTCDay();
    if (d !== 0 && d !== 6) out.unshift(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}
/** 26 flat sessions, then a +9% close on 3x volume (a strong mover). */
const moverBody = () => ({ status: 'OK', results: sessions(26).map((d, i) => (i === 25 ? bar(d, 109, 15e6) : bar(d, 100, 5e6))) });

type Route = { status: number; body?: unknown; headers?: Record<string, string> };
function router(route: (ticker: string) => Route) {
  const urls: string[] = [];
  const auth: (string | undefined)[] = [];
  const fn: FetchLike = async (url, init) => {
    urls.push(url);
    auth.push(init?.headers?.authorization);
    const r = route(decodeURIComponent(/\/ticker\/([^/]+)\//.exec(url)![1]!));
    return { ok: r.status < 300, status: r.status, headers: { get: (n: string) => r.headers?.[n.toLowerCase()] ?? null }, text: async () => (r.body === undefined ? '' : JSON.stringify(r.body)) };
  };
  return { fn, urls, auth };
}
async function fetchWith(route: (ticker: string) => Route, universe: string[], maxCalls: number) {
  const r = router(route);
  const sleeps: number[] = [];
  const client = createHttpClient({ fetch: r.fn, baseUrl: 'https://api.massive.com', apiKeyHeader: 'authorization', apiKey: `Bearer ${KEY}`, maxCalls, sleep: async () => {} });
  const data = await fetchStockDataset({ client, clock: () => NOW, universe, maxCalls, sleep: async (ms) => void sleeps.push(ms) });
  return { data, ...r, sleeps };
}

test('parseDailyBars: session dates come from the start-of-window timestamp in New York time', () => {
  const { bars, droppedCurrentSession } = parseDailyBars({ status: 'OK', results: [bar('2026-10-19', 10, 5), bar('2026-10-20', 11, 6)] }, NOW);
  assert.deepEqual(bars, [{ date: '2026-10-19', close: 10, volume: 5 }, { date: '2026-10-20', close: 11, volume: 6 }]);
  assert.equal(droppedCurrentSession, 0);
  assert.deepEqual(parseDailyBars({ status: 'OK', resultsCount: 0 }, NOW).bars, []); // no results: no bars, nothing invented
  assert.throws(() => parseDailyBars([], NOW), MassiveResponseError);
  assert.throws(() => parseDailyBars({ results: 'x' }, NOW), MassiveResponseError);
});

test('parseDailyBars: a bar for the current session is dropped until 20:00 ET, then used', () => {
  const body = { results: [bar('2026-10-20', 10, 5), bar('2026-10-21', 11, 6)] };
  assert.deepEqual(parseDailyBars(body, new Date('2026-10-21T23:59:00Z')).droppedCurrentSession, 1); // 19:59 ET
  assert.deepEqual(parseDailyBars(body, new Date('2026-10-22T00:00:00Z')).bars.length, 2); // 20:00 ET
});

test('fetchStockDataset: one documented request per ticker, key only in the Authorization header, spaced for 5 calls/minute', async () => {
  const { data, urls, auth, sleeps } = await fetchWith(() => ({ status: 200, body: moverBody() }), ['AAA', 'BBB'], 5);
  assert.deepEqual(urls, [
    'https://api.massive.com/v2/aggs/ticker/AAA/range/1/day/2026-09-06/2026-10-21?adjusted=true&limit=120&sort=asc',
    'https://api.massive.com/v2/aggs/ticker/BBB/range/1/day/2026-09-06/2026-10-21?adjusted=true&limit=120&sort=asc',
  ]);
  assert.ok(urls.every((u) => !u.includes(KEY)));
  assert.deepEqual(auth, [`Bearer ${KEY}`, `Bearer ${KEY}`]);
  assert.deepEqual(sleeps, [MASSIVE_MIN_INTERVAL_MS]); // between requests, not before the first
  assert.equal(data.dataset.kind, 'live');
  assert.equal(data.stocks[0]!.bars!.length, 26);
});

test('fetchStockDataset: the request limit, failures and rate limits mark tickers as not evaluated; nothing is filled in', async () => {
  const capped = await fetchWith(() => ({ status: 200, body: moverBody() }), ['AAA', 'BBB', 'CCC'], 2);
  assert.equal(capped.urls.length, 2);
  assert.deepEqual(capped.data.stocks.map((s) => s.historyStatus ?? 'fetched'), ['fetched', 'fetched', 'not_requested']);
  assert.ok(capped.data.dataset.notes.some((n) => n.includes('Daily bars not requested for 1 ticker(s) (CCC) because the per-run limit of 2 requests was reached')), capped.data.dataset.notes.join(' | '));

  const mixed = await fetchWith((t) => (t === 'AAA' ? { status: 500 } : t === 'BBB' ? { status: 200, body: [] } : { status: 429 }), ['AAA', 'BBB', 'CCC', 'DDD'], 10);
  assert.equal(mixed.urls.length, 3); // DDD is never requested after the 429
  assert.deepEqual(mixed.data.stocks.map((s) => s.historyStatus), ['request_failed', 'request_failed', 'request_failed', 'not_requested']);
  assert.ok(mixed.data.dataset.notes.some((n) => n.includes('because the provider rate-limited the run')), mixed.data.dataset.notes.join(' | '));
  assert.ok(mixed.data.stocks.every((s) => s.bars === undefined));
});

function deps(over: Partial<ScanCommandDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  let calls = 0;
  const d: ScanCommandDeps = { env: {}, fetch: async () => { calls++; throw new Error('fetch must not be called'); }, clock: () => NOW, out: (t) => out.push(t), err: (t) => err.push(t), sleep: async () => {}, ...over };
  return { d, out, err, calls: () => calls };
}

test('scan stocks: fixture by default with no network; --live without the key fails before any request', async () => {
  const t = deps();
  assert.equal(await runScanCommand(['stocks'], t.d), 0, t.err.join('\n'));
  assert.match(t.out.join('\n'), /^US STOCK SCAN - 2026-10-21 07:30 ET\n!! TEST DATA/);
  assert.equal(t.calls(), 0);
  for (const env of [{}, { POLYGON_API_KEY: '  ' }]) {
    const k = deps({ env });
    assert.equal(await runScanCommand(['stocks', '--live'], k.d), 1);
    assert.match(k.err.join('\n'), /POLYGON_API_KEY.*No request was made/s);
    assert.equal(k.calls(), 0);
  }
  for (const args of [['stocks', '--max-requests', '3'], ['stocks', '--live', '--fixture', 'x.json'], ['stocks', '--live', '--now', '2026-10-21T00:00:00Z'], ['stocks', '--live', '--max-requests', '0']]) {
    const bad = deps({ env: { POLYGON_API_KEY: KEY } });
    assert.equal(await runScanCommand(args, bad.d), 1, args.join(' '));
    assert.equal(bad.calls(), 0, args.join(' '));
  }
});

test('scan stocks --live (mocked): capped run, attributed VERIFIED DATA report, partial coverage, valid JSON, no key in output', async () => {
  const r = router(() => ({ status: 200, body: moverBody() }));
  const t = deps({ env: { POLYGON_API_KEY: KEY }, fetch: r.fn });
  assert.equal(await runScanCommand(['stocks', '--live', '--max-requests', '2'], t.d), 0, t.err.join('\n'));
  assert.equal(r.urls.length, 2);
  const report = t.out.join('\n');
  const flat = report.replace(/\s+/g, ' ');
  assert.match(report, /^Attribution: Market data provided by Massive \(https:\/\/massive\.com\), formerly Polygon\.io$/m);
  assert.ok(flat.includes(`Universe: ${STOCK_UNIVERSE.length} tickers; 2 passed all filters; ${STOCK_UNIVERSE.length - 2} excluded (${STOCK_UNIVERSE.length - 2} not evaluated`), report);
  assert.match(report, /AAPL\s+\$109\.00\s+\+9\.0% 1d/);
  assert.match(report, /\[VERIFIED DATA\]/);
  assert.doesNotMatch(report, /TEST DATA/);
  const json = deps({ env: { POLYGON_API_KEY: KEY }, fetch: router(() => ({ status: 200, body: moverBody() })).fn });
  assert.equal(await runScanCommand(['stocks', '--live', '--max-requests', '1', '--json'], json.d), 0);
  const parsed = JSON.parse(json.out.join('\n'));
  assert.deepEqual([parsed.movers.length, parsed.notEvaluated.notRequested], [1, STOCK_UNIVERSE.length - 1]);
  for (const s of [report, t.err.join(''), json.out.join(''), json.err.join('')]) assert.ok(!s.includes(KEY));
});
