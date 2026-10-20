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
