import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { classifyStock, runStockScan, stockMetrics } from '../src/stocks/analyze.ts';
import { normalizeStockDataset } from '../src/stocks/normalize.ts';
import { renderStockReport } from '../src/stocks/render.ts';
import type { RawStock } from '../src/stocks/types.ts';

// Network guard: the stock scanner's logic is offline.
globalThis.fetch = (() => {
  throw new Error('Network access is not allowed in tests.');
}) as typeof fetch;

// All data below is SYNTHETIC TEST DATA: invented tickers and numbers, not market data.
const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/stock-scan.synthetic.json', import.meta.url), 'utf8'));
const NOW = new Date('2026-10-21T11:30:00Z'); // Wednesday 07:30 ET; latest session Tuesday 2026-10-20
const SYN = { kind: 'synthetic', label: 'inline synthetic', source: 'Synthetic inline bars', asOf: '2026-10-21T11:30:00Z' };
const LIVE = { kind: 'live', label: 'live-shaped test', source: 'Example provider', asOf: '2026-10-21T11:30:00Z', attribution: 'Data by Example' };

/** `n` weekday sessions ending 2026-10-20; flat closes and volumes, then the last session as given. */
function bars(o: { n?: number; price?: number; vol?: number; movePct?: number; volMult?: number; last?: string } = {}) {
  const { n = 21, price = 100, vol = 5e6, movePct = 0, volMult = 1, last = '2026-10-20' } = o;
  const dates: string[] = [];
  for (let t = Date.parse(`${last}T00:00:00Z`); dates.length < n; t -= 86_400_000) {
    const d = new Date(t).getUTCDay();
    if (d !== 0 && d !== 6) dates.unshift(new Date(t).toISOString().slice(0, 10));
  }
  return dates.map((date, i) => (i === n - 1 ? { date, close: +(price * (1 + movePct / 100)).toFixed(4), volume: vol * volMult } : { date, close: price, volume: vol }));
}
const scanOf = (stocks: RawStock[], dataset: object = SYN) => runStockScan(normalizeStockDataset({ dataset, stocks }), NOW);
const codes = (r: ReturnType<typeof scanOf>) => Object.fromEntries(r.excluded.map((e) => [e.symbol, e.reasons.map((x) => x.code)]));

test('fixture scan: expected movers, watchlist, below-threshold, exclusions and malformed-bar note', () => {
  const r = runStockScan(normalizeStockDataset(FIXTURE), NOW);
  assert.equal(r.universe, 10);
  assert.equal(r.passedFilters, 5);
  assert.deepEqual(r.movers.map((c) => [c.stock.symbol, c.score, c.maxScore]), [['SYNA', 8, 8], ['SYNB', 4, 8]]);
  assert.deepEqual(r.watchlist.map((c) => [c.stock.symbol, c.score, c.maxScore]), [['SYNC', 4, 5]]);
  assert.deepEqual(r.belowThreshold.map((c) => [c.stock.symbol, c.score]), [['SYND', 3]]);
  assert.equal(r.notCandidates, 1); // SYNE
  assert.deepEqual(codes(r), {
    SYNF: ['insufficient_history'], SYNG: ['stale_data'], SYNH: ['below_price'], SYNI: ['history_gap'], SYNJ: ['below_liquidity'],
  });
  assert.deepEqual(r.invalidBars, [{ symbol: 'SYNE', count: 1 }]);
});

test('metrics: 1-day and 5-day change, relative volume against the median of the 20 sessions before the latest', () => {
  const s = normalizeStockDataset({ dataset: SYN, stocks: [{ symbol: 'x', bars: bars({ n: 25, price: 50, vol: 2e6, movePct: 6, volMult: 3 }) }] }).stocks[0]!;
  const m = stockMetrics(s)!;
  assert.equal(m.lastDate, '2026-10-20');
  assert.ok(Math.abs(m.change1dPct - 6) < 1e-9);
  assert.ok(Math.abs(m.change5dPct! - 6) < 1e-9);
  assert.deepEqual([m.baselineVolume, m.baselineSessions, m.relativeVolume, m.volume], [2e6, 20, 3, 6e6]);
  assert.ok(Math.abs(m.dollarVolume - 53 * 6e6) < 1e-3);
  assert.equal(m.medianDollarVolume, 100e6);
});

test('normalizer: malformed bars are counted, identical repeats collapse, conflicting dates are dropped, bars are sorted', () => {
  const good = bars({ n: 3 });
  const [s] = normalizeStockDataset({ dataset: SYN, stocks: [{ symbol: 'abc', bars: [
    good[2]!, good[0]!, good[1]!, { ...good[1]! }, // identical repeat
    { date: '2026-10-01', close: 1, volume: 1 }, { date: '2026-10-01', close: 2, volume: 1 }, // conflict
    { date: '2026-02-30', close: 1, volume: 1 }, { date: '2026-10-02', close: 0, volume: 1 }, { date: '2026-10-02', close: 1, volume: -5 }, null,
  ] } as unknown as RawStock] }).stocks;
  assert.equal(s!.symbol, 'ABC');
  assert.deepEqual(s!.bars.map((b) => b.date), good.map((b) => b.date));
  assert.equal(s!.invalidBars, 6); // 2 conflicting + 4 malformed
  assert.equal(s!.dataKind, 'test_data');
  assert.throws(() => normalizeStockDataset({ dataset: { ...SYN, kind: 'other' }, stocks: [] }), /Unknown dataset kind/);
  assert.throws(() => normalizeStockDataset({ dataset: SYN, stocks: [{ symbol: 'A', historyStatus: 'not_requested' }] }), /only a live dataset/);
  assert.throws(() => normalizeStockDataset({ dataset: LIVE, stocks: [{ symbol: 'A', historyStatus: 'not_requested', bars: bars({ n: 2 }) }] }), /has bars/);
  assert.equal(normalizeStockDataset({ dataset: LIVE, stocks: [{ symbol: 'A', bars: bars({ n: 2 }) }] }).stocks[0]!.dataKind, 'verified_market_data');
});

test('filters: history length, gaps, staleness, future dates, price, liquidity, plausibility and duplicates', () => {
  const r = scanOf([
    { symbol: 'SHORT', bars: bars({ n: 15 }) }, // 14 baseline sessions < 15
    { symbol: 'OK', bars: bars({ n: 16 }) }, // exactly 15
    { symbol: 'STALE', bars: bars({ last: '2026-10-16' }) }, // Friday: 5 days before Wednesday
    { symbol: 'FUTURE', bars: bars({ last: '2026-10-22' }) },
    { symbol: 'GAP', bars: [...bars({ n: 10, last: '2026-09-25' }), ...bars({ n: 12 })] }, // 10 days from 09-25 to 10-05
    { symbol: 'CHEAP', bars: bars({ price: 4.99, vol: 50e6 }) },
    { symbol: 'THIN', bars: bars({ price: 10, vol: 1.9e6 }) },
    { symbol: 'WILD', bars: bars({ volMult: 51 }) },
    { symbol: 'DUP', bars: bars() }, { symbol: 'dup', bars: bars({ price: 10 }) },
  ]);
  assert.deepEqual(codes(r), {
    SHORT: ['insufficient_history'], STALE: ['stale_data'], FUTURE: ['stale_data'], GAP: ['history_gap'],
    CHEAP: ['below_price'], THIN: ['below_liquidity'], WILD: ['implausible_data'], DUP: ['duplicate_symbol'],
  });
  assert.equal(r.excluded.filter((e) => e.symbol === 'DUP').length, 2); // both copies, none used
  assert.equal(r.passedFilters, 1); // OK
  // Staleness boundary: Friday's session is 4 days old on Tuesday after a Monday holiday, and allowed.
  const tuesday = runStockScan(normalizeStockDataset({ dataset: SYN, stocks: [{ symbol: 'HOL', bars: bars({ last: '2026-10-16' }) }] }), new Date('2026-10-20T11:30:00Z'));
  assert.equal(tuesday.passedFilters, 1);
});

test('classification boundaries: mover at 4% on 1.5x, watch below 2% on 2x, nothing in between', () => {
  const kind = (movePct: number, volMult: number) => classifyStock(stockMetrics(normalizeStockDataset({ dataset: SYN, stocks: [{ symbol: 'X', bars: bars({ movePct, volMult }) }] }).stocks[0]!)!);
  assert.equal(kind(4, 1.5), 'mover');
  assert.equal(kind(-4, 1.5), 'mover');
  assert.equal(kind(3.99, 1.5), null);
  assert.equal(kind(4, 1.49), null);
  assert.equal(kind(1.99, 2), 'watch');
  assert.equal(kind(2, 2), null);
  assert.equal(kind(1, 1.99), null);
});

test('scores are transparent rule tallies with deterministic ranking', () => {
  const r = scanOf([
    { symbol: 'B', bars: bars({ price: 100, vol: 5e6, movePct: 9, volMult: 3 }) },
    { symbol: 'A', bars: bars({ price: 100, vol: 5e6, movePct: 9, volMult: 3 }) },
  ]);
  assert.deepEqual(r.movers.map((c) => c.stock.symbol), ['A', 'B']); // tie broken by symbol
  assert.deepEqual(r.movers[0]!.breakdown.map((p) => [p.rule, p.points, p.max]), [['unusual volume', 3, 3], ['size of move', 2, 2], ['liquidity', 2, 2], ['5-day trend', 1, 1]]);
  assert.equal(JSON.stringify(scanOf([{ symbol: 'A', bars: bars({ movePct: 9, volMult: 3 }) }])), JSON.stringify(scanOf([{ symbol: 'A', bars: bars({ movePct: 9, volMult: 3 }) }])));
});

test('fixture report: TEST DATA labels, honest caveats, malformed-bar note, lines within 100 characters', () => {
  const report = renderStockReport(runStockScan(normalizeStockDataset(FIXTURE), NOW));
  const lines = report.split('\n');
  assert.equal(lines[0], 'US STOCK SCAN - 2026-10-21 07:30 ET');
  assert.match(lines[1]!, /^!! TEST DATA - synthetic fixture/);
  assert.match(report, /Universe: 10 tickers; 5 passed filters; 5 excluded\./);
  assert.match(report, /SYNE: 1 malformed or conflicting bar\(s\) counted and not used\./);
  assert.match(report, /Matched a pattern but scored below the threshold: SYND \(3\/8\)\./);
  assert.match(report, /End-of-day data only: no intraday or pre-market moves\./);
  assert.doesNotMatch(report, /VERIFIED DATA|Attribution:|undefined|NaN/);
  assert.ok(lines.every((l) => l.length <= 100), lines.find((l) => l.length > 100));
});

test('zero-candidate report still states the latest session evaluated, only for tickers that passed all filters', () => {
  // Like the first live smoke test: two flat tickers evaluated, the rest never requested.
  const r = scanOf([
    { symbol: 'AAA', bars: bars() }, { symbol: 'BBB', bars: bars() },
    { symbol: 'CCC', historyStatus: 'not_requested' },
  ], LIVE);
  assert.deepEqual([r.movers.length, r.watchlist.length, r.passedFilters], [0, 0, 2]);
  assert.deepEqual(r.evaluatedSessions, { tickers: 2, earliest: '2026-10-20', latest: '2026-10-20' });
  const report = renderStockReport(r);
  assert.match(report, /^Latest session evaluated: 2026-10-20, for the 2 ticker\(s\) that passed all filters\.$/m);
  assert.match(report, /No candidates met the evidence threshold among the evaluated tickers/);

  // Different dates are shown as a range; an excluded (stale) ticker's date is not included.
  const mixed = renderStockReport(scanOf([
    { symbol: 'NEW', bars: bars() }, { symbol: 'OLD', bars: bars({ last: '2026-10-19' }) }, { symbol: 'STALE', bars: bars({ last: '2026-10-09' }) },
  ]));
  assert.match(mixed, /^Latest session evaluated: 2026-10-19 to 2026-10-20 \(differs by ticker\), for the 2 ticker\(s\) that passed all filters\.$/m);
  assert.match(renderStockReport(scanOf([{ symbol: 'X', historyStatus: 'request_failed' }], LIVE)), /^Latest session evaluated: none \(no ticker passed all filters\)\.$/m);
});

test('live-shaped report: attribution, VERIFIED DATA, and partial coverage when bars were not obtained', () => {
  const r = scanOf([
    { symbol: 'A', bars: bars({ movePct: 9, volMult: 3 }) },
    { symbol: 'B', historyStatus: 'request_failed' },
    { symbol: 'C', historyStatus: 'not_requested' },
  ], LIVE);
  assert.deepEqual(r.notEvaluated, { requestFailed: 1, notRequested: 1 });
  assert.deepEqual(codes(r), { B: ['history_request_failed'], C: ['history_not_requested'] });
  const report = renderStockReport(r);
  const flat = report.replace(/\s+/g, ' ');
  assert.ok(flat.includes('Universe: 3 tickers; 1 passed all filters; 2 excluded (2 not evaluated: bars not requested or failed). PARTIAL SCAN.'), report);
  assert.ok(flat.includes('PARTIAL SCAN: 2 ticker(s) were not evaluated.'), report);
  assert.match(report, /^Attribution: Data by Example$/m);
  assert.match(report, /\[VERIFIED DATA\]/);
  assert.doesNotMatch(report, /TEST DATA/);
  const none = renderStockReport(scanOf([{ symbol: 'B', historyStatus: 'request_failed' }], LIVE));
  assert.match(none, /No candidates met the evidence threshold among the evaluated tickers; 1 ticker\(s\) were not evaluated\./);
});
