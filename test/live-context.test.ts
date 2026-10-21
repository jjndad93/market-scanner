import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { nyWallTimeToUtc } from '../src/core/time.ts';
import { evaluateCall } from '../src/options/evaluate.ts';
import { applyLiveContext, calculateLiveContext, renderLiveContext } from '../src/options/live-context.ts';
import { parseContractText } from '../src/options/parse.ts';
import type { FetchLike } from '../src/providers/http.ts';

// Network guard: every request below goes through an injected mock fetch.
globalThis.fetch = (() => {
  throw new Error('Network access is not allowed in tests.');
}) as typeof fetch;

// SYNTHETIC data: invented closes in the provider's documented response format.
const KEY = 'TEST-POLYGON-KEY-not-real-456';
const NOW = new Date('2026-10-21T01:30:00Z'); // 2026-10-20 21:30 ET, after that session completed
const EXAMPLE = readFileSync(new URL('../examples/hypothetical-contract.txt', import.meta.url), 'utf8');
/** The example contract (XMPL) without its pasted historical volatility, and with/without a trend. */
const withoutHv = (text: string) => text.split('\n').filter((l) => !/^Historical volatility:/i.test(l)).join('\n');

function sessions(n: number, last = '2026-10-20') {
  const out: string[] = [];
  for (let t = Date.parse(`${last}T00:00:00Z`); out.length < n; t -= 86_400_000) {
    const d = new Date(t).getUTCDay();
    if (d !== 0 && d !== 6) out.unshift(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}
/** Closes alternating +2% / -1% from 50, so the expected values can be computed independently. */
const CLOSES = (() => {
  const c = [50];
  for (let i = 1; i < 30; i++) c.push(c[i - 1]! * (i % 2 ? 1.02 : 0.99));
  return c;
})();
const body = (closes = CLOSES, last = '2026-10-20') => ({
  status: 'OK',
  results: sessions(closes.length, last).map((d, i) => ({ t: nyWallTimeToUtc(d, 0, 0).getTime(), c: closes[i], v: 1e6, o: closes[i], h: closes[i], l: closes[i] })),
});
function fakeFetch(answer: () => { status: number; body?: unknown; headers?: Record<string, string> }) {
  const urls: string[] = [];
  const auth: (string | undefined)[] = [];
  const fn: FetchLike = async (url, init) => {
    urls.push(url);
    auth.push(init?.headers?.authorization);
    const a = answer();
    return { ok: a.status < 300, status: a.status, headers: { get: (n: string) => a.headers?.[n.toLowerCase()] ?? null }, text: async () => (a.body === undefined ? '' : JSON.stringify(a.body)) };
  };
  return { fn, urls, auth };
}
const deps = (fetch: FetchLike, env: Record<string, string> = { POLYGON_API_KEY: KEY }) => ({ env, fetch, clock: () => NOW });

/** Independent reference: sample std dev of the last 20 log returns x sqrt(252); 20-session % change. */
function expected(closes: number[]) {
  const w = closes.slice(-21);
  const r = w.slice(1).map((c, i) => Math.log(c / w[i]!));
  const m = r.reduce((a, x) => a + x, 0) / r.length;
  return { hv: Math.sqrt(r.reduce((a, x) => a + (x - m) ** 2, 0) / (r.length - 1)) * Math.sqrt(252), trend: (w[20]! / w[0]! - 1) * 100 };
}

test('calculation: 20-return historical volatility and 20-session trend; too few, gapped or stale bars are refused', () => {
  const bars = sessions(30).map((date, i) => ({ date, close: CLOSES[i]!, volume: 1 }));
  const c = calculateLiveContext(bars, NOW);
  assert.ok(!('reason' in c));
  const e = expected(CLOSES);
  assert.ok(Math.abs(c.hv - e.hv) < 1e-12 && Math.abs(c.trendPct - e.trend) < 1e-9);
  assert.deepEqual([c.latest, c.from], ['2026-10-20', bars[9]!.date]);
  assert.match((calculateLiveContext(bars.slice(-20), NOW) as { reason: string }).reason, /only 20 usable daily bar\(s\); 21 are needed/);
  const gapped = [...bars.slice(0, 15), ...bars.slice(15).map((b) => ({ ...b, date: b.date }))];
  gapped.splice(15, 3); // remove 3 sessions in the middle of the window
  assert.match((calculateLiveContext(gapped, NOW) as { reason: string }).reason, /gap between daily bars/);
  assert.match((calculateLiveContext(bars, new Date('2026-10-30T12:00:00Z')) as { reason: string }).reason, /not a recent completed session/);
});

test('empty fields are filled with CALCULATED values and used by the evaluation; one request, key only in the header', async () => {
  const parsed = parseContractText(withoutHv(EXAMPLE));
  const f = fakeFetch(() => ({ status: 200, body: body() }));
  const { context, result } = await applyLiveContext(parsed.contract, parsed.context, deps(f.fn));
  assert.equal(f.urls.length, 1);
  assert.ok(f.urls[0]!.startsWith('https://api.massive.com/v2/aggs/ticker/XMPL/range/1/day/') && !f.urls[0]!.includes(KEY));
  assert.deepEqual(f.auth, [`Bearer ${KEY}`]);
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;
  assert.deepEqual([result.hvRole, result.trendRole], ['active', 'active']);
  assert.equal(context.historicalVol.kind, 'calculated');
  assert.ok(Math.abs(context.historicalVol.value! - expected(CLOSES).hv) < 1e-12);
  assert.equal(context.historicalVol.asOf, nyWallTimeToUtc('2026-10-20', 16, 0).toISOString());
  assert.match(context.trend.value!, /^up \d+\.\d% over 20 sessions \(\d{4}-\d{2}-\d{2} close to 2026-10-20 close\)$/);
  const ev = evaluateCall(parsed.contract, context, { now: NOW });
  const hvMetric = ev.metrics.find((m) => m.label === 'Historical volatility')!;
  assert.equal(hvMetric.evidence.kind, 'calculated');
  const text = renderLiveContext(result);
  assert.match(text, /latest completed session 2026-10-20/);
  assert.match(text, /\[CALCULATED\] - sample standard deviation of the last 20 daily log returns x sqrt\(252\)/);
  assert.match(text, /Used as the active input: nothing was pasted for this field\./);
  assert.ok(!text.includes(KEY));
});

test('pasted values keep priority: the fetched figures are shown only as a cross-check', async () => {
  const parsed = parseContractText(`${EXAMPLE}\nTrend: up 6% over 20 trading days`);
  const { context, result } = await applyLiveContext(parsed.contract, parsed.context, deps(fakeFetch(() => ({ status: 200, body: body() })).fn));
  assert.equal(context.historicalVol, parsed.context.historicalVol); // the same pasted evidence, untouched
  assert.equal(context.trend, parsed.context.trend);
  assert.equal(context.historicalVol.kind, 'user_provided');
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;
  assert.deepEqual([result.hvRole, result.trendRole], ['cross-check', 'cross-check']);
  const text = renderLiveContext(result);
  assert.match(text, /Cross-check only: your pasted value 33\.0% \[YOU PROVIDED\] stays the active input\./);
  assert.match(text, /Cross-check only: your pasted value "up 6% over 20 trading days" \[YOU PROVIDED\] stays the active input\./);
  // The evaluation is exactly what it would be without live context.
  assert.deepEqual(evaluateCall(parsed.contract, context, { now: NOW }), evaluateCall(parsed.contract, parsed.context, { now: NOW }));
});

test('missing key, missing ticker, failed request, rate limit and short history leave the inputs unchanged', async () => {
  const parsed = parseContractText(withoutHv(EXAMPLE));
  const never = fakeFetch(() => {
    throw new Error('must not be called');
  });
  const noKey = await applyLiveContext(parsed.contract, parsed.context, deps(never.fn, {}));
  assert.deepEqual(noKey.result, { status: 'unavailable', symbol: 'XMPL', reason: 'the POLYGON_API_KEY environment variable is not set', requestsMade: 0 });
  const noTicker = parseContractText(withoutHv(EXAMPLE).replace(/^Underlying:.*$/m, ''));
  assert.equal((await applyLiveContext(noTicker.contract, noTicker.context, deps(never.fn))).result.status, 'unavailable');
  assert.equal(never.urls.length, 0);

  const cases: [string, () => { status: number; body?: unknown; headers?: Record<string, string> }, RegExp][] = [
    ['HTTP 500', () => ({ status: 500 }), /request failed or was rate-limited/],
    ['429 with Retry-After 0', () => ({ status: 429, headers: { 'retry-after': '0' } }), /request failed or was rate-limited \(no retry by design\)/],
    ['short history', () => ({ status: 200, body: body(CLOSES.slice(0, 15)) }), /only 15 usable daily bar\(s\)/],
    ['malformed body', () => ({ status: 200, body: [] }), /request failed or was rate-limited/],
  ];
  for (const [name, answer, reason] of cases) {
    const f = fakeFetch(answer);
    const { context, result } = await applyLiveContext(parsed.contract, parsed.context, deps(f.fn));
    assert.equal(f.urls.length, 1, `${name}: exactly one attempt, never a retry`);
    assert.equal(context, parsed.context, name);
    assert.equal(result.status, 'unavailable', name);
    if (result.status === 'unavailable') {
      assert.match(result.reason, reason, name);
      assert.match(renderLiveContext(result), /could not be calculated - .*\n {2}Requests made: 1 of 1\. Your pasted inputs are unchanged; nothing was filled in\./);
    }
  }
});

test('opt-in boundary: --live-context without a key makes no request and still reports; --now is refused with it', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const { POLYGON_API_KEY: _a, COINGECKO_DEMO_API_KEY: _b, ...env } = process.env;
  const run = (...args: string[]) => spawnSync(process.execPath, ['src/cli.ts', 'option', '--file', 'examples/hypothetical-contract.txt', ...args], { cwd: root, encoding: 'utf8', env });
  const live = run('--live-context');
  assert.equal(live.status, 0, live.stderr);
  assert.match(live.stdout, /LIVE CONTEXT \(--live-context, XMPL\): could not be calculated - the POLYGON_API_KEY environment variable is not set\./);
  assert.match(live.stdout, /Requests made: 0 of 1/);
  const json = JSON.parse(run('--live-context', '--json').stdout);
  assert.equal(json.liveContext.status, 'unavailable');
  const both = run('--live-context', '--now', '2026-10-20T14:20:00Z');
  assert.equal(both.status, 1);
  assert.match(both.stderr, /--now cannot be combined with --live-context.*No request was made/);
  // Without the flag the JSON has no liveContext key at all (byte-identical output is checked separately).
  assert.equal('liveContext' in JSON.parse(run('--now', '2026-10-20T14:20:00Z', '--json').stdout), false);
});
