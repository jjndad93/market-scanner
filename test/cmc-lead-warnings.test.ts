// Phase 2: CoinMarketCap cross-check warnings on the matching research lead. Every coin is SYNTHETIC
// TEST DATA; CoinMarketCap is never called (fixture and in-memory records only).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { type CmcRecord, parseCmcListings } from '../src/providers/coinmarketcap.ts';
import { CROSS_CHECK_TOLERANCE, CROSS_CHECK_WARNING_TEXT, crossCheckLead, crossCheckLeads } from '../src/scanner/cross-check.ts';
import type { Discovery, DiscoveryEntry } from '../src/scanner/types.ts';
import { WEB_HOST, createScanService, handleRequest } from '../src/web/server.ts';
import { leadCrossCheckWarnings } from '../src/web/public/simple-view.js';

globalThis.fetch = (() => {
  throw new Error('Network access is not allowed in tests.');
}) as typeof fetch;

const NOW = new Date('2026-10-21T12:00:00Z');
const HEADERS = { host: `${WEB_HOST}:4173`, 'content-type': 'application/json', 'x-market-scanner': '1' };
const RECORDS = parseCmcListings(JSON.parse(readFileSync(new URL('./fixtures/cmc-listings.synthetic.json', import.meta.url), 'utf8'))).records;
const lead = (over: Partial<DiscoveryEntry> & { id: string; symbol: string; name: string }): DiscoveryEntry => ({
  tier: 'high_priority', status: 'shortlisted', kind: 'mover', score: 6, maxScore: 8, reasons: [], caveats: [], caveatCodes: [], activity: [],
  change24hPct: 10, change7dPct: 5, volumeMultiple: 3, price: 1, marketCap: 1e9, lastUpdated: '2026-10-21T11:57:00.000Z', ...over,
});
const rec = (over: Partial<CmcRecord> & { id: number; symbol: string; name: string }): CmcRecord => ({ slug: null, rank: 50, price: 1, marketCap: 1e9, volume24h: 1e7, change24hPct: 1, lastUpdated: '2026-10-21T11:57:00.000Z', tags: [], ...over });
const codes = (l: DiscoveryEntry, records: CmcRecord[]) => crossCheckLead(l, records).warnings.map((w) => w.code);

async function offline() {
  const svc = createScanService({ env: {}, fetch: async () => { throw new Error('no fetch'); }, clock: () => NOW, sleep: async () => {} }, 160);
  const scan = JSON.parse((await handleRequest({ method: 'POST', url: '/api/scan/crypto', headers: HEADERS, body: '{"mode":"offline"}' }, svc, {}, 4173)).body);
  const cmc = JSON.parse((await handleRequest({ method: 'POST', url: '/api/crypto/cmc-check', headers: HEADERS, body: '{}' }, svc, {}, 4173)).body);
  return { scan, cmc };
}

// ---- warnings from the existing verdicts ----------------------------------------------------------

test('each kind of warning comes only from the existing verdicts and tolerances', async () => {
  const { scan, cmc } = await offline();
  const d: Discovery = scan.result.discovery;
  const byId = (id: string) => leadCrossCheckWarnings([...d.highPriority, ...d.watchlist, ...d.insufficientData].find((e) => e.id === id), cmc, scan.result.evaluatedAt).map((w: { code: string }) => w.code);
  assert.deepEqual(byId('syn-alpha'), []); // price and market cap agree: no disagreement warning
  assert.deepEqual(byId('syn-charlie'), []); // matched by slug, values agree
  assert.deepEqual(byId('syn-bravo'), ['cmc_price_differs']); // price 5.2% apart; market cap within 10%
  assert.deepEqual(byId('syn-echo'), ['cmc_uncertain_match']); // same symbol, different name
  assert.deepEqual(byId('syn-delta'), ['cmc_uncertain_match']); // two CMC coins share symbol and name
  assert.deepEqual(byId('syn-stale'), ['cmc_value_missing', 'cmc_snapshots_far_apart']); // CMC market cap missing; CoinGecko data from 08:50 vs CMC 11:57
  assert.deepEqual(byId('syn-gap'), ['cmc_snapshots_far_apart']); // snapshots 40 minutes apart
  assert.deepEqual(byId('syn-newcoin'), ['cmc_not_listed']);
  assert.equal(cmc.results.find((x: { id: string }) => x.id === 'syn-stale').warnings[0].text, 'The sources could not be compared because data is missing (market cap).');
  assert.equal(cmc.results.find((x: { id: string }) => x.id === 'syn-bravo').warnings[0].text, 'CoinMarketCap and CoinGecko show different prices.');
});

test('market-cap disagreement, both disagreements, missing values on either side, in a fixed order', () => {
  const l = lead({ id: 'test-a', symbol: 'TA', name: 'Test A', price: 1, marketCap: 1e9 });
  assert.deepEqual(codes(l, [rec({ id: 1, symbol: 'TA', name: 'Test A', marketCap: 1.2e9 })]), ['cmc_market_cap_differs']);
  assert.equal(crossCheckLead(l, [rec({ id: 1, symbol: 'TA', name: 'Test A', marketCap: 1.2e9 })]).warnings[0]!.text, 'The reported market values differ between the two sources.');
  assert.deepEqual(codes(l, [rec({ id: 1, symbol: 'TA', name: 'Test A', price: 1.5, marketCap: 1.5e9, lastUpdated: '2026-10-21T10:00:00.000Z' })]),
    ['cmc_price_differs', 'cmc_market_cap_differs', 'cmc_snapshots_far_apart']);
  // Missing on the CoinGecko side, or both values missing: "could not be compared", never agreement.
  assert.deepEqual(crossCheckLead(lead({ id: 'test-a', symbol: 'TA', name: 'Test A', price: null }), [rec({ id: 1, symbol: 'TA', name: 'Test A' })]).warnings,
    [{ code: 'cmc_value_missing', text: 'The sources could not be compared because data is missing (price).' }]);
  assert.deepEqual(crossCheckLead(l, [rec({ id: 1, symbol: 'TA', name: 'Test A', price: null, marketCap: null })]).warnings.map((w) => w.text),
    ['The sources could not be compared because data is missing (price and market cap).']);
  // Agreement within tolerance: nothing.
  assert.deepEqual(codes(l, [rec({ id: 1, symbol: 'TA', name: 'Test A', price: 1.019, marketCap: 1.09e9 })]), []);
});

test('stale comparison uses the existing rule (more than 30 minutes apart), unchanged', () => {
  assert.deepEqual(CROSS_CHECK_TOLERANCE, { pricePct: 2, marketCapPct: 10, maxSnapshotGapMinutes: 30 });
  const l = lead({ id: 'test-a', symbol: 'TA', name: 'Test A' });
  assert.deepEqual(codes(l, [rec({ id: 1, symbol: 'TA', name: 'Test A', lastUpdated: '2026-10-21T11:27:00.000Z' })]), []); // exactly 30 minutes: not stale
  assert.deepEqual(codes(l, [rec({ id: 1, symbol: 'TA', name: 'Test A', lastUpdated: '2026-10-21T11:26:00.000Z' })]), ['cmc_snapshots_far_apart']);
  assert.deepEqual(codes(l, [rec({ id: 1, symbol: 'TA', name: 'Test A', lastUpdated: null })]), []); // no time: no timing claim
  assert.equal(CROSS_CHECK_WARNING_TEXT.cmc_snapshots_far_apart, 'The source snapshots are too far apart in time for a reliable comparison.');
});

// ---- association: unique id, the right scan, never by symbol -----------------------------------

test('cross-check not run, or run on another scan: no warning and no claim either way', async () => {
  const { scan, cmc } = await offline();
  const e = scan.result.discovery.highPriority.find((x: { id: string }) => x.id === 'syn-bravo');
  assert.deepEqual(leadCrossCheckWarnings(e, null, scan.result.evaluatedAt), []);
  assert.deepEqual(leadCrossCheckWarnings(e, undefined, scan.result.evaluatedAt), []);
  assert.deepEqual(leadCrossCheckWarnings(e, { results: 'broken' }, scan.result.evaluatedAt), []);
  assert.deepEqual(leadCrossCheckWarnings(e, cmc, '2026-10-20T09:00:00.000Z'), []); // a cross-check of a different scan
  assert.deepEqual(leadCrossCheckWarnings(e, cmc, undefined), []);
  assert.equal(leadCrossCheckWarnings(e, cmc, scan.result.evaluatedAt).length, 1); // the same scan: shown
});

test('duplicate symbols: each lead gets only its own result, by unique id; never by symbol', () => {
  const alpha = lead({ id: 'syn-alpha', symbol: 'SALP', name: 'Synthetic Alpha', price: 1.234, marketCap: 4.2e9, lastUpdated: '2026-10-21T11:57:00.000Z' });
  const classic = lead({ id: 'syn-alpha-classic', symbol: 'SALP', name: 'Synthetic Alpha Classic', price: 0.0030, marketCap: 640000, lastUpdated: '2026-10-21T11:55:00.000Z' });
  const { results } = crossCheckLeads([alpha, classic], RECORDS);
  const data = { scanEvaluatedAt: 'T', results };
  assert.deepEqual(results.map((r) => [r.id, r.match.cmc?.id]), [['syn-alpha', 900001], ['syn-alpha-classic', 900002]]);
  assert.deepEqual(leadCrossCheckWarnings(alpha, data, 'T'), []); // its own agreeing result
  assert.deepEqual(leadCrossCheckWarnings(classic, data, 'T').map((w: { code: string }) => w.code), ['cmc_price_differs']); // 0.0030 vs 0.0021
  // A third lead with the same symbol but no result of its own gets nothing (no borrowing by symbol).
  assert.deepEqual(leadCrossCheckWarnings(lead({ id: 'syn-alpha-other', symbol: 'SALP', name: 'Other' }), data, 'T'), []);
  // Two results claiming the same id (corrupt input): no guess.
  assert.deepEqual(leadCrossCheckWarnings(alpha, { scanEvaluatedAt: 'T', results: [results[1], { ...results[1], id: 'syn-alpha' }, { ...results[0] }] }, 'T'), []);
});

// ---- nothing else changes --------------------------------------------------------------------------

test('unchanged scores, tiers and rankings; leads are not modified by the cross-check', async () => {
  const { scan } = await offline();
  const leads: DiscoveryEntry[] = [...scan.result.discovery.highPriority, ...scan.result.discovery.watchlist, ...scan.result.discovery.insufficientData];
  const before = JSON.stringify(leads);
  crossCheckLeads(leads, RECORDS);
  assert.equal(JSON.stringify(leads), before);
  assert.deepEqual(scan.result.discovery.highPriority.map((e: DiscoveryEntry) => [e.id, e.score]), [['syn-alpha', 8], ['syn-bravo', 5]]);
  assert.deepEqual(scan.result.discovery.watchlist.map((e: DiscoveryEntry) => e.id), ['syn-echo', 'syn-delta', 'syn-charlie']);
  assert.deepEqual(scan.result.movers.map((c: { asset: { id: string } }) => c.asset.id), ['syn-alpha', 'syn-bravo']);
});

test('dashboard: warnings appear only on crypto research leads, labelled as the second source; stocks untouched', () => {
  const app = readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
  assert.equal((app.match(/leadCrossCheckWarnings\(/g) ?? []).length, 1); // one call, inside leadNotes
  const entry = app.slice(app.indexOf('function leadNotes(e)'), app.indexOf('function discoveryEntry('));
  assert.match(entry, /leadCrossCheckWarnings\(e, state\.cmc\?\.data, state\.last\?\.result\?\.evaluatedAt\)/);
  assert.match(entry, /`Second source: \$\{w\.text\}`/);
  // No comparison logic in the browser: no tolerances, no diff arithmetic in the lookup.
  const view = readFileSync(new URL('../src/web/public/simple-view.js', import.meta.url), 'utf8');
  const lookup = view.slice(view.indexOf('export function leadCrossCheckWarnings'), view.indexOf('// ---- dashboard wording'));
  assert.doesNotMatch(lookup, /diffPct|tolerance|agrees|Math\./);
  // Only crypto leads get them: in the table via the lead map (empty without discovery) and in the
  // not-checked list. Stock results carry no discovery, so stock rows never show them.
  assert.match(app, /state\.leadById = new Map\(r\.discovery \? \[\.\.\.r\.discovery\.highPriority, \.\.\.r\.discovery\.watchlist\]\.map\(\(e\) => \[e\.id, e\]\) : \[\]\);/);
  assert.match(app, /\.\.\.\(state\.leadById\?\.has\(row\.id\) \? leadNotes\(state\.leadById\.get\(row\.id\)\) : \[\]\)/);
  assert.match(app, /if \(r\.discovery\) root\.append\(discoveryView\(r\.discovery, coverage\.length > 0\)\)/);
});
