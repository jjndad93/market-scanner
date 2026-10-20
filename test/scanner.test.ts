import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { classify, compareCandidates, computeMetrics, exclusionReasons, median, runScan, scoreCandidate } from '../src/scanner/analyze.ts';
import { normalizeDataset } from '../src/scanner/normalize.ts';
import { renderScanReport } from '../src/scanner/render.ts';
import { SCAN_RULES } from '../src/scanner/rules.ts';
import type { RawAsset } from '../src/scanner/types.ts';

// Network guard: P1 is offline. Any attempt to fetch fails the test run loudly.
globalThis.fetch = (() => {
  throw new Error('Network access is not allowed in scanner tests (Stage 2 P1 is offline).');
}) as typeof fetch;

// All data below is SYNTHETIC TEST DATA: invented coins and numbers, not market data.
const NOW = new Date('2026-10-21T12:00:00Z'); // 08:00 ET
const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/crypto-scan.synthetic.json', import.meta.url), 'utf8'));
const SYN = { kind: 'synthetic', label: 'inline synthetic', source: 'Synthetic inline test data', asOf: '2026-10-21T11:58:00Z' };
const hist = (base: number, days = 30) => Array.from({ length: days }, (_, i) => Math.round(base * (i % 2 ? 1.05 : 0.95)));

/** A synthetic asset that passes every filter and matches no pattern unless overridden. */
function asset(o: Partial<RawAsset> & { id: string }): RawAsset {
  return {
    symbol: o.id.toUpperCase(), name: `Synthetic ${o.id}`, price: 5, change24hPct: 0.5, change7dPct: 1,
    volume24h: 50e6, marketCap: 1e9, lastUpdated: '2026-10-21T11:57:00Z', dailyVolumes: hist(50e6), tags: [], ...o,
  };
}
const scanOf = (assets: RawAsset[], rules = SCAN_RULES) => runScan(normalizeDataset({ dataset: SYN, assets }, rules), NOW, rules);
const symbols = (cs: { asset: { symbol: string } }[]) => cs.map((c) => c.asset.symbol);
const firstAsset = (raw: RawAsset) => normalizeDataset({ dataset: SYN, assets: [raw] }).assets[0]!;

// ---- Normalization and honest labeling --------------------------------------------------------

test('dataset headers are validated: unknown kinds, and live data without attribution, are rejected', () => {
  // P2 S1: "live" is now a valid kind (deliberate change from P1), but only with attribution.
  assert.throws(() => normalizeDataset({ dataset: { ...SYN, kind: 'bogus' }, assets: [] }), /Unknown dataset kind/);
  assert.throws(() => normalizeDataset({ dataset: { ...SYN, kind: 'live' }, assets: [] }), /attribution/);
  assert.throws(() => normalizeDataset({ dataset: { ...SYN, kind: 'live', attribution: 'x', notes: [1] }, assets: [] }), /notes/);
  assert.throws(() => normalizeDataset({ assets: [] }), /dataset/);
  assert.throws(() => normalizeDataset({ dataset: { ...SYN, asOf: 'yesterday' }, assets: [] }), /asOf/);
});

test('every normalized value is tagged TEST DATA with its source and timestamp, never verified market data', () => {
  const { assets } = normalizeDataset(FIXTURE);
  for (const a of assets) {
    for (const e of [a.price, a.change24hPct, a.change7dPct, a.volume24h, a.marketCap, a.lastUpdated]) {
      assert.notEqual(e.kind, 'verified_market_data');
      if (e.kind !== 'missing') {
        assert.equal(e.kind, 'test_data');
        assert.match(e.source, /synthetic/i);
        assert.ok(e.asOf, `${a.symbol} value has no timestamp`);
      }
    }
  }
});

test('missing or invalid numbers become explicit missing evidence with a reason', () => {
  const a = firstAsset(asset({ id: 'gap', volume24h: null, marketCap: -5, price: Number.NaN }));
  assert.equal(a.volume24h.kind, 'missing');
  assert.match(a.volume24h.note!, /not provided/);
  assert.match(a.marketCap.note!, /invalid/);
  assert.match(a.price.note!, /invalid/);
});

test('records without a usable id, symbol or name are excluded with a reason, not dropped silently', () => {
  const r = runScan(normalizeDataset({ dataset: SYN, assets: [{ symbol: 'X' }, asset({ id: 'ok' })] }), NOW);
  assert.equal(r.universe, 2);
  assert.equal(r.excluded[0]!.reasons[0]!.code, 'invalid_record');
});

// ---- Calculations -----------------------------------------------------------------------------

test('median handles odd, even and empty inputs', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
});

test('relative volume, turnover and data age are calculated from known values', () => {
  const a = firstAsset(asset({ id: 'calc', volume24h: 300e6, marketCap: 1.5e9, dailyVolumes: [100e6, 200e6, 50e6, 100e6, 150e6] }));
  const m = computeMetrics(a, NOW);
  assert.equal(m.baselineVolume.value, 100e6); // median of 50, 100, 100, 150, 200 (millions)
  assert.equal(m.relativeVolume.value, 3);
  assert.equal(m.relativeVolume.kind, 'calculated');
  assert.equal(m.turnover.value, 0.2);
  assert.equal(m.dataAgeMinutes, 3); // 11:57 -> 12:00
});

test('relative volume is missing, not guessed, without volume or history', () => {
  assert.equal(computeMetrics(firstAsset(asset({ id: 'novol', volume24h: null })), NOW).relativeVolume.kind, 'missing');
  assert.equal(computeMetrics(firstAsset(asset({ id: 'nohist', dailyVolumes: [] })), NOW).relativeVolume.kind, 'missing');
});

// ---- Filters ----------------------------------------------------------------------------------

test('each filter produces its own exclusion code and an explanatory detail', () => {
  const cases: [Partial<RawAsset>, string][] = [
    [{ symbol: 'USDC' }, 'stablecoin'],
    [{ tags: ['stablecoin'] }, 'stablecoin'],
    [{ price: 1.004, change24hPct: 0.1, change7dPct: 0.3 }, 'possible_stablecoin'], // heuristic, not proof
    [{ symbol: 'WBTC' }, 'wrapped_or_staked'],
    [{ name: 'Staked Synthetic Thing' }, 'wrapped_or_staked'],
    [{ marketCap: 50e6 }, 'below_market_cap'],
    [{ volume24h: 9e6 }, 'below_volume'],
    [{ dailyVolumes: hist(50e6, 19) }, 'insufficient_history'],
    [{ lastUpdated: '2026-10-21T11:44:00Z' }, 'stale_data'], // 16 minutes old
    [{ lastUpdated: '2026-10-21T12:30:00Z' }, 'stale_data'], // in the future
    [{ change24hPct: null }, 'missing_data'],
  ];
  for (const [over, code] of cases) {
    const a = firstAsset(asset({ id: 'f', ...over }));
    const reasons = exclusionReasons(a, computeMetrics(a, NOW));
    assert.ok(reasons.some((r) => r.code === code), `${JSON.stringify(over)} -> ${JSON.stringify(reasons)}`);
    for (const r of reasons) assert.ok(r.detail.length > 10, 'every reason needs an explanation');
  }
});

test('filter boundaries: exactly at each minimum passes', () => {
  const a = firstAsset(asset({ id: 'edge', marketCap: SCAN_RULES.minMarketCap, volume24h: SCAN_RULES.minVolume24h, dailyVolumes: hist(10e6, SCAN_RULES.minHistoryDays), lastUpdated: '2026-10-21T11:45:00Z' }));
  assert.deepEqual(exclusionReasons(a, computeMetrics(a, NOW)), []);
});

test('all applicable exclusion reasons are kept, and a missing 7-day change does not exclude', () => {
  const multi = firstAsset(asset({ id: 'multi', volume24h: 1e6, marketCap: 10e6, dailyVolumes: hist(1e6, 5) }));
  const codes = exclusionReasons(multi, computeMetrics(multi, NOW)).map((r) => r.code);
  assert.deepEqual(codes, ['below_market_cap', 'below_volume', 'insufficient_history']);
  const no7d = firstAsset(asset({ id: 'no7d', change7dPct: null }));
  assert.deepEqual(exclusionReasons(no7d, computeMetrics(no7d, NOW)), []);
});

// ---- Classification and scoring ---------------------------------------------------------------

test('mover and watchlist patterns apply exactly at their thresholds', () => {
  const kindOf = (over: Partial<RawAsset>) => {
    const a = firstAsset(asset({ id: 'k', dailyVolumes: hist(20e6), ...over }));
    return classify(a, computeMetrics(a, NOW));
  };
  assert.equal(kindOf({ change24hPct: 8, volume24h: 30e6 }), 'mover'); // 8% and 1.5x
  assert.equal(kindOf({ change24hPct: -8, volume24h: 30e6 }), 'mover');
  assert.equal(kindOf({ change24hPct: 7.99, volume24h: 30e6 }), null);
  assert.equal(kindOf({ change24hPct: 8, volume24h: 29.9e6 }), null);
  assert.equal(kindOf({ change24hPct: 4.99, volume24h: 40e6 }), 'watch'); // < 5% and 2x
  assert.equal(kindOf({ change24hPct: 5, volume24h: 40e6 }), null);
  assert.equal(kindOf({ change24hPct: 1, volume24h: 39.9e6 }), null);
});

test('scoring is transparent: each rule reports its points, maximum and evidence', () => {
  const a = firstAsset(FIXTURE.assets[0]); // Synthetic Alpha
  const m = computeMetrics(a, NOW);
  const s = scoreCandidate(a, m, 'mover');
  assert.equal(s.score, 8);
  assert.equal(s.maxScore, 8);
  assert.deepEqual(s.breakdown.map((p) => [p.rule, p.points, p.max]), [
    ['unusual volume', 3, 3], ['size of move', 2, 2], ['liquidity', 2, 2], ['7-day trend', 1, 1],
  ]);
  for (const p of s.breakdown) assert.ok(p.detail.length > 5);
});

test('a missing 7-day change scores 0 for trend and says so', () => {
  const a = firstAsset(asset({ id: 'm7', change24hPct: 12, change7dPct: null, volume24h: 120e6, dailyVolumes: hist(40e6) }));
  const trend = scoreCandidate(a, computeMetrics(a, NOW), 'mover').breakdown.find((p) => p.rule === '7-day trend')!;
  assert.equal(trend.points, 0);
  assert.match(trend.detail, /missing/);
});

// ---- Ranking, ties and limits -----------------------------------------------------------------

test('ranking is deterministic: score, then relative volume, then volume, then id', () => {
  const base = { change24hPct: 10, change7dPct: 12, dailyVolumes: hist(20e6) };
  const r = scanOf([
    asset({ id: 'zeta', ...base, volume24h: 50e6 }), // rv 2.5 -> 2 pts; vol 50M -> 1 pt
    asset({ id: 'alpha', ...base, volume24h: 50e6 }), // identical to zeta: tie broken by id
    asset({ id: 'beta', ...base, volume24h: 55e6 }), // same score, higher rv and volume
    asset({ id: 'gamma', ...base, change24hPct: 16, volume24h: 50e6 }), // higher score
  ]);
  assert.deepEqual(r.movers.map((c) => c.asset.id), ['gamma', 'beta', 'alpha', 'zeta']);
  // Input order does not matter.
  const reversed = scanOf([asset({ id: 'gamma', ...base, change24hPct: 16, volume24h: 50e6 }), asset({ id: 'beta', ...base, volume24h: 55e6 }), asset({ id: 'alpha', ...base, volume24h: 50e6 }), asset({ id: 'zeta', ...base, volume24h: 50e6 })]);
  assert.deepEqual(reversed.movers.map((c) => c.asset.id), ['gamma', 'beta', 'alpha', 'zeta']);
  assert.ok(compareCandidates(r.movers[0]!, r.movers[1]!) < 0);
});

test('movers and watchlist respect their display limits; the rest are reported, not lost', () => {
  const movers = Array.from({ length: 8 }, (_, i) => asset({ id: `m${i}`, change24hPct: 10 + i, change7dPct: 12, volume24h: 60e6, dailyVolumes: hist(20e6) }));
  const watch = Array.from({ length: 5 }, (_, i) => asset({ id: `w${i}`, change24hPct: 1, volume24h: (60 + i) * 1e6, dailyVolumes: hist(20e6) }));
  const r = scanOf([...movers, ...watch]);
  assert.equal(r.movers.length, SCAN_RULES.maxMovers);
  assert.equal(r.moversOverLimit.length, 3);
  assert.equal(r.watchlist.length, SCAN_RULES.maxWatchlist);
  assert.equal(r.watchlistOverLimit.length, 2);
  const report = renderScanReport(r);
  assert.match(report, /\+3 more met the threshold but exceed the display limit/);
  assert.ok(report.split('\n').length <= 60, `report is ${report.split('\n').length} lines`);
});

// ---- The synthetic fixture end to end ---------------------------------------------------------

test('fixture scan: expected movers, watchlist, below-threshold and exclusions', () => {
  const r = runScan(normalizeDataset(FIXTURE), NOW);
  assert.equal(r.universe, 14);
  assert.equal(r.passedFilters, 6);
  assert.deepEqual(symbols(r.movers), ['SALP', 'SBRV']);
  assert.deepEqual(r.movers.map((c) => [c.score, c.direction]), [[8, 'up'], [5, 'down']]);
  assert.deepEqual(symbols(r.watchlist), ['SECH', 'SDLT']);
  assert.deepEqual(symbols(r.belowThreshold), ['SCHR']);
  assert.equal(r.notCandidates, 1); // SQUI
  const reasonOf = Object.fromEntries(r.excluded.map((e) => [e.symbol, e.reasons[0]!.code]));
  assert.deepEqual(reasonOf, {
    SUSD: 'stablecoin', SPEG: 'possible_stablecoin', WSALP: 'wrapped_or_staked', STHN: 'below_volume',
    SMIC: 'below_market_cap', SNEW: 'insufficient_history', SSTL: 'stale_data', SGAP: 'missing_data',
  });
  for (const e of r.excluded) assert.ok(e.reasons.length > 0 && e.reasons.every((x) => x.detail));
});

test('the same input always produces the same result', () => {
  const a = JSON.stringify(runScan(normalizeDataset(FIXTURE), NOW));
  const b = JSON.stringify(runScan(normalizeDataset(structuredClone(FIXTURE)), NOW));
  assert.equal(a, b);
});

test('fixture report: labeled TEST DATA, honest source and timestamps, catalysts unverified, under 60 lines', () => {
  const report = renderScanReport(runScan(normalizeDataset(FIXTURE), NOW));
  const lines = report.split('\n');
  assert.ok(lines.length <= 60, `report is ${lines.length} lines`);
  assert.match(lines[1]!, /TEST DATA - synthetic fixture .*NOT market data/);
  assert.match(lines[2]!, /^Source: Synthetic test fixture \(no data provider\) \[TEST DATA\]$/);
  assert.match(lines[3]!, /^Snapshot: 2026-10-21 07:58 ET\. No live data was fetched\.$/);
  assert.doesNotMatch(report, /VERIFIED DATA|verified_market_data|live data:/i);
  assert.equal((report.match(/Catalyst: NOT VERIFIED/g) ?? []).length, 4); // 2 movers + 2 watchlist
  assert.equal((report.match(/\[TEST DATA\]/g) ?? []).length, 5); // source line + 4 candidates
  assert.match(report, /Data: 2026-10-21 07:57 ET \(3 min old\)/);
  // Every excluded asset is listed with a reason label.
  for (const sym of ['SUSD', 'SPEG', 'WSALP', 'STHN', 'SMIC', 'SNEW', 'SSTL', 'SGAP']) assert.match(report, new RegExp(`\\b${sym}\\b`));
  assert.match(report, /Below evidence threshold \(not shown\): SCHR \(3\/8\)/);
  assert.match(report, /not expected returns\. No price targets\./);
});

// ---- Empty results ----------------------------------------------------------------------------

test('no candidates: the report says so explicitly', () => {
  const quiet = scanOf([asset({ id: 'q1' }), asset({ id: 'q2', symbol: 'USDT' })]);
  assert.equal(quiet.movers.length + quiet.watchlist.length, 0);
  const report = renderScanReport(quiet);
  assert.match(report, /No candidates met the evidence threshold\./);
  assert.doesNotMatch(report, /^MOVERS/m);
  assert.match(report, /stablecoin: USDT/);
});

test('no candidates when the only pattern matches score below the threshold, and they are named', () => {
  const weak = scanOf([asset({ id: 'weak', change24hPct: 8.5, change7dPct: -1, volume24h: 30e6, dailyVolumes: hist(20e6) })]); // 1+1+1+0 = 3 < 4
  assert.equal(weak.belowThreshold.length, 1);
  const report = renderScanReport(weak);
  assert.match(report, /No candidates met the evidence threshold\./);
  assert.match(report, /scored below the threshold: WEAK \(3\/8\)/);
});

test('an empty dataset produces a valid no-candidates report', () => {
  const report = renderScanReport(scanOf([]));
  assert.match(report, /Universe: 0 assets/);
  assert.match(report, /No candidates met the evidence threshold\./);
});

// ---- Review fixes (all inputs SYNTHETIC) ------------------------------------------------------

const ranked = (r: ReturnType<typeof scanOf>) => [...r.movers, ...r.watchlist, ...r.belowThreshold, ...r.moversOverLimit, ...r.watchlistOverLimit];
const codesOf = (r: ReturnType<typeof scanOf>, id: string) => r.excluded.filter((e) => e.id === id).flatMap((e) => e.reasons.map((x) => x.code));
/** A clean mover: +10% on 2.5x normal volume, 7-day trend agrees. */
const mover = (o: Partial<RawAsset> & { id: string }) => asset({ change24hPct: 10, change7dPct: 12, volume24h: 50e6, dailyVolumes: hist(20e6), ...o });

// Fix 1: implausible values earn no points.

test('fix 1: a +5000% 24h move is excluded as implausible data, not scored 8/8', () => {
  const r = scanOf([mover({ id: 'boom', change24hPct: 5000, change7dPct: 6000, volume24h: 200e6 })]);
  assert.equal(ranked(r).length, 0);
  assert.ok(codesOf(r, 'boom').includes('implausible_data'));
  assert.match(r.excluded[0]!.reasons.find((x) => x.code === 'implausible_data')!.detail, /300%/);
});

test('fix 1 boundaries: |24h| 300% and |7d| 1000% are allowed; just above is excluded', () => {
  assert.ok(ranked(scanOf([mover({ id: 'm300', change24hPct: 300, change7dPct: 400 })])).length === 1);
  assert.ok(codesOf(scanOf([mover({ id: 'm301', change24hPct: 300.1, change7dPct: 400 })]), 'm301').includes('implausible_data'));
  assert.ok(ranked(scanOf([mover({ id: 'w1000', change7dPct: 1000 })])).length === 1);
  assert.ok(codesOf(scanOf([mover({ id: 'w1001', change7dPct: 1000.1 })]), 'w1001').includes('implausible_data'));
});

test('fix 1: turnover of 2000% is excluded; turnover exactly 100% is allowed', () => {
  const r = scanOf([mover({ id: 'churn', change24hPct: 12, change7dPct: 15, volume24h: 2e9, marketCap: 100e6, dailyVolumes: hist(400e6) })]);
  assert.equal(ranked(r).length, 0);
  assert.ok(codesOf(r, 'churn').includes('implausible_data'));
  const edge = scanOf([mover({ id: 'edge', volume24h: 200e6, marketCap: 200e6, dailyVolumes: hist(80e6) })]);
  assert.equal(ranked(edge).length, 1);
  const over = scanOf([mover({ id: 'over', volume24h: 202e6, marketCap: 200e6, dailyVolumes: hist(80e6) })]);
  assert.ok(codesOf(over, 'over').includes('implausible_data'));
});

test('fix 1: a near-zero baseline cannot create a 5000x relative-volume score', () => {
  const r = scanOf([asset({ id: 'tiny', change24hPct: 1, volume24h: 50e6, dailyVolumes: hist(0.01e6) })]);
  assert.equal(ranked(r).length, 0);
  assert.ok(codesOf(r, 'tiny').includes('unreliable_history'), JSON.stringify(r.excluded));
  // Baseline exactly $1M/day is accepted (relative volume 20x stays under the 50x limit).
  assert.equal(ranked(scanOf([mover({ id: 'base1m', volume24h: 20e6, dailyVolumes: Array(30).fill(1e6) })])).length, 1);
});

test('fix 1 boundaries: relative volume 50x is allowed, above 50x is excluded', () => {
  assert.equal(ranked(scanOf([mover({ id: 'rv50', volume24h: 100e6, dailyVolumes: Array(30).fill(2e6) })])).length, 1);
  assert.ok(codesOf(scanOf([mover({ id: 'rv51', volume24h: 102e6, dailyVolumes: Array(30).fill(2e6) })]), 'rv51').includes('implausible_data'));
});

test('fix 1: implausible data is a data-quality exclusion, not a low score or a weakness signal', () => {
  const r = scanOf([mover({ id: 'boom', change24hPct: 5000 })]);
  assert.equal(r.belowThreshold.length, 0);
  assert.equal(r.excluded.length, 1);
  assert.match(renderScanReport(r), /implausible data: BOOM/);
});

// Fix 2: volume history is validated, windowed and reported.

test('fix 2: zero-volume days are counted and reported, not silently dropped, and cannot inflate the baseline', () => {
  const zeros = scanOf([mover({ id: 'zeros', dailyVolumes: [...Array(15).fill(0), ...hist(20e6, 15)] })]);
  assert.equal(ranked(zeros).length, 0);
  const codes = codesOf(zeros, 'zeros');
  assert.ok(codes.includes('unreliable_history') && codes.includes('insufficient_history'), codes.join());
  assert.match(zeros.excluded[0]!.reasons.map((x) => x.detail).join(' '), /15 zero-volume/);
  // A few zero days (<= 5) are tolerated; they are excluded from the median and disclosed.
  const few = scanOf([mover({ id: 'few', dailyVolumes: [0, 0, 0, ...hist(20e6, 27)] })]);
  assert.equal(ranked(few).length, 1);
  const a = normalizeDataset({ dataset: SYN, assets: [mover({ id: 'few', dailyVolumes: [0, 0, 0, ...hist(20e6, 27)] })] }).assets[0]!;
  assert.deepEqual([a.history.zeroDays, a.history.invalidEntries, a.dailyVolumes.length], [3, 0, 27]);
  assert.match(ranked(few)[0]!.breakdown[0]!.detail, /3 zero-volume days not used/);
});

test('fix 2: null, text, negative and non-finite entries are counted as invalid', () => {
  const raw = mover({ id: 'junk', dailyVolumes: [...hist(20e6, 25), 'x', null, -5, Number.NaN, Number.POSITIVE_INFINITY] as unknown as number[] });
  const a = normalizeDataset({ dataset: SYN, assets: [raw] }).assets[0]!;
  assert.equal(a.history.invalidEntries, 5);
  assert.equal(a.dailyVolumes.length, 25);
  assert.equal(ranked(scanOf([raw])).length, 1); // 5 unusable days: at the tolerance
  const six = mover({ id: 'junk6', dailyVolumes: [...hist(20e6, 24), 'x', null, -5, Number.NaN, Number.POSITIVE_INFINITY, -1] as unknown as number[] });
  assert.ok(codesOf(scanOf([six]), 'junk6').includes('unreliable_history'));
});

test('fix 2: fewer than 20 valid observations in the window cannot be used for a baseline', () => {
  const r = scanOf([mover({ id: 'thin', dailyVolumes: [...hist(20e6, 19), 0, 0, 0] })]);
  assert.ok(codesOf(r, 'thin').includes('insufficient_history'));
  assert.equal(ranked(r).length, 0);
});

test('fix 2: history longer than 30 days uses only the most recent 30', () => {
  // 335 old days at $1M/day, then 30 recent days at $20M/day: the baseline must reflect the recent window.
  const raw = mover({ id: 'long', dailyVolumes: [...Array(335).fill(1e6), ...hist(20e6, 30)] });
  const a = normalizeDataset({ dataset: SYN, assets: [raw] }).assets[0]!;
  assert.deepEqual([a.history.supplied, a.dailyVolumes.length], [365, 30]);
  const c = ranked(scanOf([raw]))[0]!;
  assert.equal(c.metrics.baselineVolume.value, 20e6);
  assert.equal(c.metrics.relativeVolume.value, 2.5);
});

// Fix 3: duplicates and symbol collisions.

test('fix 3: an identical duplicate is ranked once and the extra copy is recorded', () => {
  const r = scanOf([mover({ id: 'dup' }), mover({ id: 'dup' })]);
  assert.equal(ranked(r).length, 1);
  assert.deepEqual(codesOf(r, 'dup'), ['duplicate_record']);
});

test('fix 3: conflicting duplicates are all excluded, whatever the input order', () => {
  const a = mover({ id: 'dup', change24hPct: 10 });
  const b = mover({ id: 'dup', change24hPct: 25 });
  for (const order of [[a, b], [b, a]]) {
    const r = scanOf(order);
    assert.equal(ranked(r).length, 0);
    assert.deepEqual(codesOf(r, 'dup'), ['duplicate_conflict', 'duplicate_conflict']);
  }
});

test('fix 3: distinct ids sharing a symbol are flagged and identified by id in the report', () => {
  const r = scanOf([mover({ id: 'a1', symbol: 'SAME' }), mover({ id: 'a2', symbol: 'same', change24hPct: 11 })]);
  assert.deepEqual(r.symbolCollisions, [{ symbol: 'SAME', ids: ['a1', 'a2'] }]);
  const report = renderScanReport(r);
  assert.match(report, /Symbol SAME is shared by ids a1, a2/);
  assert.match(report, /\(SAME, id a1\)/);
  assert.match(report, /\(SAME, id a2\)/);
});

test('fix 3: results with duplicates and collisions do not depend on input order', () => {
  // Conflicting duplicates with identical ranking keys (only the name differs) are the case that
  // used to make the listed order follow the input order.
  const set = [mover({ id: 'dup' }), mover({ id: 'dup' }), mover({ id: 'x', change24hPct: 15 }), mover({ id: 'c1', symbol: 'CC' }), mover({ id: 'c2', symbol: 'CC', volume24h: 60e6 }), mover({ id: 'k', name: 'Synthetic K one' }), mover({ id: 'k', name: 'Synthetic K two' })];
  const outputs = new Set<string>();
  for (let s = 0; s < 12; s++) {
    const shuffled = [...set];
    for (let i = shuffled.length - 1; i > 0; i--) { const j = (i * 5 + s * 3) % (i + 1); [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!]; }
    const r = scanOf(shuffled);
    // Compare the full ordered result, not just the report: over-limit lines show symbols only.
    outputs.add(JSON.stringify([ranked(r).map((c) => c.asset.name), r.excluded.map((e) => [e.id, e.name, e.reasons.map((x) => x.code)]), renderScanReport(r)]));
  }
  assert.equal(outputs.size, 1, 'the result must be identical for every input order');
});

// Fix 4: stablecoin filtering.

test('fix 4: a near-$1 asset with no 7-day change and a volume spike is a possible stablecoin, not a watchlist entry', () => {
  const r = scanOf([asset({ id: 'peg', price: 1.0001, change24hPct: 0.05, change7dPct: null, volume24h: 150e6, dailyVolumes: hist(40e6) })]);
  assert.equal(ranked(r).length, 0);
  assert.deepEqual(codesOf(r, 'peg'), ['possible_stablecoin']);
  assert.match(r.excluded[0]!.reasons[0]!.detail, /possible stablecoin/i);
});

test('fix 4: known stablecoins missing from the original list, and known ids, are recognized', () => {
  for (const symbol of ['RLUSD', 'GHO', 'BUSD', 'CRVUSD', 'USD1']) {
    assert.deepEqual(codesOf(scanOf([mover({ id: `s-${symbol}`, symbol, price: 1, change24hPct: 0.1, change7dPct: 0.1 })]), `s-${symbol}`), ['stablecoin'], symbol);
  }
  assert.deepEqual(codesOf(scanOf([mover({ id: 'tether', symbol: 'ZZZ' })]), 'tether'), ['stablecoin']);
});

test('fix 4: liquid-staking, restaking and bridged tags are recognized as wrapped/staked', () => {
  for (const tag of ['liquid-staking', 'liquid-restaking', 'bridged-tokens', 'Liquid Staking Tokens']) {
    assert.ok(codesOf(scanOf([mover({ id: 't', tags: [tag] })]), 't').includes('wrapped_or_staked'), tag);
  }
});

test('fix 4: price near $1 alone is not proof: a moving coin near $1 is ranked, and a not-stablecoin tag overrides the heuristic', () => {
  assert.equal(ranked(scanOf([mover({ id: 'near1', price: 1.01, change24hPct: 12, change7dPct: 14 })])).length, 1);
  const quietSpike = { price: 1.01, change24hPct: 0.4, change7dPct: 0.6, volume24h: 150e6, dailyVolumes: hist(40e6) };
  assert.deepEqual(codesOf(scanOf([asset({ id: 'q', ...quietSpike })]), 'q'), ['possible_stablecoin']);
  const tagged = scanOf([asset({ id: 'q', ...quietSpike, tags: ['not-stablecoin'] })]);
  assert.equal(tagged.watchlist.length, 1);
});

// ---- Final hardening: D1 determinism, D2 exact tags, D3 history window (SYNTHETIC inputs) ------

const permutations = <T>(items: T[], count: number): T[][] => Array.from({ length: count }, (_, k) => {
  const s = [...items];
  for (let i = s.length - 1; i > 0; i--) { const j = (i * 7 + k * 11) % (i + 1); [s[i], s[j]] = [s[j]!, s[i]!]; }
  return s;
});
const fullSignature = (r: ReturnType<typeof scanOf>) => JSON.stringify([
  [r.movers, r.watchlist, r.belowThreshold, r.moversOverLimit, r.watchlistOverLimit].map((l) => l.map((c) => [c.asset.id, c.asset.symbol, c.asset.name, c.score])),
  r.excluded, r.symbolCollisions, renderScanReport(r),
]);

test('D1: records without ids get content-derived labels, independent of input position', () => {
  const malformed = [{ symbol: 'NOID', name: 'Synthetic no id' }, { name: 'Synthetic only a name' }, 42];
  const outputs = new Set(permutations([...malformed, mover({ id: 'ok' })] as RawAsset[], 20).map((p) => fullSignature(scanOf(p))));
  assert.equal(outputs.size, 1, 'ordered results and report must not depend on input order');
  const r = scanOf(malformed as unknown as RawAsset[]);
  for (const e of r.excluded) {
    assert.doesNotMatch(e.id, /#\d/, 'no positional labels');
    assert.match(e.id, /^\(no id\) [0-9a-f]{8}$/);
  }
  assert.equal(new Set(r.excluded.map((e) => e.id)).size, 3, 'different records get different labels');
});

test('D1: indistinguishable malformed records share a label and are each still counted', () => {
  const r = scanOf([{ name: 'Synthetic twin' }, { name: 'Synthetic twin' }] as unknown as RawAsset[]);
  assert.equal(r.universe, 2);
  assert.equal(r.excluded.length, 2);
  assert.equal(r.excluded[0]!.id, r.excluded[1]!.id);
});

test('D1: conflicting duplicates sharing id and name but not symbol are ordered deterministically', () => {
  const pair = [mover({ id: 'z', symbol: 'ZA', name: 'Synthetic Z' }), mover({ id: 'z', symbol: 'ZB', name: 'Synthetic Z' })];
  const outputs = new Set(permutations([...pair, mover({ id: 'other' })], 12).map((p) => fullSignature(scanOf(p))));
  assert.equal(outputs.size, 1);
  assert.deepEqual(scanOf(pair).excluded.map((e) => e.symbol), ['ZA', 'ZB']);
});

test('D2: negated or near-match stablecoin tags are never a definite stablecoin', () => {
  for (const tag of ['non-stablecoin', 'Non Stablecoin', 'stablecoin-adjacent', 'pseudo-stablecoin']) {
    assert.equal(ranked(scanOf([mover({ id: 't', tags: [tag] })])).length, 1, tag);
  }
  // "not stablecoin" is the same tag as "not-stablecoin" once spacing is normalized: an override, not a stablecoin.
  assert.equal(ranked(scanOf([mover({ id: 't', tags: ['not stablecoin'] })])).length, 1);
  const quiet = { price: 1, change24hPct: 0.1, change7dPct: 0.1, volume24h: 150e6, dailyVolumes: hist(40e6) };
  assert.equal(scanOf([asset({ id: 'q', ...quiet, tags: ['Not Stablecoin'] })]).watchlist.length, 1);
  assert.deepEqual(codesOf(scanOf([asset({ id: 'q', ...quiet, tags: ['non-stablecoin'] })]), 'q'), ['possible_stablecoin'], 'non-stablecoin is not an override either');
});

test('D2: recognized stablecoin tags still work, including spacing and case variants', () => {
  for (const tag of ['stablecoin', 'Stablecoins', 'USD Stablecoin', 'algorithmic_stablecoin', 'fiat-backed-stablecoin']) {
    assert.deepEqual(codesOf(scanOf([mover({ id: 't', tags: [tag] })]), 't'), ['stablecoin'], tag);
  }
});

test('D2: wrapped/staked tags match exactly; near-matches do not', () => {
  for (const tag of ['wrapped', 'bridged', 'staked', 'liquid-staking', 'Liquid Staking Tokens', 'restaking', 'liquid-restaking', 'bridged-tokens']) {
    assert.ok(codesOf(scanOf([mover({ id: 't', tags: [tag] })]), 't').includes('wrapped_or_staked'), tag);
  }
  for (const tag of ['unstaked-rewards', 'staking-rewards', 'unwrapped', 'non-bridged', 'staking']) {
    assert.equal(ranked(scanOf([mover({ id: 't', tags: [tag] })])).length, 1, tag);
  }
});

test('D3: the history window comes from the rules passed to normalization', () => {
  // Oldest-first: 10 old days at $1M, then 20 recent days at $20M.
  const raw = mover({ id: 'w', dailyVolumes: [...Array(10).fill(1e6), ...hist(20e6, 20)] });
  const rules20 = { ...SCAN_RULES, historyWindowDays: 20 };
  const a20 = normalizeDataset({ dataset: SYN, assets: [raw] }, rules20).assets[0]!;
  assert.deepEqual([a20.history.windowDays, a20.dailyVolumes.length], [20, 20]);
  const r = runScan(normalizeDataset({ dataset: SYN, assets: [raw] }, rules20), NOW, rules20);
  assert.equal(r.movers[0]!.metrics.baselineVolume.value, 20e6, 'baseline uses only the 20 most recent days');
  const a30 = normalizeDataset({ dataset: SYN, assets: [raw] }).assets[0]!;
  assert.deepEqual([a30.history.windowDays, a30.dailyVolumes.length], [30, 30]);
});

test('D3: scanning with a different history window than normalization fails loudly', () => {
  const data = normalizeDataset({ dataset: SYN, assets: [mover({ id: 'w' })] });
  assert.throws(() => runScan(data, NOW, { ...SCAN_RULES, historyWindowDays: 20 }), /history window/);
});

// ---- P2 S1: live datasets (values below are SYNTHETIC numbers in a live-shaped header) ----------

const LIVE = { kind: 'live', label: 'live-shaped test', source: 'Example provider API', asOf: '2026-10-21T11:58:00Z', attribution: 'Data provided by Example' };

test('S1: live values are tagged as fetched market data with the source; never TEST DATA', () => {
  const { dataset, assets } = normalizeDataset({ dataset: LIVE, assets: [mover({ id: 'l' })] });
  assert.equal(dataset.attribution, 'Data provided by Example');
  const a = assets[0]!;
  for (const e of [a.price, a.change24hPct, a.change7dPct, a.volume24h, a.marketCap, a.lastUpdated]) {
    assert.equal(e.kind, 'verified_market_data');
    assert.equal(e.source, 'Example provider API');
    assert.equal(e.asOf, '2026-10-21T11:57:00.000Z');
  }
});

test('S1: synthetic values stay TEST DATA, never verified market data', () => {
  const a = normalizeDataset(FIXTURE).assets[0]!;
  assert.equal(a.price.kind, 'test_data');
  assert.doesNotMatch(renderScanReport(runScan(normalizeDataset(FIXTURE), NOW)), /VERIFIED DATA|Attribution:|Live data fetched/);
});

test('S1: a live report shows attribution and verified labels, and never the TEST DATA banner', () => {
  const r = runScan(normalizeDataset({ dataset: { ...LIVE, notes: ['History unavailable for 1 asset.'] }, assets: [mover({ id: 'l', symbol: 'LIV', name: 'Live-shaped Coin' })] }), NOW);
  const report = renderScanReport(r);
  assert.doesNotMatch(report, /TEST DATA|synthetic|No live data was fetched/i);
  const lines = report.split('\n');
  assert.equal(lines[1], 'Source: Example provider API');
  assert.equal(lines[2], 'Attribution: Data provided by Example');
  assert.equal(lines[3], 'Snapshot: 2026-10-21 07:58 ET. Live data fetched by this tool; values are as reported by the source.');
  assert.ok(report.includes('Catalyst: NOT VERIFIED | Data: 2026-10-21 07:57 ET (3 min old) [VERIFIED DATA]'), report);
  assert.ok(report.includes('DATA NOTES\n  History unavailable for 1 asset.'), report);
  assert.ok(report.includes('VERIFIED DATA = fetched by this tool from the named source; not independently audited.'), report);
  assert.doesNotMatch(report, /History coverage|PARTIAL/); // no coverage supplied, so none is claimed
});

// ---- Partial history coverage (live only; SYNTHETIC numbers in a live-shaped header) -----------

/** Partial coverage for 3 eligible assets: 1 fetched, 1 failed, 1 not requested. */
const COVERAGE = {
  historyEligible: 3, historyFetched: 1, historyRequestFailed: 1, historyNotRequested: 1, complete: false,
  stopReason: 'the per-run limit of 3 requests was reached', requestsUsed: 3, requestLimit: 3,
};
const failedAsset = (id: string) => asset({ id, dailyVolumes: null, historyStatus: 'request_failed' });
const unrequested = (id: string) => asset({ id, dailyVolumes: null, historyStatus: 'not_requested' });
const liveScan = (assets: RawAsset[], coverage?: unknown) =>
  runScan(normalizeDataset({ dataset: coverage === undefined ? LIVE : { ...LIVE, coverage }, assets }), NOW);

test('coverage: normalization rejects invalid coverage, invalid statuses and live-only metadata on fixture data', () => {
  const assets = [asset({ id: 'f' }), failedAsset('x'), unrequested('y')];
  const norm = (coverage: unknown, list: RawAsset[] = assets) => normalizeDataset({ dataset: { ...LIVE, coverage }, assets: list });
  assert.equal(norm(COVERAGE).dataset.coverage!.historyNotRequested, 1); // valid input is accepted
  // Live-only metadata on fixture data.
  assert.throws(() => normalizeDataset({ dataset: { ...SYN, coverage: COVERAGE }, assets: [] }), /Only a live dataset/);
  assert.throws(() => normalizeDataset({ dataset: SYN, assets: [unrequested('y')] }), /only a live dataset may set "historyStatus"/);
  // Invalid statuses.
  assert.throws(() => normalizeDataset({ dataset: LIVE, assets: [asset({ id: 'z', dailyVolumes: null, historyStatus: 'skipped' as never })] }), /unknown historyStatus "skipped"/);
  assert.throws(() => normalizeDataset({ dataset: LIVE, assets: [asset({ id: 'z', historyStatus: 'not_requested' })] }), /has history data/);
  // Invalid coverage.
  const bad: [Record<string, unknown> | string, RegExp][] = [
    ['all', /must be an object/],
    [{ historyFetched: -1 }, /historyFetched must be a whole number/],
    [{ requestsUsed: 2.5 }, /requestsUsed must be a whole number/],
    [{ historyEligible: 4 }, /historyEligible must equal/],
    [{ complete: true }, /complete must be true exactly when/],
    [{ complete: 'no' }, /complete must be/],
    [{ stopReason: null }, /stopReason must be text/],
    [{ stopReason: '  ' }, /stopReason must be text/],
    [{ requestsUsed: 4 }, /requestsUsed exceeds requestLimit/],
    [{ requestsUsed: 2, requestLimit: 3 }, /lower than the requests the counts imply/],
    [{ requestLimit: 0, requestsUsed: 0 }, /requestLimit must be at least 1/],
  ];
  for (const [change, error] of bad) {
    assert.throws(() => norm(typeof change === 'string' ? change : { ...COVERAGE, ...change }), error, JSON.stringify(change));
  }
  // stopReason must be null when nothing was left unrequested.
  const noneUnrequested = { ...COVERAGE, historyEligible: 2, historyNotRequested: 0 };
  assert.throws(() => norm(noneUnrequested, [asset({ id: 'f' }), failedAsset('x')]), /stopReason must be text when assets were not requested, and null otherwise/);
  assert.equal(norm({ ...noneUnrequested, stopReason: null }, [asset({ id: 'f' }), failedAsset('x')]).dataset.coverage!.stopReason, null);
  // The counts must match the assets that carry each status.
  assert.throws(() => norm(COVERAGE, [asset({ id: 'f' }), failedAsset('x'), failedAsset('y')]), /do not match/);
});

test('coverage: partial, no candidates - the conclusion is limited to the assets actually evaluated', () => {
  const r = liveScan([asset({ id: 'f' }), failedAsset('x'), unrequested('y')], COVERAGE);
  assert.deepEqual(r.excluded.map((e) => [e.id, e.reasons.map((x) => x.code)]), [['x', ['history_request_failed']], ['y', ['history_not_requested']]]);
  const report = renderScanReport(r);
  const flat = report.replace(/\s+/g, ' ');
  assert.ok(flat.includes('History coverage: fetched for 1 of 3 assets that passed the non-history filters; 1 failed; 1 not requested (the per-run limit of 3 requests was reached). PARTIAL SCAN.'), report);
  assert.ok(flat.includes('No candidates met the evidence threshold among the 1 asset whose history was fetched; 2 eligible assets were not evaluated (failed or not requested), so this is not a market-wide result.'), report);
  assert.doesNotMatch(report, /^No candidates met the evidence threshold\.$/m);
  assert.ok(report.includes('  history request failed: X'), report);
  assert.ok(report.includes('  history not requested (request/rate limit): Y'), report);
  assert.doesNotMatch(report, /undefined|too little history/);
  assert.ok(report.split('\n').every((l) => l.length <= 100), report);
});

test('coverage: partial with candidates - the results are labeled as covering only part of the universe', () => {
  const coverage = { ...COVERAGE, historyEligible: 2, historyRequestFailed: 0, requestsUsed: 2 };
  const r = liveScan([mover({ id: 'm' }), unrequested('y')], coverage);
  assert.deepEqual(symbols(r.movers), ['M']);
  const flat = renderScanReport(r).replace(/\s+/g, ' ');
  assert.ok(flat.includes('PARTIAL SCAN: these results cover only the 1 of 2 eligible assets whose history was fetched; 1 was not evaluated. MOVERS'), flat);
});

test('coverage: complete coverage keeps the plain conclusion and says so', () => {
  const coverage = { historyEligible: 1, historyFetched: 1, historyRequestFailed: 0, historyNotRequested: 0, complete: true, stopReason: null, requestsUsed: 2, requestLimit: 160 };
  const report = renderScanReport(liveScan([asset({ id: 'f' })], coverage));
  assert.ok(report.includes('\nHistory coverage: fetched for 1 of 1 assets that passed the non-history filters. Complete.\n'), report);
  assert.ok(report.includes('\nNo candidates met the evidence threshold.\n'), report);
  assert.doesNotMatch(report, /PARTIAL|not a market-wide/);
  // Complete coverage keeps the original universe wording exactly.
  assert.ok(report.includes('\nUniverse: 1 assets; 1 passed filters; 0 excluded.\n'), report);
  assert.doesNotMatch(report, /passed all filters|not evaluated/);
});

test('coverage: a partial universe summary separates not-evaluated assets from filter failures', () => {
  // 5 records: 1 passes every filter, 1 fails a non-history filter, 1 has too little fetched
  // history, 1 history request failed, 1 history not requested. Eligible for history: 4.
  const coverage = { ...COVERAGE, historyEligible: 4, historyFetched: 2, requestsUsed: 4, requestLimit: 4 };
  const r = liveScan([
    asset({ id: 'f' }), asset({ id: 'small', marketCap: 60e6 }), asset({ id: 'short', dailyVolumes: hist(50e6, 10) }), failedAsset('x'), unrequested('y'),
  ], coverage);
  assert.deepEqual(Object.fromEntries(r.excluded.map((e) => [e.id, e.reasons[0]!.code])), {
    short: 'insufficient_history', small: 'below_market_cap', x: 'history_request_failed', y: 'history_not_requested',
  });
  const report = renderScanReport(r);
  const flat = report.replace(/\s+/g, ' ');
  // Both history codes count as not evaluated; a filter failure and a too-short fetched history do not.
  assert.ok(flat.includes(' Universe: 5 assets; 1 passed all filters; 4 excluded (2 not evaluated: history not requested or failed). History coverage:'), report);
  assert.ok(report.split('\n').every((l) => l.length <= 100), report);
  // The parts reconcile: passed + excluded = universe, and not evaluated = failed + not requested.
  assert.equal(r.passedFilters + r.excluded.length, r.universe);
  assert.equal(2, coverage.historyRequestFailed + coverage.historyNotRequested);
});

test('coverage: conflicting duplicates of an unrequested id still count as not evaluated in the universe summary', () => {
  // Anomalous provider output: two records share id "dup" but disagree, and its history was not
  // requested. Duplicate handling excludes both as conflicts before any history rule runs.
  const coverage = { ...COVERAGE, historyEligible: 2, historyRequestFailed: 0, requestsUsed: 2, requestLimit: 2, stopReason: 'the per-run limit of 2 requests was reached' };
  const r = liveScan([asset({ id: 'f' }), unrequested('dup'), { ...unrequested('dup'), name: 'Synthetic dup (other)' }], coverage);
  assert.deepEqual(r.excluded.map((e) => [e.id, e.reasons.map((x) => x.code)]), [['dup', ['duplicate_conflict']], ['dup', ['duplicate_conflict']]]);
  const report = renderScanReport(r);
  const flat = report.replace(/\s+/g, ' ');
  // The Universe line and the coverage line agree on the one asset that was not evaluated.
  assert.ok(flat.includes(' Universe: 3 assets; 1 passed all filters; 2 excluded (1 not evaluated: history not requested or failed). '), report);
  assert.ok(flat.includes('; 0 failed; 1 not requested (the per-run limit of 2 requests was reached). PARTIAL SCAN.'), report);
  assert.ok(report.split('\n').every((l) => l.length <= 100), report);
});

test('coverage: statuses change only the exclusion reason; filtering, scores, ranking and candidates are unchanged', () => {
  const assets = [
    mover({ id: 'm1', change24hPct: 20 }), mover({ id: 'm2' }), asset({ id: 'w1', volume24h: 60e6, dailyVolumes: hist(20e6) }), asset({ id: 'q' }),
    asset({ id: 'small', marketCap: 60e6 }), failedAsset('x'), unrequested('y'), unrequested('z'),
  ];
  const withStatus = liveScan(assets);
  const without = liveScan(assets.map(({ historyStatus: _, ...a }) => a));
  for (const k of ['universe', 'passedFilters', 'notCandidates', 'movers', 'watchlist', 'moversOverLimit', 'watchlistOverLimit', 'belowThreshold', 'symbolCollisions'] as const) {
    assert.equal(JSON.stringify(withStatus[k]), JSON.stringify(without[k]), k);
  }
  assert.deepEqual(withStatus.excluded.map((e) => e.id), without.excluded.map((e) => e.id));
  const codes = (r: typeof withStatus) => Object.fromEntries(r.excluded.map((e) => [e.id, e.reasons.map((x) => x.code).join()]));
  assert.deepEqual(codes(withStatus), { small: 'below_market_cap', x: 'history_request_failed', y: 'history_not_requested', z: 'history_not_requested' });
  assert.deepEqual(codes(without), { small: 'below_market_cap', x: 'insufficient_history', y: 'insufficient_history', z: 'insufficient_history' });
  assert.deepEqual([symbols(withStatus.movers), symbols(withStatus.watchlist)], [['M1', 'M2'], ['W1']]);
});
