import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { nextStepForStop } from '../src/core/summary.ts';
import { DAY_MS, nyWallTimeToUtc } from '../src/core/time.ts';
import { renderOptionScanReport, summarizeOptionScan } from '../src/options-scan/render.ts';
import { runOptionScan } from '../src/options-scan/scan.ts';
import { fetchLiveDataset } from '../src/providers/coingecko.ts';
import { type FetchLike, createHttpClient } from '../src/providers/http.ts';
import { fetchStockDataset } from '../src/providers/massive.ts';
import { runScan } from '../src/scanner/analyze.ts';
import { type ScanCommandDeps, runScanCommand } from '../src/scanner/command.ts';
import { normalizeDataset } from '../src/scanner/normalize.ts';
import { renderScanReport, summarizeCryptoScan } from '../src/scanner/render.ts';
import { runStockScan } from '../src/stocks/analyze.ts';
import { normalizeStockDataset } from '../src/stocks/normalize.ts';
import { summarizeStockScan } from '../src/stocks/render.ts';

// Network guard for this process; spawned CLI processes load test/helpers/no-network.mjs.
globalThis.fetch = (() => {
  throw new Error('Network access is not allowed in tests.');
}) as typeof fetch;

const root = fileURLToPath(new URL('..', import.meta.url));
const guard = pathToFileURL(fileURLToPath(new URL('./helpers/no-network.mjs', import.meta.url))).href;
const { POLYGON_API_KEY: _a, COINGECKO_DEMO_API_KEY: _b, NODE_OPTIONS: _c, ...cleanEnv } = process.env;
const cli = (args: string[]) => spawnSync(process.execPath, ['--import', guard, 'src/cli.ts', ...args], { cwd: root, encoding: 'utf8', env: cleanEnv });
const NOW = new Date('2026-10-21T12:00:00Z');
const KEY = 'TEST-WORKFLOW-KEY-not-real-777';

test('README daily workflow: offline steps run as written; LIVE steps stop before any request without a key and say what to do', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const block = /### Daily workflow \(Windows PowerShell\)[\s\S]*?```powershell\n([\s\S]*?)```/.exec(readme)![1]!;
  const lines = block.split('\n').map((l) => l.replace(/#.*$/, '').trim()).filter((l) => l.startsWith('node src/cli.ts'));
  assert.ok(lines.length >= 6, `found ${lines.length} lines`);
  for (const line of lines) {
    const r = cli(line.split(/\s+/).slice(2));
    assert.doesNotMatch(r.stderr, /NETWORK BLOCKED IN TEST/, line);
    if (/--live(\s|$)/.test(line)) {
      assert.equal(r.status, 1, line);
      assert.match(r.stderr, /No request was made\.\nNext step: set it once under Start > "Edit environment variables for your account"/, line);
    } else {
      assert.equal(r.status, 0, `${line}\n${r.stderr}`);
      if (line.includes(' scan ')) assert.match(r.stdout, /\nSCAN SUMMARY\n[\s\S]*Freshness:[\s\S]*Status:/, line);
    }
  }
  // The JSON-saving line's command produces parseable JSON whose `scan` carries the summary fields.
  assert.match(readme, /node src\/cli\.ts scan stocks --json \| Out-File -Encoding utf8 "\$HOME\\market-scans\\/);
  const saved = JSON.parse(cli(['scan', 'stocks', '--json']).stdout);
  assert.deepEqual([saved.scan.status, saved.scan.qualifiedNames, saved.scan.nextStep], ['complete', ['SYNA', 'SYNB', 'SYNC'], null]);
  assert.match(saved.scan.freshness, /^synthetic test data; its dates are invented/);
});

test('freshness: synthetic data is labelled synthetic in every scanner; nothing claims real-time', () => {
  const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));
  const crypto = summarizeCryptoScan(runScan(normalizeDataset(fx('crypto-scan.synthetic.json')), NOW));
  const stocks = summarizeStockScan(runStockScan(normalizeStockDataset(fx('stock-scan.synthetic.json')), NOW));
  const options = summarizeOptionScan(runOptionScan(fx('options-scan.synthetic.json'), new Date('2026-10-21T13:30:00Z')));
  for (const s of [crypto, stocks, options]) {
    assert.match(s.freshness, /^synthetic test data;/, s.scanType);
    assert.doesNotMatch(s.freshness, /real-time/i, s.scanType); // synthetic data makes no timeliness claim at all
  }
  assert.match(crypto.freshness, /1 asset\(s\) excluded as stale \(data older than 15 min or future-dated\)/);
  assert.match(stocks.freshness, /latest completed session evaluated: 2026-10-20; 1 ticker\(s\) excluded as stale/);
  assert.match(options.freshness, /ranked quotes timed 2026-10-20 16:00 ET; 1 contract\(s\) excluded for a stale/);
  assert.equal(options.nextStep, null); // a fixture's gaps are test data, not something to act on
  assert.deepEqual(crypto.qualifiedNames, ['SALP', 'SBRV', 'SECH', 'SDLT']);
});

// ---- live-shaped scans (mock fetch only) --------------------------------------------------------
type Route = { status: number; body?: unknown };
const fetchFrom = (route: (url: string) => Route): { fn: FetchLike; urls: string[] } => {
  const urls: string[] = [];
  return { urls, fn: async (url) => { urls.push(url); const r = route(url); return { ok: r.status < 300, status: r.status, headers: { get: () => null }, text: async () => JSON.stringify(r.body ?? {}) }; } };
};
const client = (fn: FetchLike, maxCalls: number) => createHttpClient({ fetch: fn, baseUrl: 'https://api.example.test', apiKeyHeader: 'h', apiKey: KEY, maxCalls, sleep: async () => {} });
const coin = (id: string) => ({ id, symbol: id.slice(4), name: `Synthetic ${id}`, current_price: 5, market_cap: 1e9, total_volume: 50e6, price_change_percentage_24h: 10, price_change_percentage_7d_in_currency: 12, last_updated: '2026-10-21T11:57:00.000Z' });
const chart = { total_volumes: Array.from({ length: 91 }, (_, i) => [Date.UTC(2026, 9, 21) - (91 - i) * DAY_MS, Math.round(20e6 * (i % 2 ? 1.05 : 0.95))]) };

async function liveCrypto(history: Route, maxCalls: number) {
  const f = fetchFrom((url) => (url.includes('/coins/markets') ? { status: 200, body: ['syn-a', 'syn-b', 'syn-c'].map(coin) } : history));
  const data = await fetchLiveDataset({ client: client(f.fn, maxCalls), clock: () => NOW, maxCalls, sleep: async () => {} });
  return runScan(normalizeDataset(data), NOW);
}

test('crypto live: fresh data is dated and not called real-time; a partial scan gets the matching next step', async () => {
  const capped = summarizeCryptoScan(await liveCrypto({ status: 200, body: chart }, 2));
  assert.match(capped.freshness, /^provider data fetched 2026-10-21 08:00 ET, as reported by the source \(not verified as real-time\)\. Every asset that passed the filters was updated within 15 min of the scan/);
  assert.equal(capped.status, 'partial');
  assert.match(capped.nextStep!, /run again with a larger --max-requests/);
  const rejected = await liveCrypto({ status: 401 }, 10);
  assert.match(summarizeCryptoScan(rejected).nextStep!, /check COINGECKO_DEMO_API_KEY and your CoinGecko account; retrying with the same key will not help/);
  assert.match(renderScanReport(rejected).replace(/\s+/g, ' '), /Next step: check COINGECKO_DEMO_API_KEY/);
  const complete = summarizeCryptoScan(await liveCrypto({ status: 200, body: chart }, 10));
  assert.deepEqual([complete.status, complete.nextStep], ['complete', null]);
});

test('stocks live: end-of-day freshness is stated; a rejected key or refused access gives the right next step', async () => {
  const bars = () => {
    const out: { t: number; c: number; v: number }[] = [];
    for (let t = Date.parse('2026-10-20T00:00:00Z'); out.length < 26; t -= DAY_MS) {
      const d = new Date(t).getUTCDay();
      if (d !== 0 && d !== 6) out.unshift({ t: nyWallTimeToUtc(new Date(t).toISOString().slice(0, 10), 0, 0).getTime(), c: 100, v: 5e6 });
    }
    return { status: 'OK', results: out };
  };
  const scan = async (route: (url: string) => Route) => {
    const f = fetchFrom(route);
    const data = await fetchStockDataset({ client: client(f.fn, 10), clock: () => NOW, universe: ['AAA', 'BBB', 'CCC'], maxCalls: 10, sleep: async () => {} });
    return summarizeStockScan(runStockScan(normalizeStockDataset(data), NOW));
  };
  const ok = await scan(() => ({ status: 200, body: bars() }));
  assert.match(ok.freshness, /^end-of-day bars fetched 2026-10-21 08:00 ET \(not real-time; no intraday or pre-market data\); latest completed session evaluated: 2026-10-20/);
  assert.equal(ok.nextStep, null);
  assert.match((await scan(() => ({ status: 401 }))).nextStep!, /^check POLYGON_API_KEY and your Massive account; retrying with the same key will not help\./);
  assert.match((await scan((u) => (u.includes('BBB') ? { status: 403 } : { status: 200, body: bars() }))).nextStep!, /^check your Massive plan and permissions/);
});

test('options live: a refused plan gives a plan next step; quote times come from the contracts themselves', () => {
  const r = runOptionScan({
    dataset: { kind: 'live', label: 'live-shaped', source: 'Example', asOf: '2026-10-21T13:30:00Z', notes: ['Option-chain request failed for 1 underlying(s) (AAA): the provider refused access (HTTP 403): the option-chain snapshot needs a Massive options plan.', 'Option chains not requested for 1 underlying(s) (BBB) because the provider refused access (HTTP 403): the option-chain snapshot needs a Massive options plan.'] },
    chains: [{ underlying: 'AAA', status: 'request_failed' }, { underlying: 'BBB', status: 'not_requested' }],
  }, new Date('2026-10-21T13:30:00Z'));
  const s = summarizeOptionScan(r);
  assert.match(s.nextStep!, /^check your Massive plan and permissions; retrying will not help until access changes\./);
  assert.match(s.freshness, /no ranked contract, so no quote time to report.*not verified as real-time/);
  assert.match(renderOptionScanReport(r).replace(/\s+/g, ' '), /Next step: check your Massive plan/);
});

test('next steps: each stop reason maps to one practical action', () => {
  assert.match(nextStepForStop('the per-run limit of 2 requests was reached', 'K', 'P'), /larger --max-requests/);
  assert.match(nextStepForStop('the provider rate-limited the run', 'K', 'P'), /wait a few minutes/);
  assert.match(nextStepForStop('P rejected the API key (HTTP 401), so ...', 'K', 'P'), /check K and your P account; retrying with the same key will not help/);
  assert.match(nextStepForStop('P refused access (HTTP 403), so ...', 'K', 'P'), /check your P plan and permissions/);
  assert.match(nextStepForStop(null, 'K', 'P'), /check DATA NOTES/);
});

test('missing key: every live scan stops before any request and gives the same concrete next step', async () => {
  for (const market of ['crypto', 'stocks', 'options']) {
    const err: string[] = [];
    let calls = 0;
    const d: ScanCommandDeps = { env: {}, fetch: async () => { calls++; throw new Error('no'); }, clock: () => NOW, out: () => {}, err: (t) => err.push(t), sleep: async () => {} };
    assert.equal(await runScanCommand([market, '--live'], d), 1, market);
    assert.equal(calls, 0, market);
    assert.match(err.join('\n'), /No request was made\.\nNext step: set it once under Start > "Edit environment variables for your account" \(never in a file in this folder\), restart the terminal, and run again; or drop --live to use the offline fixture\./, market);
  }
});
