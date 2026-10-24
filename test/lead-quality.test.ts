// Research-lead explanations (Phase 1, crypto). Every asset is SYNTHETIC TEST DATA; no network, no
// credentials. The scanner's own runScan produces the leads; the explanation layer only adds text.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runScan } from '../src/scanner/analyze.ts';
import { cryptoRisk } from '../src/scanner/insights.ts';
import { ALIASES, GROUP_ORDER, NEXT_STEP, UNKNOWN_WARNING_TEXT, WARNING_CATALOG, addLeadExplanations, explainLead, leadReason } from '../src/scanner/lead-quality.ts';
import { normalizeDataset } from '../src/scanner/normalize.ts';
import type { DiscoveryEntry, RawAsset } from '../src/scanner/types.ts';
import { runScanCommand } from '../src/scanner/command.ts';

globalThis.fetch = (() => {
  throw new Error('Network access is not allowed in tests.');
}) as typeof fetch;

const NOW = new Date('2026-10-21T12:00:00Z');
const FRESH = '2026-10-21T11:57:00Z';
const stable = (base = 20e6) => Array.from({ length: 30 }, (_, i) => (i % 2 ? base * 1.05 : base * 0.95));
const a = (id: string, over: Partial<RawAsset> = {}): RawAsset => ({
  id, symbol: id.toUpperCase().replace(/-/g, '').slice(0, 6), name: `Test ${id}`, price: 5, change24hPct: 1, change7dPct: 2,
  volume24h: 20e6, marketCap: 1e9, lastUpdated: FRESH, dailyVolumes: stable(), ...over,
});
// Live-kind dataset so the provider's 24h high/low and all-time-high fields are kept as evidence.
const dataset = (assets: RawAsset[]) => normalizeDataset({ dataset: { kind: 'live', label: 'TEST DATA', source: 'test', asOf: FRESH, attribution: 'test' }, assets });
const scan = (assets: RawAsset[]) => {
  const data = dataset(assets);
  const result = runScan(data, NOW);
  return { data, result, explained: addLeadExplanations(result, data) };
};
const leads = (d: { highPriority: DiscoveryEntry[]; watchlist: DiscoveryEntry[]; insufficientData: DiscoveryEntry[] }) => [...d.highPriority, ...d.watchlist, ...d.insufficientData];
const find = (x: ReturnType<typeof scan>, id: string) => leads(x.explained.discovery).find((e) => e.id === id) as DiscoveryEntry & { explanation: ReturnType<typeof explainLead> };
const codes = (e: { explanation: ReturnType<typeof explainLead> }) => e.explanation.warnings.map((w) => w.code);

const CASES: RawAsset[] = [
  // A strong mover that has fallen far from its 24h high: tier stays high priority, but the drop must be warned about.
  a('crashing', { price: 5, change24hPct: 12, change7dPct: 15, volume24h: 60e6, high24h: 10, low24h: 4, athChangePct: -95 }),
  a('calm-mover', { price: 5, change24hPct: 12, change7dPct: 15, volume24h: 60e6, high24h: 5.2, low24h: 4.4, athChangePct: -20 }),
  // Several warnings across all three groups on one lead (watch candidate, variable baseline, extreme range).
  a('noisy-watch', { price: 5, change24hPct: 1, volume24h: 60e6, high24h: 8, low24h: 4.5, dailyVolumes: Array.from({ length: 30 }, (_, i) => (i % 2 ? 40e6 : 2e6)) }),
  // Not evaluated: stale data that also swings hard; data quality must come first.
  a('stale-swing', { price: 5, change24hPct: 15, volume24h: 60e6, lastUpdated: '2026-10-21T09:00:00Z', high24h: 9, low24h: 4.5 }),
  // Not evaluated: missing volume, no high/low or ATH at all.
  a('missing-bits', { change24hPct: 20, volume24h: null }),
  a('quiet'),
];

// ---- warning priority --------------------------------------------------------------------------

test('warnings are ordered data quality, then volatility, then weaker evidence', () => {
  const x = scan(CASES);
  const noisy = find(x, 'noisy-watch');
  assert.equal(noisy.tier, 'watchlist');
  assert.deepEqual(noisy.explanation.warnings.map((w) => [w.group, w.code]), [
    ['data_quality', 'baseline_variable'], // the scanner caveat and cryptoRisk's flag are one fact: shown once
    ['volatility', 'far_below_24h_high'], // price 5 vs 24h high 8: 37.5% below (threshold 20%)
    ['volatility', 'extreme_range_24h'],
    ['evidence', 'one_signal'],
  ]);
  const ranks = noisy.explanation.warnings.map((w) => GROUP_ORDER.indexOf(w.group));
  assert.deepEqual(ranks, [...ranks].sort((p, q) => p - q));
  const stale = find(x, 'stale-swing');
  assert.equal(stale.tier, 'insufficient_data');
  assert.deepEqual(codes(stale), ['stale_data', 'far_below_24h_high', 'extreme_range_24h']); // data quality before volatility (price 5 vs high 9: 44% below)
  assert.equal(stale.explanation.nextStep, null);
});

test('the existing volatility flags reach the lead: a strong mover far below its 24h high is warned about', () => {
  const x = scan(CASES);
  const crash = find(x, 'crashing');
  assert.equal(crash.tier, 'high_priority'); // the tier is unchanged by the explanation
  assert.deepEqual(codes(crash), ['far_below_24h_high', 'extreme_range_24h', 'far_below_ath']);
  assert.deepEqual(crash.explanation.warnings.map((w) => w.text), [
    'It is now 50% below its 24-hour high; the 24-hour change alone hides this drop.',
    'The price swung 150% between its 24-hour low and high.',
    'It is 95% below its all-time high (provider figure).',
  ]);
  assert.equal(crash.explanation.nextStep, null);
  // The same flags as the dashboard's "Volatility & data" column: one source of truth (insights.cryptoRisk).
  const risk = cryptoRisk(x.data.assets.find((s) => s.id === 'crashing')!, NOW);
  assert.deepEqual(risk.flagCodes, ['extreme_range_24h', 'far_below_24h_high', 'far_below_ath']);
  assert.equal(risk.flags.length, risk.flagCodes.length);
  // A calm mover with no warnings gets the next step instead.
  const calm = find(x, 'calm-mover');
  assert.deepEqual([calm.tier, calm.explanation.warnings, calm.explanation.nextStep], ['high_priority', [], NEXT_STEP]);
});

test('missing or stale data: reported as data problems; no volatility warning is invented without its numbers', () => {
  const x = scan(CASES);
  const m = find(x, 'missing-bits');
  assert.deepEqual(codes(m), ['missing_data']); // no high/low, no ATH: no volatility claim either way
  assert.equal(m.explanation.reason, 'Unusual activity (price moved +20.0% in 24 hours), but not enough reliable data to judge.');
  assert.equal(find(x, 'stale-swing').explanation.warnings[0]!.text, 'Its market data is out of date.');
  // A volatility code whose number is unavailable is dropped, never worded without its evidence.
  const e = find(x, 'calm-mover');
  const noRisk = explainLead({ ...e, caveatCodes: [] }, { ...cryptoRisk(x.data.assets.find((s) => s.id === 'calm-mover')!, NOW), flagCodes: ['far_below_24h_high'], fromHigh24hPct: null });
  assert.deepEqual(noRisk.warnings, []);
  // No snapshot at all (risk null): only the scanner's own caveats are used.
  assert.deepEqual(explainLead({ ...e, caveatCodes: ['stale_data'] }, null).warnings.map((w) => w.code), ['stale_data']);
});

// ---- wording coverage ----------------------------------------------------------------------------

test('complete wording coverage: every code the scanner or the volatility flags can emit has a sentence', () => {
  const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const analyze = src('../src/scanner/analyze.ts');
  const insights = src('../src/scanner/insights.ts');
  const emitted = new Set<string>([
    ...[...analyze.matchAll(/codes\.(?:push|unshift)\('([a-z_0-9]+)'\)/g)].map((m) => m[1]!),
    ...[...analyze.matchAll(/\['(below_threshold|no_volume_confirmation)'/g)].map((m) => m[1]!),
    ...[...analyze.slice(analyze.indexOf('const DATA_GAP_CODES'), analyze.indexOf(']);', analyze.indexOf('const DATA_GAP_CODES'))).matchAll(/'([a-z_0-9]+)'/g)].map((m) => m[1]!),
    ...[...insights.matchAll(/flag\('([a-z_0-9]+)'/g)].map((m) => m[1]!),
  ]);
  assert.ok(emitted.size >= 18, `found ${emitted.size} codes`); // guards against the source scan silently finding nothing
  for (const code of emitted) assert.ok(Object.hasOwn(WARNING_CATALOG, ALIASES[code] ?? code), `no wording for "${code}"`);
  // Every sentence is non-empty with its numbers present, and none uses recommendation language.
  const risk = { fromHigh24hPct: -50, range24hPct: 150, athChangePct: -95 } as never;
  for (const [code, w] of Object.entries(WARNING_CATALOG)) {
    const text = w.text({ e: {} as DiscoveryEntry, risk });
    assert.ok(text && text.length > 10, code);
    assert.doesNotMatch(text!, /\b(buy|sell|opportunit|profit|guarantee)/i, code);
  }
  // An unknown future code is shown with a pointer to the scanner notes, never silently dropped.
  const e = { tier: 'watchlist', kind: null, caveatCodes: ['brand_new_code'], activity: [], change24hPct: null, change7dPct: null, volumeMultiple: null } as unknown as DiscoveryEntry;
  assert.deepEqual(explainLead(e, null).warnings, [{ code: 'brand_new_code', group: 'evidence', text: UNKNOWN_WARNING_TEXT }]);
});

test('reasons: plain, from the lead\'s own values, no recommendation language', () => {
  const x = scan(CASES);
  assert.equal(find(x, 'crashing').explanation.reason, 'The price moved +12.0% in 24 hours and trading activity is unusually high (about 3.0× its usual level).');
  assert.match(find(x, 'noisy-watch').explanation.reason, /^Trading activity is unusually high \(about 2\.9× its usual level\), but the price has barely moved\.$/);
  const all = leads(x.explained.discovery).map((e) => `${(e as never as { explanation: { reason: string } }).explanation.reason}`).join(' ');
  assert.doesNotMatch(all, /\b(buy|sell|opportunit|profit|guarantee)/i);
  const priceOnly = { tier: 'watchlist', kind: null, activity: [{ code: 'large_24h_move', detail: '' }], change24hPct: 40, change7dPct: null, volumeMultiple: 1, caveatCodes: [] } as unknown as DiscoveryEntry;
  assert.equal(leadReason(priceOnly), 'Price is moving (price moved +40.0% in 24 hours), but trading activity is normal.');
});

// ---- nothing else changes --------------------------------------------------------------------------

test('unchanged rankings: tiers, order, scores and every other field are identical; the input is not mutated', () => {
  const { result, explained } = scan(CASES);
  const before = JSON.stringify(result);
  const strip = (r: typeof explained) => JSON.parse(JSON.stringify(r, (k, v) => (k === 'explanation' ? undefined : v)));
  assert.deepEqual(strip(explained), JSON.parse(before));
  assert.equal(JSON.stringify(result), before); // the original result was not modified
  for (const tier of ['highPriority', 'watchlist', 'insufficientData'] as const) {
    assert.deepEqual(explained.discovery[tier].map((e) => [e.id, e.score, e.status]), result.discovery[tier].map((e) => [e.id, e.score, e.status]));
  }
  // Equal score, volume multiple and volume: the scanner's existing tie-break (id) decides, as before.
  assert.deepEqual(result.movers.map((c) => c.asset.id), ['calm-mover', 'crashing']);
  assert.deepEqual(explained.movers.map((c) => c.asset.id), ['calm-mover', 'crashing']);
});

test('crypto JSON carries the explanation; the text report is byte-identical with or without it', async () => {
  const out: string[] = [];
  const deps = { env: {}, fetch: async () => { throw new Error('no fetch'); }, clock: () => NOW, sleep: async () => {} };
  assert.equal(await runScanCommand(['crypto', '--json'], { ...deps, out: (t) => out.push(t), err: () => {} }), 0);
  const json = JSON.parse(out.join('\n'));
  const all = leads(json.discovery) as unknown as { id: string; explanation: { reason: string; warnings: unknown[]; nextStep: string | null } }[];
  assert.ok(all.length > 0);
  for (const e of all) {
    assert.ok(e.explanation.reason.length > 0, e.id);
    assert.ok(e.explanation.warnings.length > 0 || e.explanation.nextStep === NEXT_STEP, e.id); // always a warning or an explicit next step
  }
  const text: string[] = [];
  assert.equal(await runScanCommand(['crypto'], { ...deps, out: (t) => text.push(t), err: () => {} }), 0);
  assert.doesNotMatch(text.join('\n'), /Next step: check the news|Caution:|explanation/);
});
