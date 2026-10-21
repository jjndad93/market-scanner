import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DAY_MS } from '../src/core/time.ts';
import { classifyMissingDates, fetchLiveDataset, parseDailyVolumes } from '../src/providers/coingecko.ts';
import { type FetchLike, createHttpClient } from '../src/providers/http.ts';
import { runScan, scoreCandidate, computeMetrics, volumeReliability } from '../src/scanner/analyze.ts';
import { normalizeDataset } from '../src/scanner/normalize.ts';
import { renderScanReport } from '../src/scanner/render.ts';
import { SCAN_RULES } from '../src/scanner/rules.ts';
import type { RawAsset } from '../src/scanner/types.ts';

// Network guard: everything here is offline (mock fetch for the provider test).
globalThis.fetch = (() => {
  throw new Error('Network access is not allowed in tests.');
}) as typeof fetch;

// All data below is SYNTHETIC TEST DATA: invented coins and numbers.
const NOW = new Date('2026-10-21T12:00:00Z');
const steady = (base: number, n = 30) => Array.from({ length: n }, (_, i) => base * (i % 2 ? 1.05 : 0.95));
/** Half the days near `low`, half near `high`: an erratic baseline. */
const erratic = (low: number, high: number, n = 30) => Array.from({ length: n }, (_, i) => (i % 2 ? high : low));

test('reliability measure: Q3/Q1 of the valid daily volumes; trigger at the documented ratio', () => {
  assert.equal(SCAN_RULES.variableBaselineIqrRatio, 4);
  const stable = volumeReliability(steady(20e6));
  assert.equal(stable.insufficient, false);
  if (!stable.insufficient) {
    assert.ok(stable.iqrRatio < 1.2, String(stable.iqrRatio));
    assert.equal(stable.highlyVariable, false);
  }
  const wild = volumeReliability(erratic(1e6, 50e6));
  assert.ok(!wild.insufficient && wild.highlyVariable && wild.iqrRatio === 50);
  // Boundary (linear interpolation, 20 values): ten at 1 and ten at 4 give Q1 = 1, Q3 = 4, ratio exactly 4.
  const at = volumeReliability([...Array(10).fill(1e6), ...Array(10).fill(4e6)]);
  assert.ok(!at.insufficient && at.iqrRatio === 4 && at.highlyVariable);
  const below = volumeReliability([...Array(10).fill(1e6), ...Array(10).fill(3.99e6)]);
  assert.ok(!below.insufficient && !below.highlyVariable);
});

test('one tiny or zero day cannot trigger it (unlike max/min); too few days are reported as insufficient', () => {
  const tinyDay = [...steady(20e6, 29), 0.1e6]; // max/min is about 200x here
  const r = volumeReliability(tinyDay);
  assert.ok(!r.insufficient && !r.highlyVariable, JSON.stringify(r));
  const withZeros = volumeReliability([...steady(20e6, 25), 0, 0, 0, 0, 0]); // zeros are not valid volumes
  assert.equal(withZeros.validDays, 25);
  assert.equal(withZeros.insufficient, false);
  assert.deepEqual(volumeReliability(steady(20e6, 19)), { validDays: 19, insufficient: true });
  assert.deepEqual(volumeReliability([...steady(20e6, 15), 0, 0, 0, 0, 0]), { validDays: 15, insufficient: true });
});

test('missing dates: parsed exactly and classified inside versus before the 30-day baseline window', () => {
  const today = Date.UTC(2026, 9, 21);
  // Daily points for 91 completed days, with 2026-08-01 (old) and 2026-10-05 (recent) removed,
  // and the series stopping on 2026-10-18 (two missing recent days: 10-19 and 10-20).
  const pts = Array.from({ length: 91 }, (_, i) => today - (91 - i) * DAY_MS)
    .filter((t) => !['2026-08-01', '2026-10-05', '2026-10-19', '2026-10-20'].includes(new Date(t).toISOString().slice(0, 10)))
    .map((t) => [t, 1e6]);
  const { missingDates, stats } = parseDailyVolumes({ total_volumes: pts }, NOW);
  assert.deepEqual(missingDates, ['2026-08-01', '2026-10-05', '2026-10-19', '2026-10-20']);
  assert.deepEqual([stats.gaps, stats.missingRecent], [2, 2]); // existing counts unchanged
  const c = classifyMissingDates(missingDates, NOW, 30);
  assert.equal(c.windowStart, '2026-09-21');
  assert.deepEqual(c.inWindow, ['2026-10-05', '2026-10-19', '2026-10-20']);
  assert.deepEqual(c.beforeWindow, ['2026-08-01']);
  // The window's first day itself is inside; the day before it is not.
  assert.deepEqual(classifyMissingDates(['2026-09-20', '2026-09-21'], NOW, 30), { inWindow: ['2026-09-21'], beforeWindow: ['2026-09-20'], windowStart: '2026-09-21' });
});

test('live notes name each asset with missing days and say whether they affected its baseline', async () => {
  const today = Date.UTC(2026, 9, 21);
  const chart = (drop: string[]) => ({
    total_volumes: Array.from({ length: 91 }, (_, i) => today - (91 - i) * DAY_MS)
      .filter((t) => !drop.includes(new Date(t).toISOString().slice(0, 10)))
      .map((t, i) => [t, Math.round(20e6 * (i % 2 ? 1.05 : 0.95))]),
  });
  const coin = (id: string) => ({ id, symbol: id.slice(4), name: `Synthetic ${id}`, current_price: 5, market_cap: 1e9, total_volume: 50e6, price_change_percentage_24h: 0.5, price_change_percentage_7d_in_currency: 1, last_updated: '2026-10-21T11:57:00.000Z' });
  const charts: Record<string, unknown> = {
    'syn-old': chart(['2026-07-26', '2026-08-02']), // gaps only before the window
    'syn-new': chart(['2026-10-05', '2026-10-06']), // gaps inside the window
    'syn-ok': chart([]),
  };
  const fn: FetchLike = async (url) => {
    const body = url.includes('/coins/markets') ? Object.keys(charts).map(coin) : charts[/\/coins\/([^/]+)\//.exec(url)![1]!];
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };
  const client = createHttpClient({ fetch: fn, baseUrl: 'https://api.example.test', apiKeyHeader: 'h', apiKey: 'TEST-KEY-not-real', maxCalls: 10, sleep: async () => {} });
  const data = await fetchLiveDataset({ client, clock: () => NOW, maxCalls: 10, sleep: async () => {} });
  const notes = data.dataset.notes.join('\n');
  assert.match(notes, /4 missing days and 0 missing recent days \(by asset below; only days inside the 30-day baseline window affect a baseline\)\./);
  assert.match(notes, /Missing history for syn-old: 2 daily observation\(s\), all before its 30-day baseline window \(which starts 2026-09-21\), so they did not affect its baseline \(2026-07-26, 2026-08-02\)\./);
  assert.match(notes, /Missing history for syn-new: 2 daily observation\(s\), 2 inside its 30-day baseline window \(counted as unusable days in that baseline: 2026-10-05, 2026-10-06\)\./);
  assert.doesNotMatch(notes, /Missing history for syn-ok/);
  assert.doesNotMatch(notes, /missing recent days counted as unusable/); // the old misleading wording is gone
  // The two assets' baselines reflect it: syn-new has 2 unusable days in its window, syn-old none.
  const assets = normalizeDataset(data).assets;
  assert.deepEqual(Object.fromEntries(assets.map((a) => [a.id, a.history.invalidEntries])), { 'syn-old': 0, 'syn-new': 2, 'syn-ok': 0 });
});

/** A synthetic asset that passes every filter. */
const asset = (o: Partial<RawAsset> & { id: string }): RawAsset => ({
  symbol: o.id.toUpperCase(), name: `Synthetic ${o.id}`, price: 5, change24hPct: 0.5, change7dPct: 1,
  volume24h: 60e6, marketCap: 1e9, lastUpdated: '2026-10-21T11:57:00Z', dailyVolumes: steady(20e6), tags: [], ...o,
});
const SYN = { kind: 'synthetic', label: 'inline synthetic', source: 'Synthetic inline test data', asOf: '2026-10-21T11:58:00Z' };

test('report: the note appears only for a highly variable baseline, is labelled informational, and scores and order are unchanged', () => {
  // Same median (about 20M) for both watchlist assets; one erratic, one steady.
  const wildHist = erratic(2e6, 38e6); // median 20M, Q3/Q1 19
  const r = runScan(normalizeDataset({ dataset: SYN, assets: [asset({ id: 'calm' }), asset({ id: 'wild', dailyVolumes: wildHist })] }), NOW);
  // Equal scores and equal 3.00x multiples: the existing tie-break (volume, then id) orders them.
  assert.deepEqual(r.watchlist.map((c) => [c.asset.id, c.score]), [['calm', 4], ['wild', 4]]);
  for (const c of r.watchlist) {
    // The score is exactly what the unchanged scoring function gives: reliability does not enter it.
    assert.equal(c.score, scoreCandidate(c.asset, computeMetrics(c.asset, NOW), c.kind).score);
  }
  const wild = r.watchlist.find((c) => c.asset.id === 'wild')!;
  const calm = r.watchlist.find((c) => c.asset.id === 'calm')!;
  assert.ok(!wild.volumeReliability.insufficient && wild.volumeReliability.highlyVariable);
  assert.ok(!calm.volumeReliability.insufficient && !calm.volumeReliability.highlyVariable);
  const text = renderScanReport(r);
  const flat = text.replace(/\s+/g, ' ');
  assert.match(flat, /Volume baseline: HIGHLY VARIABLE - the middle half of its 30 daily volumes spans a 19\.0x range \(\$2\.0M to \$38\.0M\), so the 3\.00x multiple is less conclusive\. This does not by itself mean manipulation or bad data\. Informational; not scored\./);
  assert.equal((text.match(/Volume baseline:/g) ?? []).length, 1); // the steady asset gets no line
  assert.match(text, /^!! TEST DATA - synthetic fixture/m); // synthetic output stays labelled
  assert.ok(text.split('\n').filter((l) => !l.startsWith('!! TEST DATA')).every((l) => l.length <= 100));
});

test('a mover with a variable baseline gets the same note; the ranking does not change', () => {
  const r = runScan(normalizeDataset({ dataset: SYN, assets: [
    asset({ id: 'm-calm', change24hPct: 12, change7dPct: 15, dailyVolumes: steady(20e6) }),
    asset({ id: 'm-wild', change24hPct: 12, change7dPct: 15, dailyVolumes: erratic(2e6, 38e6) }),
  ] }), NOW);
  // Both score identically and are ordered by the existing rule (score, relative volume, volume, id).
  assert.deepEqual(r.movers.map((c) => c.asset.id), ['m-calm', 'm-wild']);
  assert.equal(r.movers[0]!.score, r.movers[1]!.score);
  assert.equal(r.movers[1]!.score, scoreCandidate(r.movers[1]!.asset, computeMetrics(r.movers[1]!.asset, NOW), 'mover').score);
  assert.equal((renderScanReport(r).match(/Volume baseline: HIGHLY VARIABLE/g) ?? []).length, 1);
});
