// Crypto dashboard section order and de-duplicated explanations (presentation only). Synthetic data and
// mocked CoinGecko responses; no network, no credentials. The rendered page is also checked in a browser.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DAY_MS } from '../src/core/time.ts';
import { fetchLiveDataset } from '../src/providers/coingecko.ts';
import { type FetchLike, createHttpClient } from '../src/providers/http.ts';
import { runScan } from '../src/scanner/analyze.ts';
import { normalizeDataset } from '../src/scanner/normalize.ts';
import { buildView } from '../src/web/public/budget.js';
import { coverageFigures, coverageSentences } from '../src/web/public/simple-view.js';

globalThis.fetch = (() => {
  throw new Error('Network access is not allowed in tests.');
}) as typeof fetch;

const app = readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
const render = app.slice(app.indexOf('function render() {'), app.indexOf('// ---- crypto asset search'));
const discoveryView = app.slice(app.indexOf('function discoveryView(d, coverageShown) {'), app.indexOf('// ---- CoinMarketCap cross-check'));

test('crypto order: qualified signals within budget, then research leads (with the CoinMarketCap check), then the other budget sections; stocks unchanged', () => {
  const first = render.indexOf('else if (crypto) root.append(sectionView(view.sections[0]));');
  const leads = render.indexOf('if (r.discovery) root.append(discoveryView(r.discovery, coverage.length > 0));');
  const rest = render.indexOf('if (view) for (const sec of crypto ? view.sections.slice(1) : view.sections) root.append(sectionView(sec));');
  assert.ok(first > 0 && leads > first && rest > leads, 'qualified section, then research leads, then the remaining sections');
  // The CoinMarketCap check stays at the end of the research-leads section; tiers keep their order.
  // Compact layout: only the high-priority tier starts open; the others open on click.
  assert.match(discoveryView, /for \(const key of \['highPriority', 'watchlist', 'insufficientData'\]\)/);
  assert.match(discoveryView, /box\.append\(el\('details', \{ class: 'section', open: key === 'highPriority' \? '' : null \},/);
  assert.ok(discoveryView.indexOf('box.append(cmcView());') > discoveryView.indexOf("for (const key of ['highPriority'"));
  // Stocks have no research leads, and every section renders in its original order (crypto ? … : view.sections).
  assert.match(render, /const crypto = data\.market === 'crypto';/);
  // Every section is still rendered once: the first before the leads (crypto), the rest after.
  assert.equal((render.match(/root\.append\(sectionView\(/g) ?? []).length, 2);
});

test('the first budget section is "Qualified signals within your budget and unit-price limit" whenever qualified signals are shown', () => {
  const rows = [{ key: 'a', unitPrice: 1, signal: { status: 'qualified' } }, { key: 'b', unitPrice: 1, signal: { status: 'no_pattern' } }];
  for (const preference of ['both', 'signals']) {
    assert.equal(buildView(rows, { budget: 100, maxUnitPrice: null, preference }).sections[0].title, 'Qualified signals within your budget and unit-price limit', preference);
  }
  // "Affordable assets only" has a single section (all evaluated assets in budget); it stays the first table.
  assert.deepEqual(buildView(rows, { budget: 100, maxUnitPrice: null, preference: 'affordable' }).sections.map((s: { title: string }) => s.title), ['Evaluated assets within your budget and unit-price limit']);
});

// ---- de-duplicated explanations ----------------------------------------------------------------------

const TODAY = Date.UTC(2026, 9, 21);
const NOW = new Date('2026-10-21T12:00:00Z');
const coin = (id: string, o: Record<string, unknown> = {}) => ({ id, symbol: id.slice(0, 5), name: `Test ${id}`, current_price: 5, market_cap: 1e9, total_volume: 50e6, price_change_percentage_24h: 1, price_change_percentage_7d_in_currency: 2, last_updated: '2026-10-21T11:57:00.000Z', ...o });
async function partialLiveResult() {
  const fn: FetchLike = async (url) => {
    const body = url.includes('/coins/markets')
      ? [coin('big-one', { market_cap: 9e9, total_volume: 300e6 }), coin('big-two', { market_cap: 8e9, total_volume: 250e6 }), coin('small-move', { market_cap: 3e8, total_volume: 2e7, price_change_percentage_24h: 15 })]
      : { total_volumes: Array.from({ length: 91 }, (_, i) => [TODAY - (91 - i) * DAY_MS, 1e7]) };
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };
  const client = createHttpClient({ fetch: fn, baseUrl: 'https://api.example.test/api/v3', apiKeyHeader: 'x-cg-demo-api-key', apiKey: 'TEST-KEY-not-real', maxCalls: 2, sleep: async () => {} });
  const data = await fetchLiveDataset({ client, clock: () => NOW, maxCalls: 2, sleep: async () => {} });
  return JSON.parse(JSON.stringify(runScan(normalizeDataset(data), NOW)));
}

test('with the Coverage line shown, the repeated discovery notes are dropped or shortened; distinct notes stay', async () => {
  const result = await partialLiveResult();
  const notes: string[] = result.discovery.coverage.notes;
  // The filter in app.js really matches the scanner's notes (so it cannot silently stop working).
  const evaluatedRe = / passed every filter and were evaluated against their own volume baseline\.$/;
  assert.ok(discoveryView.includes(String.raw`/ passed every filter and were evaluated against their own volume baseline\.$/`));
  assert.equal(notes.filter((n) => evaluatedRe.test(n)).length, 1);
  assert.equal(notes.filter((n) => n.startsWith('Incomplete scan:')).length, 1);
  // What the dropped note said is in the Coverage line, with the same number.
  const coverage = coverageSentences(coverageFigures(result)).join(' ');
  const evaluated = notes.find((n) => evaluatedRe.test(n))!;
  assert.match(coverage, new RegExp(`(^|\\. )${evaluated.split(' ')[0]} (was|were) evaluated against (its|their) own trading history`));
  // The incomplete-scan note's distinct point (where active skipped assets are listed) is kept.
  assert.match(discoveryView, /'Eligible assets whose history was not obtained \(see Coverage above\) are listed under Insufficient data if they showed snapshot activity; the rest were not evaluated\.'/);
  // Distinct notes are untouched: scope (top 500, Find a crypto asset), scope exclusions, activity signals never scored.
  assert.ok(notes.some((n) => /^Coverage: the \d+ asset records in this snapshot \(CoinGecko's top 500/.test(n)));
  assert.ok(notes.some((n) => /^Activity signals come from the snapshot only/.test(n)));
  // Without the Coverage line (offline), every note is shown exactly as before.
  assert.match(discoveryView, /if \(!coverageShown\) return \[n\];/);
});

test('excluded breakdown: points to Coverage for the budget skip, keeps the three categories separate', () => {
  assert.match(render, /const skipped = coverage\.length > 0 \? 'skipped when history requests stopped \(see Coverage above\), not rejected by any rule' : 'skipped because history requests stopped before reaching them \(request or rate limit; not rejected by any rule\)';/);
  assert.match(render, /`Of these: \$\{b\.budget_skipped\} \$\{skipped\}, ` \+/);
  assert.match(render, /`\$\{b\.data\} not evaluated because of missing, stale, implausible or unreliable data or a failed request, ` \+/);
  assert.match(render, /`and \$\{b\.rule\} outside the scanner's scope or eligibility rules\.`/);
});
