// Dashboard extension: budget filters, crypto classification and volatility risk.
// Every asset below is SYNTHETIC TEST DATA (invented ids, names and numbers), not market data.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyCrypto, cryptoRisk } from '../src/scanner/insights.ts';
import { normalizeDataset } from '../src/scanner/normalize.ts';
import type { RawAsset } from '../src/scanner/types.ts';
import { WEB_HOST, createScanService, handleRequest } from '../src/web/server.ts';
import { affordability, buildView, maxWholeUnits, parseBudgetControls } from '../src/web/public/budget.js';
import type { DashboardRow } from '../src/web/rows.ts';

globalThis.fetch = (() => {
  throw new Error('Network access is not allowed in tests.');
}) as typeof fetch;

const NOW = new Date('2026-10-21T12:00:00Z');
const steady = Array.from({ length: 30 }, () => 20e6);

/** One synthetic asset through the real normalizer (live kind, so market extras are tagged as provider data). */
function asset(over: Partial<RawAsset> & { id: string }, kind: 'live' | 'synthetic' = 'live') {
  const raw: RawAsset = {
    symbol: over.id.toUpperCase().slice(0, 6), name: `Test ${over.id}`, price: 5, change24hPct: 1, change7dPct: 2,
    volume24h: 30e6, marketCap: 1e9, lastUpdated: '2026-10-21T11:50:00Z', dailyVolumes: steady, ...over,
  };
  const data = normalizeDataset({
    dataset: { kind, label: 'TEST DATA', source: 'test', asOf: '2026-10-21T11:55:00Z', ...(kind === 'live' ? { attribution: 'test attribution' } : {}) },
    assets: [raw],
  });
  assert.equal(data.assets.length, 1, JSON.stringify(data.invalid));
  return data.assets[0]!;
}

// ---- budget and unit-price filters ----------------------------------------------------------------

test('whole units: floor(budget / price), robust to floating-point rounding, never fractional', () => {
  assert.equal(maxWholeUnits(0.3, 0.1), 3); // 0.3 / 0.1 = 2.9999999999999996 in floating point
  assert.equal(maxWholeUnits(1000, 333.34), 2);
  assert.equal(maxWholeUnits(1000, 1000), 1);
  assert.equal(maxWholeUnits(999.99, 1000), 0);
  assert.equal(maxWholeUnits(100, 0.00001234), 8103727);
  for (const bad of [[0, 1], [100, 0], [100, -1], [Number.NaN, 1], [100, Number.POSITIVE_INFINITY]]) assert.equal(maxWholeUnits(bad[0]!, bad[1]!), 0);
});

test('budget and unit-price limit are separate checks, each with a reason', () => {
  assert.deepEqual(affordability(250, 1000, 300), { maxUnits: 4, totalCost: 1000, passesBudget: true, passesUnitPrice: true, reason: null });
  const pricey = affordability(250, 1000, 100); // fits the budget, fails the unit-price limit
  assert.equal(pricey.passesBudget, true);
  assert.equal(pricey.passesUnitPrice, false);
  assert.equal(pricey.reason, 'unit price is above the limit');
  const tooBig = affordability(1500, 1000, null); // no unit-price limit, one unit exceeds the budget
  assert.deepEqual([tooBig.maxUnits, tooBig.totalCost, tooBig.passesBudget, tooBig.passesUnitPrice], [0, 0, false, true]);
  assert.match(tooBig.reason!, /one whole unit costs more than the budget/);
  const unknown = affordability(null, 1000, null);
  assert.deepEqual([unknown.passesBudget, unknown.totalCost, unknown.reason], [false, null, 'unit price not available']);
});

test('budget controls are validated', () => {
  assert.deepEqual(parseBudgetControls('500', '20', false, 'both'), { budget: 500, maxUnitPrice: 20, preference: 'both' });
  assert.deepEqual(parseBudgetControls('500', 'ignored', true, 'signals'), { budget: 500, maxUnitPrice: null, preference: 'signals' });
  for (const [b, u, n, p] of [['0', '1', false, 'both'], ['-5', '1', false, 'both'], ['abc', '1', false, 'both'], ['100', '0', false, 'both'], ['100', '', false, 'both'], ['100', '1', false, 'cheapest']] as const) {
    assert.ok('error' in parseBudgetControls(b, u, n, p), `${b} ${u} ${p}`);
  }
});

const row = (key: string, unitPrice: number | null, status: DashboardRow['signal']['status']) => ({ key, unitPrice, signal: { status } }) as DashboardRow;

test('views per preference: scanner order kept, never sorted by price, qualified-outside kept visible', () => {
  // Scanner order: two qualified, one over the display limit, two without a signal.
  const rows = [row('q-pricey', 900, 'qualified'), row('q-cheap', 2, 'qualified'), row('q-over', 5, 'over_display_limit'), row('n-cheap', 0.5, 'no_pattern'), row('b-none', null, 'below_threshold')];
  const keys = (v: ReturnType<typeof buildView>) => v.sections.map((s) => [s.title.split(' ')[0], s.rows.map((x) => x.row.key)]);
  const ctl = { budget: 100, maxUnitPrice: 10 };
  assert.deepEqual(keys(buildView(rows, { ...ctl, preference: 'signals' })), [['Qualified', ['q-cheap', 'q-over']], ['Qualified', ['q-pricey']]]);
  assert.deepEqual(keys(buildView(rows, { ...ctl, preference: 'affordable' })), [['Evaluated', ['q-cheap', 'q-over', 'n-cheap']]]);
  const both = buildView(rows, { ...ctl, preference: 'both' });
  assert.deepEqual(keys(both), [['Qualified', ['q-cheap', 'q-over']], ['Other', ['n-cheap']], ['Qualified', ['q-pricey']]]);
  assert.equal(both.sections.at(-1)!.collapsed, true);
  assert.deepEqual(both.counts, { evaluated: 5, withinBudget: 3, qualified: 3, qualifiedWithinBudget: 2 });
  // Raising the unit-price limit admits the expensive asset in its scanner position (first), not by price.
  assert.deepEqual(keys(buildView(rows, { budget: 1000, maxUnitPrice: null, preference: 'affordable' })), [['Evaluated', ['q-pricey', 'q-cheap', 'q-over', 'n-cheap']]]);
});

// ---- classification ---------------------------------------------------------------------------------

test('classification: curated lists decide first, with the source stated', () => {
  const usdt = classifyCrypto(asset({ id: 'tether', symbol: 'usdt', price: 1, change24hPct: 0, change7dPct: 0, marketCapRank: 3 }));
  assert.equal(usdt.category, 'stablecoin');
  assert.equal(usdt.basis, 'curated_list');
  assert.ok(usdt.evidence.some((e) => /curated stablecoin list/.test(e)));
  assert.ok(usdt.evidence.some((e) => /rank 3/.test(e))); // all evidence is kept, even when it did not decide
  const wrapped = classifyCrypto(asset({ id: 'test-wrapped', symbol: 'wbtc', price: 60000, marketCapRank: 15 }));
  assert.deepEqual([wrapped.category, wrapped.basis], ['wrapped_staked', 'curated_list']); // curated beats the rank heuristic
  const tagged = classifyCrypto(asset({ id: 'test-lst', symbol: 'tlst', tags: ['liquid-staking'] }));
  assert.deepEqual([tagged.category, tagged.basis], ['wrapped_staked', 'curated_list']);
});

test('classification: heuristics are labelled as heuristics; "established" means size only', () => {
  const big = classifyCrypto(asset({ id: 'test-big', symbol: 'tbig', marketCapRank: 7 }));
  assert.deepEqual([big.category, big.basis], ['established', 'heuristic']);
  assert.match(big.evidence[0]!, /size, not legitimacy or safety/);
  const pegged = classifyCrypto(asset({ id: 'test-peg', symbol: 'tpeg', price: 1.001, change24hPct: 0.05, change7dPct: 0.1 }));
  assert.deepEqual([pegged.category, pegged.basis], ['stablecoin', 'heuristic']);
  const optOut = classifyCrypto(asset({ id: 'test-peg2', symbol: 'tpg2', price: 1.001, change24hPct: 0.05, change7dPct: 0.1, tags: ['not-stablecoin'] }));
  assert.equal(optOut.category, 'unknown');
  assert.equal(classifyCrypto(asset({ id: 'test-small', symbol: 'tsml', marketCapRank: 21 })).category, 'unknown');
});

test('classification: contradictory evidence, a name alone, or missing metadata give Unknown', () => {
  // Pegged pattern AND top-20 rank: two heuristics disagree.
  const contra = classifyCrypto(asset({ id: 'test-contra', symbol: 'tcon', price: 1, change24hPct: 0, change7dPct: 0, marketCapRank: 4 }));
  assert.deepEqual([contra.category, contra.basis], ['unknown', 'none']);
  assert.match(contra.note!, /contradictory heuristic evidence \(Stablecoin vs Established/);
  // Curated stablecoin symbol AND curated wrapped tag: curated evidence disagrees.
  const contraCurated = classifyCrypto(asset({ id: 'test-cc', symbol: 'usdc', price: 1, tags: ['wrapped'] }));
  assert.match(contraCurated.note!, /contradictory curated evidence/);
  // The name says "Wrapped", nothing else does: noted, not used.
  const named = classifyCrypto(asset({ id: 'test-named', symbol: 'tnam', name: 'Wrapped Test Coin', price: 3 }));
  assert.equal(named.category, 'unknown');
  assert.match(named.note!, /a name alone is not used/);
  // A meme-sounding name and a wild move never make a "meme" label: no provider category data exists.
  const memeish = classifyCrypto(asset({ id: 'test-doge-moon', symbol: 'tmoon', name: 'Test Moon Inu', price: 0.00001, change24hPct: 250 }));
  assert.equal(memeish.category, 'unknown');
  assert.match(memeish.note!, /no provider category or curated evidence/);
  // No market extras at all (offline fixture shape): Unknown, and no crash.
  const bare = asset({ id: 'test-bare', symbol: 'tbar' });
  assert.equal(bare.market, undefined);
  assert.equal(classifyCrypto(bare).category, 'unknown');
});

test('classification is a label only: the existing exclusion filters are unchanged', async () => {
  // The offline fixture result is identical with or without the dashboard; spot-check via the web API.
  const svc = createScanService({ env: {}, fetch: async () => { throw new Error('no fetch'); }, clock: () => NOW, sleep: async () => {} }, 160);
  const r = await handleRequest({ method: 'POST', url: '/api/scan/crypto', headers: { host: `${WEB_HOST}:4173`, 'content-type': 'application/json', 'x-market-scanner': '1' }, body: '{"mode":"offline"}' }, svc, {}, 4173);
  const data = JSON.parse(r.body);
  const excludedIds = new Set(data.result.excluded.map((e: { id: string }) => e.id));
  for (const row of data.rows) assert.ok(!excludedIds.has(row.id), `${row.id} is both excluded and shown as evaluated`);
  assert.equal(data.rows.length, data.result.passedFilters); // every evaluated asset, nothing more
});

// ---- volatility risk ------------------------------------------------------------------------------

test('extreme 24h swing: range, drop from high and ATH drawdown are calculated and flagged', () => {
  // Pump and dump inside 24h: low 0.010, high 0.030, now 0.015; 95% below its all-time high.
  const a = asset({ id: 'test-pump', symbol: 'tpmp', price: 0.015, change24hPct: 20, high24h: 0.03, low24h: 0.01, athChangePct: -95, athDate: '2025-01-02T00:00:00Z' });
  const r = cryptoRisk(a, NOW);
  const near = (x: number | null, y: number) => assert.ok(x !== null && Math.abs(x - y) < 1e-9, `${x} vs ${y}`);
  near(r.range24hPct, 200);
  near(r.fromHigh24hPct, -50);
  near(r.fromLow24hPct, 50);
  assert.equal(r.athChangePct, -95);
  assert.equal(r.athDate, '2025-01-02T00:00:00.000Z');
  assert.equal(r.dataAgeMinutes, 10);
  near(r.turnoverPct, 3);
  assert.equal(r.flags.length, 3);
  assert.match(r.flags[0]!, /Extreme 24h swing.*200%/);
  assert.match(r.flags[1]!, /50% below its 24h high: the 24h change alone hides this drop/);
  assert.match(r.flags[2]!, /95% below its all-time high/);
  assert.match(r.period, /rolling 24h window/);
  assert.ok(r.unavailable.some((u) => /bid\/ask spread/.test(u)));
});

test('calm asset: measures present, no flags', () => {
  const r = cryptoRisk(asset({ id: 'test-calm', symbol: 'tclm', price: 5, high24h: 5.1, low24h: 4.95, athChangePct: -10 }), NOW);
  assert.deepEqual(r.flags, []);
  assert.ok(Math.abs(r.range24hPct! - 3.0303) < 1e-3);
});

test('missing or inconsistent provider data is reported as unavailable, never guessed', () => {
  const none = cryptoRisk(asset({ id: 'test-none', symbol: 'tnon' }), NOW);
  assert.deepEqual([none.range24hPct, none.fromHigh24hPct, none.athChangePct, none.athDate], [null, null, null, null]);
  assert.ok(none.unavailable.some((u) => /did not provide a usable 24h high and low/.test(u)));
  assert.ok(none.unavailable.some((u) => /all-time high: not provided/.test(u)));
  // Price above its own 24h high (snapshots taken at different times): not computed.
  const off = cryptoRisk(asset({ id: 'test-off', symbol: 'toff', price: 5, high24h: 4, low24h: 3 }), NOW);
  assert.equal(off.range24hPct, null);
  assert.ok(off.unavailable.some((u) => /outside its own 24h low/.test(u)));
  // Invalid provider values are rejected by the normalizer (rank 0, negative low, ATH change above 0 beyond tolerance, bad date).
  const bad = asset({ id: 'test-bad', symbol: 'tbad', marketCapRank: 0, low24h: -1, high24h: 6, athChangePct: 40, athDate: 'yesterday' });
  for (const k of ['rank', 'low24h', 'athChangePct', 'athDate'] as const) assert.equal(bad.market![k].kind, 'missing', k);
  assert.equal(bad.market!.high24h.kind, 'verified_market_data');
  assert.equal(cryptoRisk(bad, NOW).range24hPct, null);
  // Too few valid daily volumes: variability is unavailable, not assumed stable.
  const thin = cryptoRisk(asset({ id: 'test-thin', symbol: 'tthn', dailyVolumes: [1e6, 2e6] }), NOW);
  assert.ok(thin.unavailable.some((u) => /volume-baseline variability: only 2 valid/.test(u)));
});

test('a highly variable volume baseline is flagged', () => {
  const vols = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? 1e6 : 50e6));
  const r = cryptoRisk(asset({ id: 'test-var', symbol: 'tvar', dailyVolumes: vols }), NOW);
  assert.ok(r.flags.some((f) => /Highly variable volume baseline/.test(f)));
});

test('synthetic market extras stay labelled as test data', () => {
  const a = asset({ id: 'test-fx', symbol: 'tfx', high24h: 6, low24h: 4, marketCapRank: 2 }, 'synthetic');
  assert.equal(a.market!.high24h.kind, 'test_data');
  assert.equal(a.market!.rank.kind, 'test_data');
});

// ---- rows through the web API (offline fixtures, zero requests) -------------------------------------

test('both markets return rows with unit price, timestamp, signal and risk; stocks have no category', async () => {
  let calls = 0;
  const svc = createScanService({ env: {}, fetch: async () => { calls++; throw new Error('no fetch'); }, clock: () => NOW, sleep: async () => {} }, 160);
  const post = (url: string) => handleRequest({ method: 'POST', url, headers: { host: `${WEB_HOST}:4173`, 'content-type': 'application/json', 'x-market-scanner': '1' }, body: '{"mode":"offline"}' }, svc, {}, 4173);
  const crypto = JSON.parse((await post('/api/scan/crypto')).body);
  assert.equal(crypto.market, 'crypto');
  assert.deepEqual(crypto.rows.filter((r: DashboardRow) => r.signal.status === 'qualified').map((r: DashboardRow) => r.symbol), crypto.result.scan.qualifiedNames);
  for (const r of crypto.rows as DashboardRow[]) {
    assert.equal(r.dataKind, 'test_data');
    assert.ok(r.unitPrice! > 0 && r.priceAsOf, r.key);
    assert.ok(r.classification, r.key);
    assert.ok(r.risk.unavailable.length > 0, r.key);
  }
  assert.ok(crypto.limitations.some((l: string) => /meme-coin/i.test(l)));

  const stocks = JSON.parse((await post('/api/scan/stocks')).body);
  assert.equal(stocks.market, 'stocks');
  assert.equal(stocks.rows.length, stocks.result.passedFilters);
  for (const r of stocks.rows as DashboardRow[]) {
    assert.equal(r.classification, null);
    assert.match(r.priceAsOf!, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(r.priceBasis, /end of day, not a live quote/);
  }
  assert.equal(stocks.exclusionLabels !== crypto.exclusionLabels, true);
  assert.equal(calls, 0);
});

test('dashboard rows: evaluated assets appear exactly once, in scanner order', async () => {
  const svc = createScanService({ env: {}, fetch: async () => { throw new Error('no fetch'); }, clock: () => NOW, sleep: async () => {} }, 160);
  const r = await handleRequest({ method: 'POST', url: '/api/scan/crypto', headers: { host: `${WEB_HOST}:4173`, 'content-type': 'application/json', 'x-market-scanner': '1' }, body: '{"mode":"offline"}' }, svc, {}, 4173);
  const rows = JSON.parse(r.body).rows as DashboardRow[];
  assert.equal(new Set(rows.map((x) => x.key)).size, rows.length);
  assert.deepEqual(rows.map((x) => x.signal.order), rows.map((_, i) => i));
  const rank = { qualified: 0, over_display_limit: 1, below_threshold: 2, no_pattern: 3 };
  for (let i = 1; i < rows.length; i++) assert.ok(rank[rows[i - 1]!.signal.status] <= rank[rows[i]!.signal.status]);
});
