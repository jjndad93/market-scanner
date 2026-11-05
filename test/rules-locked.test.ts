// Locks the scanners' scoring rules and the fixture scan results, so a change to any threshold or
// score is deliberate: it must update this file in the same change, with a stated reason.
// Recorded 2026-10-28 from the project as it stood (commit 4f4883f).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SCAN_RULES } from '../src/scanner/rules.ts';
import { runStockScan } from '../src/stocks/analyze.ts';
import { normalizeStockDataset } from '../src/stocks/normalize.ts';
import { STOCK_RULES, STOCK_SCORE_TABLE } from '../src/stocks/rules.ts';

globalThis.fetch = (() => {
  throw new Error('Network access is not allowed in tests.');
}) as typeof fetch;

test('stock rules and score tables are unchanged', () => {
  assert.deepEqual({ ...STOCK_RULES }, {
    baselineSessions: 20, minBaselineSessions: 15, maxGapDays: 5, maxSessionAgeDays: 4, minPrice: 5, minMedianDollarVolume: 20_000_000,
    maxRelativeVolume: 50, moverMinAbsMovePct: 4, moverMinRelVolume: 1.5, watchMaxAbsMovePct: 2, watchMinRelVolume: 2, moverMinScore: 4,
    watchMinScore: 3, maxMovers: 5, maxWatchlist: 3, extremeRelVolume: 10,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(STOCK_SCORE_TABLE)), {
    relativeVolume: [[3, 3], [2, 2], [1.5, 1]], moveAbsPct: [[8, 2], [4, 1]], dollarVolume: [[1_000_000_000, 2], [200_000_000, 1]], trendAgreement: 1,
  });
});

test('crypto scan rules are unchanged', () => {
  assert.deepEqual({ ...SCAN_RULES }, {
    minMarketCap: 100_000_000, minVolume24h: 10_000_000, minHistoryDays: 20, maxDataAgeMinutes: 15, historyWindowDays: 30, maxUnreliableHistoryDays: 5,
    minBaselineVolume: 1_000_000, maxAbsChange24hPct: 300, maxAbsChange7dPct: 1000, maxTurnover: 1, maxRelativeVolume: 50, moverMinAbsMovePct: 8,
    moverMinRelVolume: 1.5, watchMaxAbsMovePct: 5, watchMinRelVolume: 2, moverMinScore: 4, watchMinScore: 3, maxMovers: 5, maxWatchlist: 3,
    peggedPriceBand: 0.02, peggedMaxAbs24hPct: 0.5, peggedMaxAbs7dPct: 1, thinVolume24h: 25_000_000, extremeRelVolume: 10, highTurnover: 0.5,
    variableBaselineIqrRatio: 4, prescreenMinTurnover: 0.15, prescreenMinAbs7dPct: 20,
  });
});

test('the stock fixture scan gives the same candidates, scores and exclusions', () => {
  const data = JSON.parse(readFileSync(new URL('./fixtures/stock-scan.synthetic.json', import.meta.url), 'utf8'));
  const r = runStockScan(normalizeStockDataset(data), new Date(data.dataset.asOf));
  const pick = (l: { stock: { symbol: string }; kind: string; score: number; maxScore: number }[]) => l.map((c) => [c.stock.symbol, c.kind, c.score, c.maxScore]);
  assert.deepEqual(pick(r.movers), [['SYNA', 'mover', 8, 8], ['SYNB', 'mover', 4, 8]]);
  assert.deepEqual(pick(r.watchlist), [['SYNC', 'watch', 4, 5]]);
  assert.deepEqual(pick(r.overLimit), []);
  assert.deepEqual(pick(r.belowThreshold), [['SYND', 'mover', 3, 8]]);
  assert.deepEqual(r.excluded.map((e) => [e.symbol, e.reasons.map((x) => x.code)]),
    [['SYNF', ['insufficient_history']], ['SYNG', ['stale_data']], ['SYNH', ['below_price']], ['SYNI', ['history_gap']], ['SYNJ', ['below_liquidity']]]);
});
