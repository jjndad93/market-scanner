// Plain-English sentences shown in place in the original dashboard layout. Uses the real offline
// scan (synthetic fixture) and the synthetic CoinMarketCap fixture only; no network, no credentials.
// (Research-lead explanations themselves are tested in lead-quality.test.ts.)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseCmcListings } from '../src/providers/coinmarketcap.ts';
import { crossCheckLeads, type LeadCrossCheck } from '../src/scanner/cross-check.ts';
import type { Discovery } from '../src/scanner/types.ts';
import { WEB_HOST, createScanService, handleRequest } from '../src/web/server.ts';
import { plainCheck } from '../src/web/public/simple-view.js';

globalThis.fetch = (() => {
  throw new Error('Network access is not allowed in tests.');
}) as typeof fetch;

const NOW = new Date('2026-10-21T12:00:00Z');
const HEADERS = { host: `${WEB_HOST}:4173`, 'content-type': 'application/json', 'x-market-scanner': '1' };

async function offlineDiscovery(): Promise<Discovery> {
  const svc = createScanService({ env: {}, fetch: async () => { throw new Error('no fetch'); }, clock: () => NOW, sleep: async () => {} }, 160);
  const r = await handleRequest({ method: 'POST', url: '/api/scan/crypto', headers: HEADERS, body: '{"mode":"offline"}' }, svc, {}, 4173);
  return JSON.parse(r.body).result.discovery;
}
const allLeads = (d: Discovery) => [...d.highPriority, ...d.watchlist, ...d.insufficientData];
const cmcRecords = () => parseCmcListings(JSON.parse(readFileSync(new URL('./fixtures/cmc-listings.synthetic.json', import.meta.url), 'utf8'))).records;

test('cross-check sentences: identity is not agreement; missing values are "could not be compared"', async () => {
  const { results } = crossCheckLeads(allLeads(await offlineDiscovery()), cmcRecords());
  const say = (id: string) => plainCheck(results.find((x) => x.id === id)!).text;
  assert.equal(say('syn-alpha'), 'Same asset; both sources show a similar price and market cap.');
  assert.equal(say('syn-bravo'), 'The two data sources disagree: price differs by 5.2%.');
  assert.equal(say('syn-stale'), 'Same asset; the price agrees, but the market cap could not be compared (missing on one side).');
  assert.equal(say('syn-delta'), 'This asset could not be matched confidently: several CoinMarketCap coins share its name and symbol.');
  assert.equal(say('syn-echo'), 'This asset could not be matched confidently: on CoinMarketCap the symbol SECH belongs to a differently named coin.');
  assert.equal(say('syn-newcoin'), 'Not in CoinMarketCap\'s top 500, so it was not compared.');
  const base: LeadCrossCheck = {
    id: 'x', symbol: 'X', name: 'Test X', tier: 'watchlist', verdict: 'not_compared', notes: [], tags: [], providerCategory: null,
    match: { status: 'matched', basis: 'name', cmc: { id: 1, name: 'Test X', slug: 'x', rank: 9 }, candidates: [] },
    price: { coingecko: null, coinmarketcap: 1, diffPct: null, agrees: null }, marketCap: { coingecko: 1, coinmarketcap: null, diffPct: null, agrees: null },
  };
  assert.equal(plainCheck(base).text, 'Same asset found, but price and market cap could not be compared (missing on one side).');
  assert.equal(plainCheck({ ...base, price: { coingecko: 1, coinmarketcap: 1.2, diffPct: 20, agrees: false } }).text,
    'The two data sources disagree: price differs by 20.0%. The market cap could not be compared (missing on one side).');
});

test('page: each lead\'s cautions show with its coin; not-checked coins keep their explanation; evidence folds', () => {
  const app = readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
  assert.match(app, /import \{ coverageFigures, coverageSentences, dashboardWording, exclusionBreakdown, leadCrossCheckWarnings, plainCheck \} from '\/simple-view\.js';/);
  // Merged layout: evaluated leads are table rows; coins that could not be evaluated are listed in full;
  // every cross-check card is shown.
  assert.match(app, /list\.length \? el\('ul', \{ class: 'leads' \}, \.\.\.list\.map\(discoveryEntry\)\)/);
  assert.match(app, /box\.append\(el\('ul', \{ class: 'leads' \}, \.\.\.d\.results\.map\(\(x\) => cmcLead\(x, d\.attribution\)\)\)\);/);
  // The scan's own cautions in order, then (only after a cross-check) that lead's CoinMarketCap warnings.
  const notes = app.slice(app.indexOf('function leadNotes(e)'), app.indexOf('function discoveryEntry('));
  assert.match(notes, /const x = e\.explanation;/);
  assert.match(notes, /const second = leadCrossCheckWarnings\(e, state\.cmc\?\.data, state\.last\?\.result\?\.evaluatedAt\);/);
  assert.match(notes, /x && x\.warnings\.length \? el\('ul', \{ class: 'plain-warnings' \}, \.\.\.x\.warnings\.map\(\(w\) => el\('li', \{ class: 'plain-caution' \}, `Caution: \$\{w\.text\}`\)\)\) : null,\n    second\.length \? el\('ul', \{ class: 'plain-warnings' \}, \.\.\.second\.map\(\(w\) => el\('li', \{ class: 'plain-caution' \}, `Second source: \$\{w\.text\}`\)\)\) : null,/);
  // A not-checked coin: its reason, the same notes, then the exact evidence (folded).
  const entry = app.slice(app.indexOf('function discoveryEntry(e)'), app.indexOf('function discoveryView('));
  assert.match(entry, /x \? el\('p', \{ class: 'plain' \}, x\.reason\) : null,\n    \.\.\.leadNotes\(e\),\n    el\('details', \{\}, el\('summary', \{\}, 'Evidence'\),/);
  assert.doesNotMatch(app, /whyText|cautionText/); // the page shows the scan's wording; it keeps no copy of its own
  assert.match(app, /el\('p', \{ class: 'plain' \}, plainCheck\(x\)\.text\),\n    el\('div', \{ class: 'sym' \}, MATCH_TEXT\[x\.match\.status\]\(x\.match\)\),/);
  assert.doesNotMatch(app, /keptDetails|toggleButton|showAllLeads|cmcShowAll|TOP_LEADS|researchSummary|crossCheckItems|summaryTile/);
  assert.doesNotMatch(app, /innerHTML|insertAdjacentHTML|eval\(|new Function/);
});
