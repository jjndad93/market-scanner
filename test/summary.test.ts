import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { renderOptionScanReport, summarizeOptionScan } from '../src/options-scan/render.ts';
import { runOptionScan } from '../src/options-scan/scan.ts';
import { runScan } from '../src/scanner/analyze.ts';
import { type ScanCommandDeps, runScanCommand } from '../src/scanner/command.ts';
import { normalizeDataset } from '../src/scanner/normalize.ts';
import { renderScanReport, summarizeCryptoScan } from '../src/scanner/render.ts';
import { runStockScan } from '../src/stocks/analyze.ts';
import { normalizeStockDataset } from '../src/stocks/normalize.ts';
import { renderStockReport, summarizeStockScan } from '../src/stocks/render.ts';

// Network guard: summaries are built from scan results only.
globalThis.fetch = (() => {
  throw new Error('Network access is not allowed in tests.');
}) as typeof fetch;

// SYNTHETIC TEST DATA only: the bundled fixtures.
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const CRYPTO = fixture('crypto-scan.synthetic.json');
const STOCKS = fixture('stock-scan.synthetic.json');
const OPTIONS = fixture('options-scan.synthetic.json');
const total = (s: { qualified: number; notQualified: { count: number }[] }) => s.qualified + s.notQualified.reduce((a, n) => a + n.count, 0);

test('crypto summary: complete offline fixture scan; every asset is accounted for', () => {
  const r = runScan(normalizeDataset(CRYPTO), new Date(CRYPTO.dataset.asOf));
  const s = summarizeCryptoScan(r);
  assert.deepEqual([s.scanType, s.mode, s.status, s.partialReasons], ['crypto', 'offline', 'complete', []]);
  assert.equal(s.data, 'synthetic fixture (TEST DATA), not market data');
  assert.equal(s.qualified, 4);
  assert.equal(total(s), r.universe); // qualified + every not-qualified bucket = everything scanned
  assert.deepEqual(s.counts, { universe: 14, passedFilters: 6, excluded: 8, qualified: 4, belowThreshold: 1, noPattern: 1 });
  const text = renderScanReport(r);
  assert.match(text, /\nSCAN SUMMARY\n {2}Scanned: +14 crypto assets in the fixture\n/);
  assert.match(text, /Status: +COMPLETE for the scanned scope \(not a market-wide scan\)/);
});

test('crypto summary: a live partial scan says why, and reports cache reuse from the coverage', () => {
  const LIVE = { kind: 'live', label: 'live-shaped test', source: 'Example provider API', asOf: '2026-10-21T11:58:00Z', attribution: 'Data provided by Example' };
  const hist = Array.from({ length: 30 }, (_, i) => Math.round(50e6 * (i % 2 ? 1.05 : 0.95)));
  const base = { symbol: 'X', name: 'Synthetic X', price: 5, change24hPct: 0.5, change7dPct: 1, volume24h: 50e6, marketCap: 1e9, lastUpdated: '2026-10-21T11:57:00Z', tags: [] };
  const r = runScan(normalizeDataset({
    dataset: { ...LIVE, coverage: { historyEligible: 2, historyFetched: 1, historyFromCache: 1, historyRequestFailed: 0, historyNotRequested: 1, complete: false, stopReason: 'the per-run limit of 1 requests was reached', requestsUsed: 1, requestLimit: 1 } },
    assets: [{ ...base, id: 'a', dailyVolumes: hist }, { ...base, id: 'b', symbol: 'Y', dailyVolumes: null, historyStatus: 'not_requested' }],
  }), new Date('2026-10-21T12:00:00Z'));
  const s = summarizeCryptoScan(r);
  assert.deepEqual([s.mode, s.status], ['live', 'partial']);
  assert.deepEqual(s.partialReasons, ['1 eligible asset(s) not evaluated because the per-run limit of 1 requests was reached']);
  assert.match(s.data, /1 volume history\(ies\) reused from this UTC day's local cache/);
  assert.equal(total(s), r.universe);
  assert.match(renderScanReport(r), /Status: +PARTIAL - 1 eligible asset\(s\) not evaluated/);
});

test('stock summary: complete fixture scan; detailed first reason for each excluded ticker; provenance legend', () => {
  const r = runStockScan(normalizeStockDataset(STOCKS), new Date(STOCKS.dataset.asOf));
  const s = summarizeStockScan(r);
  assert.deepEqual([s.scanType, s.mode, s.status, s.qualified], ['stocks', 'offline', 'complete', 3]);
  assert.equal(total(s), r.universe);
  const text = renderStockReport(r);
  assert.match(text, /\n {2}SYNG: stale data - latest session 2026-10-14 is 7 days old \(limit 4\)\n/);
  assert.match(text, /\n {2}SYNH: below price minimum - close \$3\.30 is below the \$5 minimum\n/);
  assert.match(text.replace(/\s+/g, ' '), /Values: close and volume are the provider's end-of-day bars \[TEST DATA\]; % changes, medians, volume ratios and scores are CALCULATED from them\./);
  assert.ok(text.split('\n').every((l) => l.length <= 100));
});

test('stock summary: unevaluated tickers make the scan partial and stay grouped in the report', () => {
  const LIVE = { kind: 'live', label: 'live-shaped test', source: 'Example provider', asOf: '2026-10-21T11:30:00Z', attribution: 'Data by Example' };
  const r = runStockScan(normalizeStockDataset({ dataset: LIVE, stocks: [{ symbol: 'A', historyStatus: 'not_requested' }, { symbol: 'B', historyStatus: 'not_requested' }, { symbol: 'C', historyStatus: 'request_failed' }] }), new Date('2026-10-21T11:30:00Z'));
  const s = summarizeStockScan(r);
  assert.equal(s.status, 'partial');
  assert.deepEqual(s.partialReasons, ['2 ticker(s) not evaluated: bars not requested (request or rate limit)', '1 ticker(s) not evaluated: bars request failed']);
  assert.equal(total(s), 3);
  assert.match(renderStockReport(r), /\n {2}bars not requested \(request\/rate limit\): A, B\n/);
});

test('options summary: partial when an underlying failed or a page was cut off; contracts reconcile', () => {
  const r = runOptionScan(OPTIONS, new Date(OPTIONS.dataset.asOf));
  const s = summarizeOptionScan(r);
  assert.deepEqual([s.scanType, s.mode, s.status, s.qualified], ['options', 'offline', 'partial', 4]);
  assert.deepEqual(s.partialReasons, ['1 underlying(s) failed or returned unusable data (SYNC)', 'only the first page of contracts was used for SYNB']);
  assert.equal(total(s), r.counts.retrieved); // ranked + insufficient + puts + excluded = retrieved
  const text = renderOptionScanReport(r);
  assert.match(text, /Status: +PARTIAL - 1 underlying\(s\) failed/);
  assert.ok(text.split('\n').every((l) => l.length <= 100));
});

test('regression: an impossible date (month 13) is counted as invalid instead of crashing the scan', () => {
  const s = normalizeStockDataset({ dataset: { kind: 'synthetic', label: 'x', source: 'x', asOf: '2026-10-21T00:00:00Z' }, stocks: [{ symbol: 'A', bars: [{ date: '2026-13-01', close: 1, volume: 1 }] }] });
  assert.equal(s.stocks[0]!.invalidBars, 1);
  const r = runOptionScan({ dataset: OPTIONS.dataset, chains: [{ underlying: 'SYNX', response: { results: [{ details: { contract_type: 'call', expiration_date: '2026-13-01', strike_price: 100, ticker: 'O:SYNX' }, underlying_asset: { price: 100, ticker: 'SYNX' } }] } }] }, new Date(OPTIONS.dataset.asOf));
  assert.deepEqual(r.exclusions.map((e) => [e.code, e.details[0]]), [['incomplete', 'invalid: expiration ("2026-13-01")']]);
});

function deps() {
  const out: string[] = [];
  let calls = 0;
  const d: ScanCommandDeps = { env: {}, fetch: async () => { calls++; throw new Error('fetch must not be called'); }, clock: () => new Date('2026-10-21T13:30:00Z'), out: (t) => out.push(t), err: () => {}, sleep: async () => {} };
  return { d, out, calls: () => calls };
}

test('JSON: an additive "scan" object; every pre-existing field is unchanged; offline makes zero requests', async () => {
  const cases: [string, unknown][] = [
    ['crypto', runScan(normalizeDataset(CRYPTO), new Date(CRYPTO.dataset.asOf))],
    ['stocks', runStockScan(normalizeStockDataset(STOCKS), new Date(STOCKS.dataset.asOf))],
    ['options', runOptionScan(OPTIONS, new Date(OPTIONS.dataset.asOf))],
  ];
  for (const [market, expected] of cases) {
    const t = deps();
    assert.equal(await runScanCommand([market, '--json'], t.d), 0, market);
    assert.equal(t.calls(), 0, market);
    const { scan, ...rest } = JSON.parse(t.out.join('\n'));
    assert.deepEqual(rest, JSON.parse(JSON.stringify(expected)), market);
    assert.equal(scan.scanType, market);
    assert.equal(scan.mode, 'offline');
    assert.ok(['complete', 'partial'].includes(scan.status));
    assert.equal(typeof scan.counts, 'object');
  }
});
