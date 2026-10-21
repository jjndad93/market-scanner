import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { renderOptionScanReport } from '../src/options-scan/render.ts';
import { OPTION_SCAN_RULES, runOptionScan, toEvaluatorInput, validateContract } from '../src/options-scan/scan.ts';
import { THRESHOLDS } from '../src/options/evaluate.ts';
import { type FetchLike, createHttpClient } from '../src/providers/http.ts';
import { fetchOptionChains, nanosToMs, parseOptionChain } from '../src/providers/massive-options.ts';
import { type ScanCommandDeps, runScanCommand } from '../src/scanner/command.ts';

// Network guard: all provider traffic below goes through injected mock fetches.
globalThis.fetch = (() => {
  throw new Error('Network access is not allowed in tests.');
}) as typeof fetch;

// SYNTHETIC TEST DATA: invented contracts in the provider's documented snapshot format.
const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/options-scan.synthetic.json', import.meta.url), 'utf8'));
const NOW = new Date('2026-10-21T13:30:00Z'); // 09:30 ET
const KEY = 'TEST-OPTIONS-KEY-not-real-321';
const scanFixture = () => runOptionScan(FIXTURE, NOW);
const ns = (iso: string) => Date.parse(iso) * 1e6;
/** One snapshot-shaped contract (SYNTHETIC). */
const snap = (o: Record<string, unknown> = {}) => ({
  details: { contract_type: 'call', exercise_style: 'american', expiration_date: '2026-11-20', strike_price: 105, ticker: 'O:SYNX261120C00105000' },
  day: { volume: 300 }, last_quote: { bid: 2.4, ask: 2.5, last_updated: ns('2026-10-20T20:00:00Z') }, last_trade: { price: 2.45, sip_timestamp: ns('2026-10-20T19:59:00Z') },
  open_interest: 1000, implied_volatility: 0.3, greeks: { delta: 0.4, gamma: 0.04, theta: -0.05, vega: 0.1 }, underlying_asset: { price: 100, ticker: 'SYNX' }, ...o,
});
const one = (o: Record<string, unknown>) => validateContract(parseOptionChain({ results: [snap(o)] }, 'SYNX').contracts[0]!, NOW);
const codeOf = (o: Record<string, unknown>) => one(o).reasons.map((r) => r.code);

test('fixture scan: counts, ranking, insufficient data, puts not evaluated, and recorded exclusion reasons', () => {
  const r = scanFixture();
  assert.deepEqual(r.counts, { retrieved: 15, excluded: 9, eligible: 6, evaluated: 5, ranked: 4, insufficient: 1, putsNotEvaluated: 1 });
  assert.deepEqual(r.underlyings, { scanned: 2, failed: ['SYNC'], notRequested: [], truncated: ['SYNB'] });
  assert.deepEqual(r.ranked.map((c) => [c.rank, c.contract.ticker, c.verdict]), [
    [1, 'O:SYNA261120C00100000', 'MIXED'], [2, 'O:SYNA261120C00105000', 'MIXED'], [3, 'O:SYNB261218C00042000', 'MIXED'], [4, 'O:SYNA261120C00110000', 'WEAK'],
  ]);
  assert.deepEqual(r.insufficient.map((i) => i.ticker), ['O:SYNA261120C00080000']);
  assert.deepEqual(r.putsNotEvaluated, ['O:SYNA261120P00095000']);
  assert.deepEqual(Object.fromEntries(r.exclusions.map((e) => [e.code, e.count])), {
    crossed_market: 1, expired: 1, incomplete: 1, low_open_interest: 1, missing_quote: 1, no_offer: 1, stale_quote: 1, too_short: 1, wide_spread: 1,
  });
});

test('filters: each unsuitable contract gets its reason; thresholds are the evaluator\'s own', () => {
  assert.deepEqual([OPTION_SCAN_RULES.maxSpreadOfMid, OPTION_SCAN_RULES.minOpenInterest, OPTION_SCAN_RULES.minDaysToExpiration], [THRESHOLDS.spreadFail, THRESHOLDS.openInterestFail, THRESHOLDS.shortDte]);
  assert.deepEqual(codeOf({}), []); // valid call
  assert.deepEqual(codeOf({ details: { ...snap().details, contract_type: 'put' } }), []); // valid put
  assert.deepEqual(codeOf({ details: { ...snap().details, expiration_date: '2026-10-20' } }), ['expired']);
  assert.deepEqual(codeOf({ details: { ...snap().details, expiration_date: '2026-10-27' } }), ['too_short']); // 6 days
  assert.deepEqual(codeOf({ details: { ...snap().details, expiration_date: '2026-10-28' } }), []); // exactly 7 days
  assert.deepEqual(codeOf({ last_quote: { bid: 2.6, ask: 2.5, last_updated: ns('2026-10-20T20:00:00Z') } }), ['crossed_market']);
  assert.deepEqual(codeOf({ last_quote: { bid: 0, ask: 0, last_updated: ns('2026-10-20T20:00:00Z') } }), ['no_offer']);
  assert.deepEqual(codeOf({ last_quote: { bid: 2.0, ask: 2.5, last_updated: ns('2026-10-20T20:00:00Z') } }), ['wide_spread']); // 22% of mid
  assert.deepEqual(codeOf({ last_quote: { bid: 2.38, ask: 2.62, last_updated: ns('2026-10-20T20:00:00Z') } }), []); // 9.6%: allowed
  assert.deepEqual(codeOf({ last_quote: { bid: 2.4, ask: 2.5, last_updated: ns('2026-10-16T20:00:00Z') } }), ['stale_quote']); // 4.7 days
  assert.deepEqual(codeOf({ last_quote: { bid: 2.4, ask: 2.5 } }), ['stale_quote']); // undated
  assert.deepEqual(codeOf({ last_quote: undefined }), ['missing_quote']);
  assert.deepEqual(codeOf({ last_quote: { ask: 2.5, last_updated: ns('2026-10-20T20:00:00Z') } }), ['missing_quote']);
  assert.deepEqual(codeOf({ open_interest: 99 }), ['low_open_interest']);
  assert.deepEqual(codeOf({ open_interest: undefined }), []); // liquidity unknown is not a reason to exclude (the evaluator flags it)
  assert.deepEqual(codeOf({ details: { ...snap().details, strike_price: 'x' }, underlying_asset: { ticker: 'SYNX' } }), ['incomplete']);
  assert.match(one({ details: { ...snap().details, strike_price: 'x' }, underlying_asset: { ticker: 'SYNX' } }).reasons[0]!.detail, /strike, underlying price/);
});

test('missing provider fields stay missing; nothing becomes zero', () => {
  const { contract } = one({ implied_volatility: undefined, greeks: undefined, day: {}, last_trade: undefined, open_interest: 'n/a' });
  assert.deepEqual([contract!.iv, contract!.delta, contract!.volume, contract!.last, contract!.openInterest], [null, null, null, null, null]);
  const input = toEvaluatorInput(contract!, 'live', 'Example source');
  for (const k of ['quotedIV', 'quotedDelta', 'volume', 'last', 'openInterest'] as const) {
    assert.equal(input[k].kind, 'missing', k);
    assert.equal(input[k].value, null, k);
  }
});

test('provenance: provider quotes are VERIFIED DATA, provider IV/Greeks THIRD-PARTY, fixtures TEST DATA', () => {
  const c = one({}).contract!;
  const live = toEvaluatorInput(c, 'live', 'Example source');
  assert.deepEqual([live.bid.kind, live.ask.kind, live.stockPrice.kind, live.strike.kind], ['verified_market_data', 'verified_market_data', 'verified_market_data', 'verified_market_data']);
  assert.deepEqual([live.quotedIV.kind, live.quotedDelta.kind], ['third_party', 'third_party']);
  assert.equal(live.bid.asOf, '2026-10-20T20:00:00.000Z');
  assert.equal(live.premium.kind, 'missing'); // no premium is assumed; the evaluator uses the ask
  assert.equal(live.multiplier.kind, 'estimate'); // the evaluator's own default, unchanged
  const fixture = toEvaluatorInput(c, 'synthetic', 'Synthetic');
  assert.ok([fixture.bid, fixture.quotedIV, fixture.stockPrice].every((e) => e.kind === 'test_data'));
});

test('report: TEST DATA labels, honest ranking text, exclusions and notes, lines within 100 characters', () => {
  const text = renderOptionScanReport(scanFixture());
  assert.match(text, /^US OPTIONS DISCOVERY - 2026-10-21 09:30 ET\n!! TEST DATA/);
  assert.match(text.replace(/\s+/g, ' '), /A rule-based order, not a profit forecast\./);
  assert.match(text, /No contract is safe or certain to profit\./);
  assert.match(text, /NOT RANKED - insufficient data for the evaluator \(1\)/);
  assert.match(text, /ELIGIBLE PUTS - not evaluated: the option evaluator handles calls only \(1\)/);
  assert.match(text, /spread too wide: 1 \(e\.g\. O:SYNA261218C00120000\)/);
  assert.match(text, /provider IV n\/a \| provider delta n\/a/);
  assert.match(text.replace(/\s+/g, ' '), /only the first page was used \(no pagination yet\)/);
  // ("implied volatility is undefined." is the evaluator's own sentence; a stray JS undefined is not followed by a period.)
  assert.doesNotMatch(text, /VERIFIED DATA|Attribution:|undefined(?!\.)|NaN/);
  assert.ok(text.split('\n').every((l) => l.length <= 100), text.split('\n').find((l) => l.length > 100));
  assert.equal(nanosToMs(ns('2026-10-20T20:00:00Z')), Date.parse('2026-10-20T20:00:00Z'));
  assert.equal(nanosToMs('x'), null);
});

// ---- live path with mocked fetch only -----------------------------------------------------------

type Route = { status: number; body?: unknown; headers?: Record<string, string> };
function router(route: (underlying: string, n: number) => Route) {
  const urls: string[] = [];
  const auth: (string | undefined)[] = [];
  const fn: FetchLike = async (url, init) => {
    urls.push(url);
    auth.push(init?.headers?.authorization);
    const r = route(decodeURIComponent(/\/options\/([^/?]+)/.exec(url)![1]!), urls.length);
    return { ok: r.status < 300, status: r.status, headers: { get: (h: string) => r.headers?.[h.toLowerCase()] ?? null }, text: async () => (r.body === undefined ? '' : JSON.stringify(r.body)) };
  };
  return { fn, urls, auth };
}
const chain = { status: 'OK', results: [snap()] };
async function fetchWith(route: (u: string, n: number) => Route, underlyings: string[], maxCalls: number) {
  const r = router(route);
  const client = createHttpClient({ fetch: r.fn, baseUrl: 'https://api.massive.com', apiKeyHeader: 'authorization', apiKey: `Bearer ${KEY}`, maxCalls, sleep: async () => {} });
  const data = await fetchOptionChains({ client, clock: () => NOW, underlyings, maxCalls, sleep: async () => {} });
  return { data, ...r };
}

test('requests: one documented request per underlying, key only in the Authorization header', async () => {
  const { data, urls, auth } = await fetchWith(() => ({ status: 200, body: chain }), ['SYNX', 'SYNY'], 5);
  assert.deepEqual(urls, [
    'https://api.massive.com/v3/snapshot/options/SYNX?expiration_date.gte=2026-10-28&expiration_date.lte=2026-12-20&limit=250',
    'https://api.massive.com/v3/snapshot/options/SYNY?expiration_date.gte=2026-10-28&expiration_date.lte=2026-12-20&limit=250',
  ]);
  assert.ok(urls.every((u) => !u.includes(KEY)));
  assert.deepEqual(auth, [`Bearer ${KEY}`, `Bearer ${KEY}`]);
  assert.equal(runOptionScan(data, NOW).counts.retrieved, 2);
});

test('request budget counts retries; a refused plan (403) stops the run with the exact missing capability', async () => {
  // A 429 with Retry-After 0 is retried once, using the second (last) allowed request; SYNY is never requested.
  const capped = await fetchWith((_u, n) => (n === 1 ? { status: 429, headers: { 'retry-after': '0' } } : { status: 200, body: chain }), ['SYNX', 'SYNY'], 2);
  assert.equal(capped.urls.length, 2);
  assert.deepEqual(capped.data.chains.map((c) => c.status ?? 'fetched'), ['fetched', 'not_requested']);
  assert.ok(capped.data.dataset.notes.some((n) => n.includes('2 of 2 allowed requests used')));

  const refused = await fetchWith(() => ({ status: 403, body: { status: 'NOT_AUTHORIZED' } }), ['SYNX', 'SYNY', 'SYNZ'], 10);
  assert.equal(refused.urls.length, 1); // every later request would fail the same way
  assert.deepEqual(refused.data.chains.map((c) => c.status), ['request_failed', 'not_requested', 'not_requested']);
  const notes = refused.data.dataset.notes.join(' ');
  assert.match(notes, /HTTP 403\): the option-chain snapshot needs a Massive options plan that includes Snapshot \(Options Starter or higher; the free Options Basic plan excludes it\)/);
  const report = renderOptionScanReport(runOptionScan(refused.data, NOW));
  assert.match(report, /Underlyings: 0 scanned; 1 failed, 2 not requested\. PARTIAL SCAN\./);
  assert.match(report, /No contract could be ranked among the underlyings that were scanned\./);
});

function deps(over: Partial<ScanCommandDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  let calls = 0;
  const d: ScanCommandDeps = { env: {}, fetch: async () => { calls++; throw new Error('fetch must not be called'); }, clock: () => NOW, out: (t) => out.push(t), err: (t) => err.push(t), sleep: async () => {}, ...over };
  return { d, out, err, calls: () => calls };
}

test('command: offline by default with zero requests; no key means no request; flags validated before any request', async () => {
  const t = deps({ env: { POLYGON_API_KEY: KEY } }); // even with a key, no request without --live
  assert.equal(await runScanCommand(['options'], t.d), 0, t.err.join('\n'));
  assert.equal(t.calls(), 0);
  assert.match(t.out.join('\n'), /^US OPTIONS DISCOVERY/);
  const json = deps();
  assert.equal(await runScanCommand(['options', '--json'], json.d), 0);
  assert.equal(JSON.parse(json.out.join('\n')).counts.ranked, 4);
  const noKey = deps();
  assert.equal(await runScanCommand(['options', '--live'], noKey.d), 1);
  assert.match(noKey.err.join('\n'), /POLYGON_API_KEY.*No request was made/s);
  assert.equal(noKey.calls(), 0);
  for (const args of [['options', '--symbols', 'AAPL'], ['options', '--live', '--symbols', 'bad symbol!'], ['options', '--live', '--max-requests', '0'], ['options', '--live', '--now', '2026-10-21T00:00:00Z']]) {
    const bad = deps({ env: { POLYGON_API_KEY: KEY } });
    assert.equal(await runScanCommand(args, bad.d), 1, args.join(' '));
    assert.equal(bad.calls(), 0, args.join(' '));
  }
});

test('command --live (mocked): attributed VERIFIED DATA report within the request limit; key never in output', async () => {
  const r = router(() => ({ status: 200, body: chain }));
  const t = deps({ env: { POLYGON_API_KEY: KEY }, fetch: r.fn });
  assert.equal(await runScanCommand(['options', '--live', '--symbols', 'SYNX,SYNY', '--max-requests', '1'], t.d), 0, t.err.join('\n'));
  assert.equal(r.urls.length, 1);
  const report = t.out.join('\n');
  assert.match(report, /^Attribution: Options data provided by Massive \(https:\/\/massive\.com\), formerly Polygon\.io$/m);
  assert.match(report, /\[VERIFIED DATA\]/);
  assert.doesNotMatch(report, /TEST DATA/);
  assert.match(report, /1 scanned; 0 failed, 1 not requested\. PARTIAL SCAN/);
  assert.ok(![report, t.err.join('')].some((s) => s.includes(KEY)));
});
