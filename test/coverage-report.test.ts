// Scan coverage reporting (dashboard wording only). Every coin is SYNTHETIC TEST DATA; CoinGecko is
// mocked; no test contacts the internet or needs a credential.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DAY_MS } from '../src/core/time.ts';
import { COINGECKO_INFO, nextStepFor } from '../src/core/errors.ts';
import { fetchLiveDataset } from '../src/providers/coingecko.ts';
import { type HistoryCache, isFreshHistory } from '../src/providers/history-cache.ts';
import { type FetchLike, HttpError, createHttpClient } from '../src/providers/http.ts';
import { runScan } from '../src/scanner/analyze.ts';
import { normalizeDataset } from '../src/scanner/normalize.ts';
import { summarizeCryptoScan } from '../src/scanner/render.ts';
import { LIVE_MIN_INTERVAL_MS } from '../src/web/crypto-search.ts';
import { coverageFigures, coverageSentences, dashboardWording, exclusionBreakdown, exclusionGroup } from '../src/web/public/simple-view.js';

globalThis.fetch = (() => {
  throw new Error('Network access is not allowed in tests.');
}) as typeof fetch;

const NOW = new Date('2026-10-21T12:00:00Z');
const coin = (id: string, o: Record<string, unknown> = {}) => ({ id, symbol: id.slice(0, 5), name: `Test ${id}`, current_price: 5, market_cap: 1e9, total_volume: 50e6, price_change_percentage_24h: 1, price_change_percentage_7d_in_currency: 2, last_updated: new Date(NOW.getTime() - 3 * 60_000).toISOString(), ...o });
// Snapshot: 4 eligible (2 quiet large caps, 2 smaller active ones), plus one of each kind of exclusion.
const MARKETS = (now: Date) => [
  coin('big-one', { market_cap: 9e9, total_volume: 300e6, last_updated: new Date(now.getTime() - 3 * 60_000).toISOString() }),
  coin('big-two', { market_cap: 8e9, total_volume: 250e6, last_updated: new Date(now.getTime() - 3 * 60_000).toISOString() }),
  coin('small-move', { market_cap: 3e8, total_volume: 2e7, price_change_percentage_24h: 15, price_change_percentage_7d_in_currency: 12, last_updated: new Date(now.getTime() - 3 * 60_000).toISOString() }),
  coin('small-churn', { market_cap: 1.5e8, total_volume: 3e7, price_change_percentage_24h: 2, price_change_percentage_7d_in_currency: 25, last_updated: new Date(now.getTime() - 3 * 60_000).toISOString() }),
  { ...coin('test-tether', { last_updated: new Date(now.getTime() - 3 * 60_000).toISOString() }), symbol: 'usdt', current_price: 1, price_change_percentage_24h: 0, price_change_percentage_7d_in_currency: 0 }, // scope rule: stablecoin
  coin('tiny-cap', { market_cap: 5e7, total_volume: 2e7, last_updated: new Date(now.getTime() - 3 * 60_000).toISOString() }), // scope rule: below market cap
  coin('stale-coin', { last_updated: new Date(now.getTime() - 3 * 60 * 60_000).toISOString() }), // data: stale
];
const chart = (now: Date, base: number) => {
  const today = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
  return { total_volumes: [...Array.from({ length: 91 }, (_, i) => [today - (91 - i) * DAY_MS, Math.round(base * (i % 2 ? 1.05 : 0.95))]), [now.getTime() - 60_000, base * 3]] };
};

/** In-memory history cache using the real same-UTC-day freshness rule. */
function memoryCache(): HistoryCache & { stored: Map<string, { fetchedAt: string; totalVolumes: unknown[] }> } {
  const stored = new Map<string, { fetchedAt: string; totalVolumes: unknown[] }>();
  return {
    stored,
    get: (id, days, now) => {
      const e = stored.get(`${id}|${days}`);
      return e && isFreshHistory(new Date(e.fetchedAt), now) ? e : null;
    },
    set: (id, days, fetchedAt, totalVolumes) => { stored.set(`${id}|${days}`, { fetchedAt: fetchedAt.toISOString(), totalVolumes }); return true; },
  };
}

async function liveRun(maxCalls: number, opts: { now?: Date; cache?: HistoryCache; failId?: string } = {}) {
  const now = opts.now ?? NOW;
  const urls: string[] = [];
  const fn: FetchLike = async (url) => {
    urls.push(url);
    const id = /\/coins\/([^/]+)\/market_chart/.exec(url)?.[1];
    if (id && id === opts.failId) return { ok: false, status: 500, headers: { get: () => null }, text: async () => '' };
    const body = url.includes('/coins/markets') ? MARKETS(now) : chart(now, id?.startsWith('big') ? 200e6 : 1e7);
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };
  const client = createHttpClient({ fetch: fn, baseUrl: 'https://api.example.test/api/v3', apiKeyHeader: 'x-cg-demo-api-key', apiKey: 'TEST-KEY-not-real', maxCalls, sleep: async () => {} });
  const data = await fetchLiveDataset({ client, clock: () => now, maxCalls, sleep: async () => {}, historyCache: opts.cache });
  const result = JSON.parse(JSON.stringify(runScan(normalizeDataset(data), now))); // as the dashboard receives it (JSON)
  const history = urls.filter((u) => u.includes('/market_chart')).map((u) => /\/coins\/([^/]+)\//.exec(u)![1]!);
  return { result, urls, history };
}

// ---- coverage figures: zero, partial, full ------------------------------------------------------------

test('zero coverage: only the market list fits; nothing is called evaluated; the estimate covers every eligible asset', async () => {
  const { result, history } = await liveRun(1);
  assert.deepEqual(history, []);
  const f = coverageFigures(result)!;
  assert.deepEqual([f.snapshot, f.passedNonHistoryFilters, f.historiesObtained, f.evaluated, f.notRequested, f.additionalHistoryRequests], [7, 4, 0, 0, 4, 4]);
  const s = coverageSentences(f).join(' ');
  assert.match(s, /^7 assets were in the market snapshot; 4 passed the filters that do not need trading history\. 0 were evaluated against their own trading history\./);
  assert.match(s, /4 eligible assets were not evaluated because history requests stopped before reaching them \(the per-run limit of 1 requests was reached\): skipped, not rejected by the scanner's rules\./);
  assert.match(s, /would take about 4 more history requests \(one per asset\), plus one for the market list; a later snapshot may list different assets\./);
});

test('partial coverage: the estimate equals the eligible assets whose history was not requested', async () => {
  const { result, history } = await liveRun(3);
  assert.deepEqual(history, ['small-churn', 'small-move']); // request order unchanged: snapshot activity first
  const f = coverageFigures(result)!;
  assert.deepEqual([f.historiesObtained, f.evaluated, f.notRequested, f.requestFailed, f.additionalHistoryRequests], [2, 2, 2, 0, 2]);
  assert.equal(f.additionalHistoryRequests, result.excluded.filter((e: { reasons: { code: string }[] }) => e.reasons.some((r) => r.code === 'history_not_requested')).length);
  assert.equal(f.additionalHistoryRequests, f.passedNonHistoryFilters - f.historiesObtained - f.requestFailed);
  const s = coverageSentences(f).join(' ');
  assert.match(s, /2 were evaluated against their own trading history\./);
  assert.match(s, /2 eligible assets were not evaluated .*skipped, not rejected by the scanner's rules\./);
  assert.match(s, /about 2 more history requests/);
  assert.match(s, /A rerun on the same UTC day reuses the histories already fetched today, so it can evaluate more assets without repeating those requests\. Histories from earlier UTC days are never reused\./);
});

test('full coverage: no estimate and no rerun advice; a failed request is reported separately, not as budget', async () => {
  const full = coverageFigures((await liveRun(160)).result)!;
  assert.deepEqual([full.historiesObtained, full.evaluated, full.notRequested, full.additionalHistoryRequests, full.complete], [4, 4, 0, 0, true]);
  const s = coverageSentences(full);
  assert.equal(s.at(-1), 'Every eligible asset\'s history was obtained.');
  assert.doesNotMatch(s.join(' '), /more history requests|rerun/);
  const { result } = await liveRun(160, { failId: 'big-two' });
  const f = coverageFigures(result)!;
  assert.deepEqual([f.requestFailed, f.notRequested, f.additionalHistoryRequests, f.evaluated], [1, 0, 0, 3]);
  assert.match(coverageSentences(f).join(' '), /1 history request failed, so that asset was not evaluated\./);
  // Offline fixture (no coverage): nothing is claimed.
  assert.equal(coverageFigures({ dataset: { kind: 'synthetic' } }), null);
  assert.deepEqual(coverageSentences(null), []);
});

// ---- three separate categories ------------------------------------------------------------------------

test('budget-skipped, data problems and scope rules are counted separately and never combined', async () => {
  const { result } = await liveRun(3);
  const byId = Object.fromEntries(result.excluded.map((e: { id: string; reasons: { code: string }[] }) => [e.id, exclusionGroup(e.reasons)]));
  assert.deepEqual(byId, { 'big-one': 'budget_skipped', 'big-two': 'budget_skipped', 'stale-coin': 'data', 'test-tether': 'rule', 'tiny-cap': 'rule' });
  assert.deepEqual(exclusionBreakdown(result.excluded), { budget_skipped: 2, data: 1, rule: 2 });
  // Every budget-skipped asset passed every non-history filter: it has no rule or data reason at all.
  for (const e of result.excluded.filter((x: { id: string }) => byId[x.id] === 'budget_skipped')) {
    assert.deepEqual(e.reasons.map((r: { code: string }) => r.code), ['history_not_requested']);
  }
  // A failed history request is a data problem, not a budget skip.
  const failed = await liveRun(160, { failId: 'big-two' });
  assert.equal(exclusionGroup(failed.result.excluded.find((e: { id: string }) => e.id === 'big-two').reasons), 'data');
  // An asset with both a rule reason and a data problem counts once, under the rule.
  assert.equal(exclusionGroup([{ code: 'stale_data' }, { code: 'below_market_cap' }]), 'rule');
  assert.deepEqual(exclusionBreakdown([]), { budget_skipped: 0, data: 0, rule: 0 });
});

// ---- same-day cache reuse ----------------------------------------------------------------------------

test('same-day rerun: cached histories are reused, the next assets are requested, no history is requested twice', async () => {
  const cache = memoryCache();
  const first = await liveRun(3, { cache });
  assert.deepEqual(first.history, ['small-churn', 'small-move']);
  const second = await liveRun(3, { cache, now: new Date(NOW.getTime() + 60 * 60_000) });
  assert.deepEqual(second.history, ['big-one', 'big-two']); // only the assets not yet cached
  assert.equal(new Set([...first.history, ...second.history]).size, first.history.length + second.history.length);
  const f = coverageFigures(second.result)!;
  assert.deepEqual([f.historiesObtained, f.fromCache, f.evaluated, f.notRequested], [4, 2, 4, 0]);
  assert.match(coverageSentences(f).join(' '), /4 were evaluated against their own trading history \(2 histories were reused from today's cache, with no request\)\./);
  // The next UTC day: yesterday's entries are not reused (freshness rule unchanged).
  const nextDay = await liveRun(3, { cache, now: new Date(NOW.getTime() + DAY_MS) });
  assert.deepEqual(nextDay.history, ['small-churn', 'small-move']);
  assert.equal(coverageFigures(nextDay.result)!.fromCache, 0);
});

// ---- dashboard wording -------------------------------------------------------------------------------

test('dashboard instructions name the "Max API requests" field; CLI wording itself is unchanged', async () => {
  const { result } = await liveRun(3);
  const summary = summarizeCryptoScan(result);
  assert.match(summary.nextStep!, /run again with a larger --max-requests/); // the shared CLI text, unchanged
  assert.equal(dashboardWording(summary.nextStep), 'run again with a larger "Max API requests" value if you want to spend more API requests on this scan.');
  const budgetErr = nextStepFor(new HttpError('budget', '/x', 'm', 429), COINGECKO_INFO);
  assert.equal(dashboardWording(budgetErr), 'The per-run request limit was reached (retries count toward it). Re-run with a larger "Max API requests" value if you intend to use more requests.');
  assert.match(dashboardWording('consider a smaller --max-requests'), /a smaller "Max API requests" value/);
  assert.doesNotMatch(dashboardWording('--max-requests must be set'), /--max-requests/);
  assert.equal(dashboardWording(null), null);
  const app = readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /--max-requests/);
  assert.match(app, /el\('b', \{\}, 'Next step: '\), dashboardWording\(s\.nextStep\)\)/);
  assert.match(app, /showError\(dashboardWording\(data\.error\)/);
  // In place: the coverage line sits after the existing Freshness line; the breakdown under the existing Excluded heading.
  assert.match(app, /'Freshness: '\), s\.freshness\)\);\n.*\n  const coverage = data\.market === 'crypto' \? coverageSentences\(coverageFigures\(r\)\) : \[\];\n  if \(coverage\.length\) root\.append\(el\('p', \{ class: 'kv' \}, el\('b', \{\}, 'Coverage: '\), coverage\.join\(' '\)\)\);/);
  assert.match(app, /first reason shown\)`\)\);\n  if \(data\.market === 'crypto' && r\.excluded\.length > 0\) \{/);
});

test('crypto search states the officially documented Demo limit (100/min); pacing is unchanged', () => {
  const app = readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
  const search = readFileSync(new URL('../src/web/crypto-search.ts', import.meta.url), 'utf8');
  assert.match(app, /This sends 1 CoinGecko request \(Demo plan: 100 per minute\)\./);
  for (const text of [app, search]) assert.doesNotMatch(text, /30 per minute|30 calls\/minute/);
  assert.match(search, /the Demo plan allows 100 per minute, shared with scans/);
  assert.equal(LIVE_MIN_INTERVAL_MS, 2_000);
});
