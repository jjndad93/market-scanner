import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DAY_MS } from '../src/core/time.ts';
import type { FetchLike } from '../src/providers/http.ts';
import { type ScanCommandDeps, runScanCommand } from '../src/scanner/command.ts';
import { normalizeDataset } from '../src/scanner/normalize.ts';
import { runScan } from '../src/scanner/analyze.ts';
import { renderScanReport } from '../src/scanner/render.ts';

// Network guard: the global fetch must never be used; live tests inject a mock.
globalThis.fetch = (() => {
  throw new Error('Network access is not allowed in tests.');
}) as typeof fetch;

const NOW = new Date('2026-10-21T12:00:00Z');
const KEY = 'TEST-KEY-not-real-zyx987';
const FIXTURE_URL = new URL('./fixtures/crypto-scan.synthetic.json', import.meta.url);

/** Deps whose fetch fails the test if it is ever called. */
function deps(over: Partial<ScanCommandDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  let fetchCalls = 0;
  const d: ScanCommandDeps = {
    env: {},
    fetch: async () => {
      fetchCalls++;
      throw new Error('fetch must not be called');
    },
    clock: () => NOW,
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    sleep: async () => {},
    ...over,
  };
  return { d, out, err, fetchCalls: () => fetchCalls };
}

test('fixture mode (default) never calls fetch and renders the bundled fixture at its snapshot time', async () => {
  const t = deps();
  assert.equal(await runScanCommand(['crypto'], t.d), 0);
  assert.equal(t.fetchCalls(), 0);
  const fx = JSON.parse(readFileSync(FIXTURE_URL, 'utf8'));
  const expected = renderScanReport(runScan(normalizeDataset(fx), new Date(fx.dataset.asOf)));
  assert.equal(t.out.join('\n'), expected);
});

test('--fixture and --now are honored; --json emits the structured result', async () => {
  const t = deps();
  assert.equal(await runScanCommand(['crypto', '--fixture', FIXTURE_URL.pathname.replace(/^\/([A-Za-z]:)/, '$1'), '--now', '2026-10-21T12:00:00Z', '--json'], t.d), 0);
  const parsed = JSON.parse(t.out.join('\n'));
  assert.equal(parsed.evaluatedAt, '2026-10-21T12:00:00.000Z');
  assert.deepEqual(parsed.movers.map((c: { asset: { symbol: string } }) => c.asset.symbol), ['SALP', 'SBRV']);
  assert.equal(t.fetchCalls(), 0);
});

test('a fixture file that is not synthetic is refused, so a file cannot pose as live data', async () => {
  const t = deps();
  const tmp = new URL('./fixtures/crypto-scan.synthetic.json', import.meta.url);
  const fx = JSON.parse(readFileSync(tmp, 'utf8'));
  fx.dataset.kind = 'live';
  const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'scan-test-'));
  try {
    const file = join(dir, 'live-pretend.json');
    writeFileSync(file, JSON.stringify(fx));
    assert.equal(await runScanCommand(['crypto', '--fixture', file], t.d), 1);
    assert.match(t.err.join('\n'), /must declare "kind": "synthetic"/);
    assert.equal(t.out.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--live without the key fails before any request; empty or blank keys count as missing', async () => {
  for (const env of [{}, { COINGECKO_DEMO_API_KEY: '' }, { COINGECKO_DEMO_API_KEY: '   ' }]) {
    const t = deps({ env });
    assert.equal(await runScanCommand(['crypto', '--live'], t.d), 1);
    assert.equal(t.fetchCalls(), 0);
    assert.match(t.err.join('\n'), /No request was made/);
  }
});

test('invalid flag combinations and unknown markets are rejected without network access', async () => {
  for (const args of [['crypto', '--live', '--fixture', 'x.json'], ['crypto', '--live', '--now', '2026-10-21T12:00:00Z'], ['crypto', '--bogus'], ['stocks'], []]) {
    const t = deps({ env: { COINGECKO_DEMO_API_KEY: KEY } });
    assert.equal(await runScanCommand(args, t.d), 1, args.join(' '));
    assert.equal(t.fetchCalls(), 0, args.join(' '));
  }
});

// SYNTHETIC response-shaped data for a mocked live run.
const TODAY = Date.UTC(2026, 9, 21);
function liveFetch(fail = false) {
  const urls: string[] = [];
  const headers: Record<string, string>[] = [];
  const fn: FetchLike = async (url, init) => {
    urls.push(url);
    headers.push(init?.headers ?? {});
    const body = fail
      ? null
      : url.includes('/coins/markets')
        ? [{ id: 'syn-live', symbol: 'slv', name: 'Live-shaped Coin', current_price: 5, market_cap: 1e9, total_volume: 50e6, price_change_percentage_24h: 10, price_change_percentage_7d_in_currency: 12, last_updated: '2026-10-21T11:59:00Z' }]
        : { total_volumes: Array.from({ length: 35 }, (_, i) => [TODAY - (35 - i) * DAY_MS, 20e6]) };
    return { ok: !fail, status: fail ? 503 : 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };
  return { fn, urls, headers };
}

test('--live with a key runs end to end through the mocked provider, with attribution and no key in output', async () => {
  const f = liveFetch();
  const t = deps({ env: { COINGECKO_DEMO_API_KEY: KEY }, fetch: f.fn });
  assert.equal(await runScanCommand(['crypto', '--live'], t.d), 0, t.err.join('\n'));
  assert.equal(f.urls.length, 2);
  assert.ok(f.urls[0]!.startsWith('https://api.coingecko.com/api/v3/coins/markets?'));
  assert.ok(f.urls.every((u) => !u.includes(KEY)));
  assert.ok(f.headers.every((h) => h['x-cg-demo-api-key'] === KEY));
  const report = t.out.join('\n');
  assert.match(report, /^Attribution: Data provided by CoinGecko \(https:\/\/www\.coingecko\.com\)$/m);
  assert.match(report, /Live-shaped Coin \(SLV\)/);
  assert.doesNotMatch(report, /TEST DATA/);
  assert.ok(!report.includes(KEY) && !t.err.join('').includes(KEY));
});

test('--live provider failure produces no report and a clear error without the key', async () => {
  const t = deps({ env: { COINGECKO_DEMO_API_KEY: KEY }, fetch: liveFetch(true).fn });
  assert.equal(await runScanCommand(['crypto', '--live'], t.d), 1);
  assert.equal(t.out.length, 0);
  assert.match(t.err.join('\n'), /Live scan failed; no report was produced\. HTTP 503/);
  assert.ok(!t.err.join('').includes(KEY));
});

// ---- S7a: --max-requests and --history-diagnostics (mocked fetch only) -------------------------

test('S7a: --max-requests and --history-diagnostics are validated and need --live; rejections make no request', async () => {
  const bad: string[][] = [
    ['crypto', '--max-requests', '4'], // fixture mode
    ['crypto', '--history-diagnostics'], // fixture mode
    ...['0', '161', '1.5', '-1', 'abc', '', '1e2', ' 4', '04'].map((n) => ['crypto', '--live', '--max-requests', n]),
  ];
  for (const args of bad) {
    const counted = liveFetch();
    const t = deps({ env: { COINGECKO_DEMO_API_KEY: KEY }, fetch: counted.fn });
    assert.equal(await runScanCommand(args, t.d), 1, JSON.stringify(args));
    assert.equal(counted.urls.length, 0, JSON.stringify(args));
    assert.equal(t.out.length, 0, JSON.stringify(args));
  }
  // Without the key, a valid cap still fails before any request.
  const noKey = deps();
  assert.equal(await runScanCommand(['crypto', '--live', '--max-requests', '4'], noKey.d), 1);
  assert.equal(noKey.fetchCalls(), 0);
});

test('S7a: --max-requests caps every request, retries included', async () => {
  // Markets answers 429 (Retry-After 0) once, then 200: two attempts for one logical request.
  const urls: string[] = [];
  let marketsCalls = 0;
  const fn: FetchLike = async (url) => {
    urls.push(url);
    const isMarkets = url.includes('/coins/markets');
    if (isMarkets) marketsCalls++;
    const status = isMarkets && marketsCalls === 1 ? 429 : 200;
    const body = isMarkets
      ? [{ id: 'syn-live', symbol: 'slv', name: 'Live-shaped Coin', current_price: 5, market_cap: 1e9, total_volume: 50e6, price_change_percentage_24h: 10, price_change_percentage_7d_in_currency: 12, last_updated: '2026-10-21T11:59:00Z' }]
      : { total_volumes: [] };
    return { ok: status === 200, status, headers: { get: (n: string) => (n === 'retry-after' && status === 429 ? '0' : null) }, text: async () => JSON.stringify(body) };
  };
  // Cap 2: the retry uses the second request, so no history request fits.
  const t = deps({ env: { COINGECKO_DEMO_API_KEY: KEY }, fetch: fn });
  assert.equal(await runScanCommand(['crypto', '--live', '--max-requests', '2'], t.d), 0, t.err.join('\n'));
  assert.equal(urls.length, 2);
  assert.ok(urls.every((u) => u.includes('/coins/markets')));
  const flat = t.out.join('\n').replace(/\s+/g, ' ');
  assert.ok(flat.includes('2 of 2 allowed requests used'), flat);
  assert.ok(flat.includes('History not requested for 1 asset(s) (syn-live) because the per-run limit of 2 requests was reached'), flat);
  // Cap 1: the retry itself is refused, so the run fails after exactly one request.
  urls.length = 0;
  marketsCalls = 0;
  const one = deps({ env: { COINGECKO_DEMO_API_KEY: KEY }, fetch: fn });
  assert.equal(await runScanCommand(['crypto', '--live', '--max-requests', '1'], one.d), 1);
  assert.equal(urls.length, 1);
  // Remediation F1: the markets request WAS sent; only its retry was blocked by the budget.
  assert.ok(one.err.join('\n').includes('Rate limited on /coins/markets (HTTP 429); the retry was not sent because the call budget of 1 requests was reached.'), one.err.join('\n'));
  assert.ok(!one.err.join('\n').includes('was not requested'), one.err.join('\n'));
});

test('S7a: --history-diagnostics prints ids, counts and timestamps to stderr only, with no values, key or URLs', async () => {
  const f = liveFetch();
  const t = deps({ env: { COINGECKO_DEMO_API_KEY: KEY }, fetch: f.fn });
  assert.equal(await runScanCommand(['crypto', '--live', '--max-requests', '4', '--history-diagnostics', '--json'], t.d), 0, t.err.join('\n'));
  JSON.parse(t.out.join('\n')); // stdout stays valid JSON
  const diag = t.err.join('\n');
  const lines = diag.split('\n');
  assert.equal(lines[0], 'HISTORY DIAGNOSTICS (timestamps only; no volume values)');
  assert.equal(lines[1], '  syn-live: parsed; 35 points; first: 2026-09-16T00:00:00.000Z prior-midnight, 2026-09-17T00:00:00.000Z prior-midnight; ... 30 more ...; last: 2026-10-18T00:00:00.000Z prior-midnight, 2026-10-19T00:00:00.000Z prior-midnight, 2026-10-20T00:00:00.000Z prior-midnight');
  for (const forbidden of [KEY, '20000000', '2e7', 'https://', 'x-cg-demo-api-key', 'api.coingecko.com']) {
    assert.ok(!diag.includes(forbidden), `diagnostics leaked ${forbidden}`);
  }
  // Without the flag, nothing is printed to stderr on success.
  const quiet = deps({ env: { COINGECKO_DEMO_API_KEY: KEY }, fetch: liveFetch().fn });
  assert.equal(await runScanCommand(['crypto', '--live', '--max-requests', '4'], quiet.d), 0);
  assert.equal(quiet.err.length, 0);
});

test('F2: diagnostics escape control characters in provider ids, so they cannot clear the screen or forge lines', async () => {
  const evil = 'evil\u001b[2J\nFAKE: line\r\u0000\u007f\u009b';
  const fn: FetchLike = async (url) => {
    const body = url.includes('/coins/markets')
      ? [{ id: evil, symbol: 'ev', name: 'Live-shaped Coin', current_price: 5, market_cap: 1e9, total_volume: 50e6, price_change_percentage_24h: 10, price_change_percentage_7d_in_currency: 12, last_updated: '2026-10-21T11:59:00Z' }]
      : { total_volumes: Array.from({ length: 35 }, (_, i) => [TODAY - (35 - i) * DAY_MS, 20e6]) };
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };
  const t = deps({ env: { COINGECKO_DEMO_API_KEY: KEY }, fetch: fn });
  assert.equal(await runScanCommand(['crypto', '--live', '--max-requests', '4', '--history-diagnostics', '--json'], t.d), 0, t.err.join('\n'));
  const lines = t.err.join('\n').split('\n');
  assert.equal(lines.length, 2, `exactly one header and one asset line: ${JSON.stringify(lines)}`);
  assert.ok(lines[1]!.startsWith('  evil\\u001b[2J\\u000aFAKE: line\\u000d\\u0000\\u007f\\u009b: parsed; 35 points;'), lines[1]);
  for (const l of lines) assert.doesNotMatch(l, /[\u0000-\u001f\u007f-\u009f]/, 'no raw control characters');
});

test('report: provider ids, names and symbols are escaped in every rendered path; internal ids are unchanged', async () => {
  // SYNTHETIC hostile provider data: a shared symbol with a hostile id, a hostile name and symbol,
  // and conflicting duplicates (excluded) whose id contains control characters.
  const evilId = 'evil\u001b[2J\nFAKE: id';
  const dupId = 'dup\u001b]0;title\u0007\rFAKE: dup';
  const base = { current_price: 5, market_cap: 1e9, total_volume: 50e6, price_change_percentage_24h: 10, price_change_percentage_7d_in_currency: 12, last_updated: '2026-10-21T11:59:00Z' };
  const markets = [
    { ...base, id: evilId, symbol: 'same', name: 'Plain A' },
    { ...base, id: 'syn-ok', symbol: 'same', name: 'Plain B' },
    { ...base, id: 'syn-name', symbol: 'ab\u001b[31m', name: 'Name\u001b[2J\nFAKE: name\u009b' },
    { ...base, id: dupId, symbol: 'dp', name: 'Dup one' },
    { ...base, id: dupId, symbol: 'dp', name: 'Dup two' },
  ];
  const urls: string[] = [];
  const fn: FetchLike = async (url) => {
    urls.push(url);
    const body = url.includes('/coins/markets') ? markets : { total_volumes: Array.from({ length: 35 }, (_, i) => [TODAY - (35 - i) * DAY_MS, 20e6]) };
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };
  const text = deps({ env: { COINGECKO_DEMO_API_KEY: KEY }, fetch: fn });
  assert.equal(await runScanCommand(['crypto', '--live', '--max-requests', '10'], text.d), 0, text.err.join('\n'));
  const report = text.out.join('\n');
  const lines = report.split('\n');
  for (const l of lines) assert.doesNotMatch(l, /[\u0000-\u001f\u007f-\u009f]/, `raw control character in: ${JSON.stringify(l)}`);
  assert.ok(!lines.some((l) => l.startsWith('FAKE')), 'no forged line');
  // Every rendered path shows the escaped text.
  assert.ok(report.includes('Plain A (SAME, id evil\\u001b[2J\\u000aFAKE: id)'), 'mover line: assetLabel with escaped id');
  assert.ok(report.includes('Plain B (SAME, id syn-ok)'), 'safe values unchanged');
  assert.ok(report.includes('Name\\u001b[2J\\u000aFAKE: name\\u009b (AB\\u001b[31M)'), 'mover line: escaped name and symbol');
  assert.ok(report.includes('Symbol SAME is shared by ids evil\\u001b[2J\\u000aFAKE: id, syn-ok; check which asset is meant.'), 'DATA NOTES collision ids');
  assert.ok(report.includes('DP [id dup\\u001b]0;title\\u0007\\u000dFAKE: dup]'), 'EXCLUDED duplicate label');
  // Internal values are untouched: requests use the real id, and the structured result keeps it.
  assert.ok(urls.some((u) => u.includes(`/coins/${encodeURIComponent(evilId)}/market_chart`)), 'request used the raw id');
  const json = deps({ env: { COINGECKO_DEMO_API_KEY: KEY }, fetch: fn });
  assert.equal(await runScanCommand(['crypto', '--live', '--max-requests', '10', '--json'], json.d), 0);
  const result = JSON.parse(json.out.join('\n'));
  assert.ok(result.movers.some((c: { asset: { id: string } }) => c.asset.id === evilId), 'internal id unchanged');
  assert.ok(result.movers.some((c: { asset: { name: string } }) => c.asset.name === 'Name\u001b[2J\nFAKE: name\u009b'), 'internal name unchanged');
  assert.ok(result.excluded.some((e: { id: string }) => e.id === dupId), 'excluded id unchanged');
});

test('--json: DEL and C1 control characters are escaped in stdout, and values parse back unchanged', async () => {
  // SYNTHETIC hostile provider strings: JSON.stringify escapes U+0000-U+001F but not U+007F-U+009F.
  const name = 'Name\u007f DEL \u009b2J CSI \u0085 NEL';
  const symbol = 'x\u009by';
  const fn: FetchLike = async (url) => {
    const body = url.includes('/coins/markets')
      ? [{ id: 'syn-c1', symbol, name, current_price: 5, market_cap: 1e9, total_volume: 50e6, price_change_percentage_24h: 10, price_change_percentage_7d_in_currency: 12, last_updated: '2026-10-21T11:59:00Z' }]
      : { total_volumes: Array.from({ length: 35 }, (_, i) => [TODAY - (35 - i) * DAY_MS, 20e6]) };
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };
  const t = deps({ env: { COINGECKO_DEMO_API_KEY: KEY }, fetch: fn });
  assert.equal(await runScanCommand(['crypto', '--live', '--max-requests', '3', '--json'], t.d), 0, t.err.join('\n'));
  const stdout = t.out.join('\n');
  assert.doesNotMatch(stdout, /[\u007f-\u009f]/, 'no raw DEL/C1 characters in stdout');
  assert.ok(stdout.includes('\\u007f') && stdout.includes('\\u009b') && stdout.includes('\\u0085'), 'escaped as JSON \\u sequences');
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.movers[0].asset.name, name, 'original name preserved');
  assert.equal(parsed.movers[0].asset.symbol, 'X\u009bY', 'original (normalized) symbol preserved');
});

test('S6: a second live run on the same UTC day reuses cached histories from the local cache directory', async () => {
  const { mkdtempSync, rmSync, readdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'scan-cache-test-'));
  try {
    const env = { COINGECKO_DEMO_API_KEY: KEY, LOCALAPPDATA: dir };
    const first = liveFetch();
    const one = deps({ env, fetch: first.fn });
    assert.equal(await runScanCommand(['crypto', '--live', '--max-requests', '2'], one.d), 0, one.err.join('\n'));
    assert.equal(first.urls.length, 2); // markets + history
    const files = readdirSync(join(dir, 'market-scanner', 'coingecko-history'));
    assert.equal(files.length, 1);
    assert.ok(!files[0]!.includes('syn-live'), 'file names never contain provider ids');

    const second = liveFetch();
    const two = deps({ env, fetch: second.fn });
    assert.equal(await runScanCommand(['crypto', '--live', '--max-requests', '2', '--json'], two.d), 0, two.err.join('\n'));
    assert.equal(second.urls.length, 1); // markets only
    const result = JSON.parse(two.out.join('\n'));
    assert.deepEqual([result.dataset.coverage.historyFetched, result.dataset.coverage.historyFromCache, result.dataset.coverage.requestsUsed], [1, 1, 1]);
    assert.deepEqual(result.movers.map((c: { asset: { id: string } }) => c.asset.id), ['syn-live']);
    for (const s of [one.out.join(''), one.err.join(''), two.out.join(''), two.err.join('')]) assert.ok(!s.includes(KEY));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('partial coverage: a capped live run reports coverage in JSON and text, and still exits 0', async () => {
  // SYNTHETIC: two eligible coins that match no pattern (flat price, volume at its median); a cap
  // of 2 leaves room for the markets request and one history request only.
  const coinRow = (id: string) => ({ id, symbol: id.slice(4), name: `Live-shaped ${id}`, current_price: 5, market_cap: 1e9, total_volume: 50e6, price_change_percentage_24h: 0.5, price_change_percentage_7d_in_currency: 1, last_updated: '2026-10-21T11:59:00Z' });
  const urls: string[] = [];
  const fn: FetchLike = async (url) => {
    urls.push(url);
    const body = url.includes('/coins/markets')
      ? [coinRow('syn-one'), coinRow('syn-two')]
      : { total_volumes: Array.from({ length: 35 }, (_, i) => [TODAY - (35 - i) * DAY_MS, 50e6]) };
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };
  const json = deps({ env: { COINGECKO_DEMO_API_KEY: KEY }, fetch: fn });
  assert.equal(await runScanCommand(['crypto', '--live', '--max-requests', '2', '--json'], json.d), 0, json.err.join('\n'));
  assert.equal(urls.length, 2);
  const result = JSON.parse(json.out.join('\n'));
  assert.deepEqual(result.dataset.coverage, {
    historyEligible: 2, historyFetched: 1, historyFromCache: 0, historyRequestFailed: 0, historyNotRequested: 1, complete: false,
    stopReason: 'the per-run limit of 2 requests was reached', requestsUsed: 2, requestLimit: 2,
  });
  assert.deepEqual(result.excluded.map((e: { id: string; reasons: { code: string }[] }) => [e.id, e.reasons.map((r) => r.code)]), [['syn-two', ['history_not_requested']]]);
  assert.equal(result.passedFilters, 1);

  urls.length = 0;
  const text = deps({ env: { COINGECKO_DEMO_API_KEY: KEY }, fetch: fn });
  assert.equal(await runScanCommand(['crypto', '--live', '--max-requests', '2'], text.d), 0, text.err.join('\n'));
  assert.equal(urls.length, 2);
  const flat = text.out.join('\n').replace(/\s+/g, ' ');
  assert.ok(flat.includes('History coverage: fetched for 1 of 2 assets that passed the non-history filters; 0 failed; 1 not requested (the per-run limit of 2 requests was reached). PARTIAL SCAN.'), flat);
  assert.ok(flat.includes('so this is not a market-wide result.'), flat);
  assert.ok(flat.includes('Universe: 2 assets; 1 passed all filters; 1 excluded (1 not evaluated: history not requested or failed).'), flat);
  assert.ok(flat.includes('history not requested (request/rate limit): TWO'), flat);
  for (const s of [json.out.join(''), json.err.join(''), text.out.join(''), text.err.join('')]) assert.ok(!s.includes(KEY));
});
