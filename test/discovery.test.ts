// Step 2: broader crypto discovery. Every asset below is SYNTHETIC TEST DATA (invented ids and
// numbers); CoinGecko is mocked; no test contacts the internet or needs a credential.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DAY_MS } from '../src/core/time.ts';
import { fetchLiveDataset } from '../src/providers/coingecko.ts';
import { type FetchLike, createHttpClient } from '../src/providers/http.ts';
import { activitySignals, computeMetrics, runScan } from '../src/scanner/analyze.ts';
import { normalizeDataset } from '../src/scanner/normalize.ts';
import type { DiscoveryEntry, RawAsset, ScanResult } from '../src/scanner/types.ts';

globalThis.fetch = (() => {
  throw new Error('Network access is not allowed in tests.');
}) as typeof fetch;

const NOW = new Date('2026-10-21T12:00:00Z');
const FRESH = '2026-10-21T11:57:00Z';
const stable = (base = 20e6) => Array.from({ length: 30 }, (_, i) => (i % 2 ? base * 1.05 : base * 0.95));

function a(id: string, over: Partial<RawAsset> = {}): RawAsset {
  return { id, symbol: id.toUpperCase().replace(/-/g, '').slice(0, 6), name: `Test ${id}`, price: 5, change24hPct: 1, change7dPct: 2, volume24h: 20e6, marketCap: 1e9, lastUpdated: FRESH, dailyVolumes: stable(), ...over };
}

// One asset per discovery case (all synthetic).
const CASES: RawAsset[] = [
  a('strong', { change24hPct: 12, change7dPct: 15, volume24h: 60e6 }), // mover, rv 3, stable baseline
  a('noisy', { change24hPct: 12, change7dPct: 15, volume24h: 60e6, dailyVolumes: Array.from({ length: 30 }, (_, i) => (i % 2 ? 40e6 : 2e6)) }), // highly variable baseline
  a('spike', { change24hPct: 12, change7dPct: 15, volume24h: 250e6, marketCap: 2e9 }), // rv 12.5: extreme spike
  a('volonly', { change24hPct: 1, volume24h: 60e6 }), // watch: volume only
  a('weak', { change24hPct: 9, change7dPct: -5, volume24h: 32e6 }), // mover pattern, 3/8: below threshold
  a('pricey7d', { change24hPct: 3, change7dPct: 30, volume24h: 20e6 }), // big 7d move, normal volume
  a('churn', { change24hPct: 1, volume24h: 20e6, marketCap: 1.2e8 }), // high turnover only, normal for itself
  a('implausible', { change24hPct: 400, volume24h: 60e6 }), // beyond the plausibility limit
  a('stale', { change24hPct: 15, volume24h: 60e6, lastUpdated: '2026-10-21T09:00:00Z' }),
  a('missingvol', { change24hPct: 20, volume24h: null }),
  a('zeros', { change24hPct: 10, volume24h: 60e6, dailyVolumes: [...Array(8).fill(0), ...stable().slice(8)] }), // 8 zero days: unreliable baseline
  a('tinycap', { change24hPct: 30, volume24h: 20e6, marketCap: 5e7 }), // below the market-cap minimum: out of scope
  a('quiet'),
];

const run = (assets: RawAsset[]) => runScan(normalizeDataset({ dataset: { kind: 'synthetic', label: 'TEST DATA', source: 'test', asOf: FRESH }, assets }), NOW);
const ids = (list: DiscoveryEntry[]) => list.map((e) => e.id);
const find = (r: ScanResult, id: string) => [...r.discovery.highPriority, ...r.discovery.watchlist, ...r.discovery.insufficientData].find((e) => e.id === id);

test('strong activity against a reliable baseline is a high-priority candidate, with its evidence', () => {
  const r = run(CASES);
  assert.deepEqual(ids(r.discovery.highPriority), ['strong']);
  const e = r.discovery.highPriority[0]!;
  assert.deepEqual([e.status, e.kind, e.score, e.maxScore], ['shortlisted', 'mover', 6, 8]);
  assert.match(e.reasons[0]!, /Mover: large move on unusual volume, evidence 6\/8/);
  assert.ok(e.reasons.some((x) => /unusual volume 3\/3: 3\.00x the 30-day median/.test(x)));
  assert.ok(e.reasons.some((x) => /7-day trend 1\/1/.test(x)));
  assert.deepEqual(e.caveats, []);
  assert.deepEqual(e.activity.map((s) => s.code), ['large_24h_move']);
});

test('weak or noisy signals are watchlist entries, each with the caveat that held them back', () => {
  const r = run(CASES);
  assert.deepEqual(ids(r.discovery.watchlist), ['spike', 'noisy', 'volonly', 'weak', 'pricey7d']);
  assert.match(find(r, 'noisy')!.caveats.join(' '), /Highly variable volume baseline \(Q3\/Q1 20\.0x\)/);
  assert.match(find(r, 'spike')!.caveats.join(' '), /Extreme volume spike \(12\.5x\)/);
  assert.match(find(r, 'volonly')!.caveats[0]!, /One signal only: unusual volume without a large price move/);
  const weak = find(r, 'weak')!;
  assert.equal(weak.status, 'below_threshold');
  assert.match(weak.caveats[0]!, /Evidence 3\/8 is below the scanner's threshold of 4/);
  const p = find(r, 'pricey7d')!;
  assert.deepEqual([p.status, p.kind, p.score], ['below_threshold', null, null]);
  assert.deepEqual(p.reasons, ['+30.0% over 7 days (at least 20%)']);
  assert.match(p.caveats[0]!, /not unusual against its own baseline \(1\.00x the median\), so the move lacks volume confirmation/);
  // High turnover alone, with normal volume for the asset itself, is not surfaced.
  assert.equal(find(r, 'churn'), undefined);
  assert.equal(find(r, 'quiet'), undefined);
});

test('extreme moves without supporting evidence, missing and stale data, and unreliable baselines are "insufficient data"', () => {
  const r = run(CASES);
  assert.deepEqual(ids(r.discovery.insufficientData), ['implausible', 'missingvol', 'stale', 'zeros']);
  const why = (id: string) => find(r, id)!.caveats.join(' ');
  assert.match(why('implausible'), /Not evaluated: 24h change of 400% exceeds the 300% plausibility limit/);
  assert.match(why('stale'), /Not evaluated: data is 180 minutes old/);
  assert.match(why('missingvol'), /Not evaluated: missing evidence: 24h volume not provided/);
  assert.match(why('zeros'), /Not evaluated: .*8 zero-volume.*baseline unreliable/);
  for (const e of r.discovery.insufficientData) {
    assert.deepEqual([e.status, e.score, e.kind], ['not_evaluated', null, null]); // never ranked by score
    assert.ok(e.reasons.length > 0, `${e.id} says why it was surfaced`);
  }
  // Out-of-scope assets (here: below the market-cap minimum) are not listed, only counted.
  assert.equal(find(r, 'tinycap'), undefined);
  assert.ok(r.discovery.coverage.notes.some((n) => /1 asset\(s\) with snapshot activity were excluded by the scanner's scope rules/.test(n)));
  assert.equal(r.discovery.coverage.withActivityNotEvaluated, 4);
});

test('discovery never changes scores, ranks or display limits', () => {
  const r = run(CASES);
  // Existing scoring: spike = 3 (12.5x) + 1 (12%) + 2 ($250M) + 1 (trend) = 7; noisy = 2 (2.86x vs a $21M median) + 1 + 1 + 1 = 5.
  assert.deepEqual(r.movers.map((c) => [c.asset.id, c.score]), [['spike', 7], ['strong', 6], ['noisy', 5]]);
  assert.deepEqual(r.watchlist.map((c) => [c.asset.id, c.score]), [['volonly', 4]]);
  assert.deepEqual(r.belowThreshold.map((c) => c.asset.id), ['weak']);
  // Over the display limit: still surfaced, with its status.
  const many = run([...Array.from({ length: 7 }, (_, i) => a(`strong-${i}`, { change24hPct: 12 + i, change7dPct: 15, volume24h: 60e6 }))]);
  assert.equal(many.movers.length, 5);
  assert.equal(many.discovery.highPriority.length, 7);
  assert.deepEqual(many.discovery.highPriority.map((e) => e.status), [...Array(5).fill('shortlisted'), 'over_display_limit', 'over_display_limit']);
});

test('ranking is stable: the same data in any input order gives the same discovery result', () => {
  const base = JSON.stringify(run(CASES).discovery);
  for (let seed = 1; seed <= 5; seed++) {
    const shuffled = [...CASES].sort((x, y) => ((x.id.charCodeAt(seed % x.id.length) * seed) % 7) - ((y.id.charCodeAt(seed % y.id.length) * seed) % 7));
    assert.equal(JSON.stringify(run(shuffled).discovery), base, `order ${seed}`);
  }
  assert.equal(JSON.stringify(run([...CASES].reverse()).discovery), base);
});

test('activity signals read the snapshot only, reusing the scanner\'s turnover', () => {
  const n = normalizeDataset({ dataset: { kind: 'synthetic', label: 'TEST DATA', source: 'test', asOf: FRESH }, assets: [a('x', { change24hPct: -9, change7dPct: -25, volume24h: 30e6, marketCap: 1.5e8, dailyVolumes: [] })] });
  const s = activitySignals(n.assets[0]!, computeMetrics(n.assets[0]!, NOW));
  assert.deepEqual(s.map((x) => x.code), ['large_24h_move', 'high_turnover', 'large_7d_move']);
  assert.match(s[1]!.detail, /24h volume is 20% of market cap/);
  const none = normalizeDataset({ dataset: { kind: 'synthetic', label: 'TEST DATA', source: 'test', asOf: FRESH }, assets: [a('y', { change24hPct: null, change7dPct: null, volume24h: null })] });
  assert.deepEqual(activitySignals(none.assets[0]!, computeMetrics(none.assets[0]!, NOW)), []); // missing data gives no signal, never a guess
});

// ---- live: request limits and history order (mocked CoinGecko) ----------------------------------

const TODAY = Date.UTC(2026, 9, 21);
const chart = (base: number) => ({ total_volumes: [...Array.from({ length: 91 }, (_, i) => [TODAY - (91 - i) * DAY_MS, Math.round(base * (i % 2 ? 1.05 : 0.95))]), [NOW.getTime() - 60_000, base * 3]] });
const coin = (id: string, o: Record<string, unknown>) => ({ id, symbol: id.slice(0, 5), name: `Test ${id}`, current_price: 5, market_cap: 1e9, total_volume: 50e6, price_change_percentage_24h: 1, price_change_percentage_7d_in_currency: 2, last_updated: '2026-10-21T11:57:00.000Z', ...o });
// Market-cap order (as /coins/markets returns it): two large quiet coins, then two smaller active ones.
const MARKETS = [
  coin('big-one', { market_cap: 9e9, total_volume: 300e6 }),
  coin('big-two', { market_cap: 8e9, total_volume: 250e6 }),
  coin('small-move', { market_cap: 3e8, total_volume: 2e7, price_change_percentage_24h: 15, price_change_percentage_7d_in_currency: 12 }),
  coin('small-churn', { market_cap: 1.5e8, total_volume: 3e7, price_change_percentage_24h: 2, price_change_percentage_7d_in_currency: 25 }),
];

async function liveScan(maxCalls: number) {
  const urls: string[] = [];
  const fn: FetchLike = async (url) => {
    urls.push(url);
    const id = /\/coins\/([^/]+)\/market_chart/.exec(url)?.[1];
    const body = url.includes('/coins/markets') ? MARKETS : chart(id?.startsWith('big') ? 200e6 : 1e7);
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };
  const client = createHttpClient({ fetch: fn, baseUrl: 'https://api.example.test/api/v3', apiKeyHeader: 'x-cg-demo-api-key', apiKey: 'TEST-KEY-not-real', maxCalls, sleep: async () => {} });
  const data = await fetchLiveDataset({ client, clock: () => NOW, maxCalls, sleep: async () => {} });
  return { data, urls, result: runScan(normalizeDataset(data), NOW) };
}
const historyIds = (urls: string[]) => urls.filter((u) => u.includes('/market_chart')).map((u) => /\/coins\/([^/]+)\//.exec(u)![1]);

test('under a request limit, history goes to assets with snapshot activity first (no extra requests)', async () => {
  const { urls, data, result } = await liveScan(3); // 1 markets call + 2 histories
  assert.equal(urls.length, 3);
  assert.deepEqual(historyIds(urls), ['small-churn', 'small-move']); // 2 signals, then 1; the quiet large caps wait
  assert.ok(data.dataset.notes.some((n) => /History was requested first for the 2 eligible asset\(s\) showing snapshot activity/.test(n)));
  assert.deepEqual(ids(result.discovery.highPriority), ['small-move']);
  assert.ok(result.discovery.coverage.notes.some((n) => /Incomplete scan: volume history was not obtained for 2 of 4 eligible asset\(s\) \(the per-run limit of 3 requests was reached\)/.test(n)));
  // The quiet large caps were not evaluated, and have no activity: not listed as leads.
  assert.equal(find(result, 'big-one'), undefined);
});

test('an active asset left out by the request limit is listed as insufficient data, not dropped', async () => {
  const { urls, result } = await liveScan(2); // 1 markets call + 1 history
  assert.deepEqual(historyIds(urls), ['small-churn']);
  const e = find(result, 'small-move')!;
  assert.equal(e.tier, 'insufficient_data');
  assert.match(e.caveats.join(' '), /Not evaluated: volume history was not requested in this run \(request or rate limit reached\)/);
  assert.deepEqual(e.reasons, ['+15.0% in 24h (at least 8%)']);
});

test('with enough requests, every eligible history is fetched exactly as before (same set, same count)', async () => {
  const { urls, result } = await liveScan(160);
  assert.equal(urls.length, 5);
  assert.deepEqual([...historyIds(urls)].sort(), ['big-one', 'big-two', 'small-churn', 'small-move']);
  assert.equal(result.dataset.coverage!.complete, true);
  assert.ok(!result.discovery.coverage.notes.some((n) => /Incomplete scan/.test(n)));
});

test('dashboard renders discovery tiers as text only', () => {
  const app = readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
  // Evaluated leads (high-priority, watchlist) appear as table rows with their cautions; coins that could
  // not be evaluated get their own folded list.
  for (const s of ['Moved but not checked', 'could not be evaluated for lack of reliable data', '...r.discovery.highPriority, ...r.discovery.watchlist']) assert.ok(app.includes(s), s);
  assert.match(app, /if \(r\.discovery\) root\.append\(discoveryView\(r\.discovery, coverage\.length > 0\)\)/);
  assert.doesNotMatch(app, /innerHTML|insertAdjacentHTML/);
});
