import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { type RowLike, loadJournal, observationsFrom, outcomes, recordScan, trackRecord } from '../src/tracking/journal.ts';

globalThis.fetch = (() => {
  throw new Error('Network access is not allowed in tests.');
}) as typeof fetch;

// SYNTHETIC rows: invented coins and prices.
const row = (key: string, priceVal: number, at: string, status: RowLike['signal']['status'] = 'no_pattern', category: RowLike['signal']['category'] = null, dataKind = 'verified_market_data'): RowLike => ({
  key, market: 'crypto', symbol: key.split(':')[1]!.toUpperCase(), name: `Test ${key}`, unitPrice: priceVal, priceAsOf: at, dataKind,
  change: { short: { value: 5 } }, signal: { status, category, score: category ? 6 : null, maxScore: category ? 8 : null },
});
const T = (d: number, h = 12) => new Date(Date.UTC(2026, 9, d, h)).toISOString();

test('only live data is recorded; test data and unusable prices are not', () => {
  assert.equal(observationsFrom([row('crypto:a', 1, T(1), 'qualified', 'Mover', 'test_data'), row('crypto:b', 0, T(1)), { ...row('crypto:c', 2, T(1)), priceAsOf: null }]).length, 0);
  const dir = mkdtempSync(join(tmpdir(), 'journal-'));
  try {
    assert.equal(recordScan(dir, 'crypto', new Date(T(1)), [row('crypto:a', 1, T(1), 'qualified', 'Mover', 'test_data')]), false);
    assert.equal(readdirSync(dir).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('outcomes: measured from the first flag to the first later observation in each window; nothing estimated', () => {
  const dir = mkdtempSync(join(tmpdir(), 'journal-'));
  try {
    recordScan(dir, 'crypto', new Date(T(1)), [row('crypto:up', 1.0, T(1), 'qualified', 'Mover'), row('crypto:gone', 2.0, T(1), 'qualified', 'Watchlist'), row('crypto:other', 5, T(1))]);
    recordScan(dir, 'crypto', new Date(T(2)), [row('crypto:up', 1.1, T(2), 'qualified', 'Mover')]); // +1 day, flagged again
    recordScan(dir, 'crypto', new Date(T(4)), [row('crypto:up', 1.3, T(4))]); // +3 days
    recordScan(dir, 'crypto', new Date(T(20)), [row('crypto:up', 0.5, T(20))]); // +19 days: outside the 7-day window (6.8-12.2)
    writeFileSync(join(dir, 'crypto-broken.json'), '{nope');
    const recs = loadJournal(dir);
    assert.equal(recs.length, 4);
    const list = outcomes(recs);
    const up = list.find((c) => c.key === 'crypto:up')!;
    assert.deepEqual([up.after[1]?.toFixed(1), up.after[3]?.toFixed(1), up.after[7]], ['10.0', '30.0', null]);
    assert.equal(up.reflagged, 1);
    const gone = list.find((c) => c.key === 'crypto:gone')!;
    assert.deepEqual(gone.after, { 1: null, 3: null, 7: null });
    assert.equal(list.some((c) => c.key === 'crypto:other'), false); // never qualified: not a candidate
    const tr = trackRecord(recs, new Date(T(21)), 'crypto');
    assert.equal(tr.candidates, 2);
    assert.deepEqual(tr.stats.map((s) => [s.horizon, s.measured, s.up]), [[1, 1, 1], [3, 1, 1], [7, 0, 0]]);
    assert.ok(tr.notes.some((n) => /1 older candidate\(s\) were never observed again/.test(n)));
    assert.equal(trackRecord(recs, new Date(T(21)), 'stocks').candidates, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stock session dates are placed at the 4 pm New York close', () => {
  const [o] = observationsFrom([{ ...row('stocks:abc', 10, '2026-10-23', 'qualified', 'Mover'), market: 'stocks' }]);
  assert.equal(o!.priceAt, '2026-10-23T21:00:00.000Z');
});
