import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runStockScan } from '../src/stocks/analyze.ts';
import { normalizeStockDataset } from '../src/stocks/normalize.ts';
import { STOCK_RISK_FLAGS, stockRows } from '../src/web/rows.ts';

globalThis.fetch = (() => {
  throw new Error('Network access is not allowed in tests.');
}) as typeof fetch;

const NOW = new Date('2026-10-24T14:00:00Z');
// SYNTHETIC live-shaped dataset: 21 calm sessions, then a +12% day that faded from its high.
function dataset(last: Record<string, unknown>, security?: unknown) {
  // 24 consecutive weekdays up to Thu 2026-10-22, then the latest session Fri 2026-10-23.
  const days: string[] = [];
  for (let t = Date.UTC(2026, 9, 22); days.length < 24; t -= 86_400_000) {
    const wd = new Date(t).getUTCDay();
    if (wd !== 0 && wd !== 6) days.unshift(new Date(t).toISOString().slice(0, 10));
  }
  const bars = days.map((date) => ({ date, close: 20, volume: 2e6, open: 20, high: 20.2, low: 19.8 }));
  return { dataset: { kind: 'live', label: 'test', source: 'synthetic', asOf: NOW.toISOString() },
    stocks: [{ symbol: 'FADE', name: 'Fade Example Inc', ...(security ? { security } : {}), bars: [...bars, { date: '2026-10-23', volume: 9e6, ...last }] }] };
}

test('stock day-range warnings: a big fade from the high, a wide range and a gap are flagged (display only)', () => {
  const sec = { kind: 'common', typeCode: 'CS', label: 'Common stock', basis: 'Massive ticker reference' };
  const r = runStockScan(normalizeStockDataset(dataset({ close: 22.4, open: 22, high: 26, low: 21.8 }, sec)), NOW);
  const [row] = stockRows(r);
  assert.equal(row!.security?.label, 'Common stock');
  const risk = row!.risk as { dayRangePct: number; fromDayHighPct: number; gapPct: number; flags: string[] };
  assert.equal(risk.dayRangePct.toFixed(1), '19.3'); // (26 - 21.8) / 21.8
  assert.equal(risk.fromDayHighPct.toFixed(1), '-13.8'); // (22.4 - 26) / 26
  assert.equal(risk.gapPct.toFixed(1), '10.0'); // 22 / 20 - 1
  assert.deepEqual(risk.flags.map((f) => f.split(':')[0]!.split(' ')[0]), ['Closed', 'The', 'Opened']);
  assert.ok(STOCK_RISK_FLAGS.fadeFromHighPct === 10 && STOCK_RISK_FLAGS.dayRangePct === 15 && STOCK_RISK_FLAGS.gapPct === 8);
});

test('inconsistent open/high/low is ignored (no flags, no invented range); the bar itself is still used', () => {
  const r = runStockScan(normalizeStockDataset(dataset({ close: 22.4, open: 22, high: 21, low: 21.8 })), NOW); // high below low
  const [row] = stockRows(r);
  const risk = row!.risk as { dayRangePct: number | null; flags: string[]; unavailable: string[] };
  assert.equal(risk.dayRangePct, null);
  assert.deepEqual(risk.flags, []);
  assert.ok(risk.unavailable.some((u) => u.startsWith('the day\'s open, high and low')));
  assert.equal(row!.unitPrice, 22.4);
  assert.equal(row!.security, undefined);
});

test('a security type is accepted only from a live dataset', () => {
  const d = dataset({ close: 22.4, open: 22, high: 26, low: 21.8 }, { kind: 'etf', typeCode: 'ETF', label: 'ETF', basis: 'x' });
  d.dataset.kind = 'synthetic';
  assert.equal(normalizeStockDataset(d).stocks[0]!.security, undefined);
});
