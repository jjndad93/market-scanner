// Crypto project profile and 2030 outlook. Profiles are SYNTHETIC TEST DATA; CoinGecko is mocked; no
// test contacts the internet or needs a credential. The curated forecasts are checked as data.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ProviderResponseError } from '../src/providers/coingecko.ts';
import { descriptionExcerpt, parseCoinProfile } from '../src/providers/coingecko-profile.ts';
import type { FetchLike } from '../src/providers/http.ts';
import { PROFILE_CACHE_TTL_MS, createCryptoSearchService } from '../src/web/crypto-search.ts';
import { FORECASTS, type Forecast, forecastProblems, forecastsFor } from '../src/web/forecasts.ts';
import { WEB_HOST, createScanService, handleRequest } from '../src/web/server.ts';
import { CONTEXT_RULES, impliedChangePct, outlookView, profileContext, supplyText } from '../src/web/public/simple-view.js';

globalThis.fetch = (() => {
  throw new Error('Network access is not allowed in tests.');
}) as typeof fetch;

const NOW = new Date('2026-10-27T12:00:00Z');
const KEY = 'TEST-CG-KEY-not-real-2030';
const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/crypto-profile.synthetic.json', import.meta.url), 'utf8'));
const profile = (id: string) => parseCoinProfile(FIXTURE.profiles[id], id, NOW);
const BAD_PHRASES = /\b(buy|sell|safe|unsafe)\b|guarantee|will reach|recommend/i; // advice or certainty words ("selling pressure" is a market description, allowed)

// ---- profile parsing: missing fields, unknown launch dates, links ------------------------------------

test('full profile: description excerpt is HTML-free, short and labelled as the project\'s; supply and links parsed', () => {
  const p = profile('syn-alpha');
  assert.equal(p.descriptionExcerpt, 'Synthetic Alpha is an invented test network for sharing files between users. Its token pays for storage.');
  assert.doesNotMatch(p.descriptionExcerpt!, /[<>]/);
  assert.equal(p.genesisDate, '2019-05-14');
  assert.deepEqual(p.categories, ['Storage', 'Layer 1 (L1)']); // duplicate removed
  assert.equal(p.homepage, 'https://example.com/synthetic-alpha'); // empty first link skipped
  assert.equal(supplyText(p), '660M circulating of 1.0B max (66%)');
});

test('missing fields and unknown or invalid launch dates become null, never guessed; unsafe links dropped', () => {
  const p = profile('syn-outside');
  assert.deepEqual([p.descriptionExcerpt, p.genesisDate, p.homepage, p.whitepaper, p.maxSupply, p.totalSupply], [null, null, null, null, null, null]);
  assert.deepEqual(p.categories, []);
  assert.equal(supplyText(p), '480M circulating; no maximum supply is listed');
  assert.equal(profile('syn-bravo').genesisDate, null); // 2031: in the future
  assert.equal(parseCoinProfile({ ...FIXTURE.profiles['syn-alpha'], genesis_date: '2019-02-30' }, 'syn-alpha', NOW).genesisDate, null);
  assert.equal(supplyText(parseCoinProfile({ id: 'x' }, 'x', NOW)), 'Not available');
  // The response must be the coin that was asked for.
  assert.throws(() => parseCoinProfile(FIXTURE.profiles['syn-alpha'], 'syn-bravo', NOW), ProviderResponseError);
  assert.throws(() => parseCoinProfile([], 'x', NOW), ProviderResponseError);
  assert.equal(descriptionExcerpt('x'.repeat(1000))!.length <= 320, true);
});

// ---- context signals: evidence, not verdicts ---------------------------------------------------------

test('main risks are context with what they do not imply; nothing is shown without the evidence', () => {
  const asset = { volume24h: { value: 1e6 }, marketCap: { value: 8e8 } }; // 0.125% turnover
  const alpha = profileContext(profile('syn-alpha'), asset);
  assert.deepEqual(alpha, [
    '34% of the maximum supply is not yet circulating. New supply can add selling pressure; check the release schedule.',
    'Daily trading is about 0.1% of its market cap, so large orders may move the price.',
  ]); // 71% below ATH is under the 80% rule; rank 41 is inside the top 250
  const outside = profileContext(profile('syn-outside'), { volume24h: { value: null }, marketCap: { value: null } });
  assert.deepEqual(outside, ['Ranked #612 by market cap. Smaller assets often trade less and swing more; rank alone says nothing about quality.']);
  const bravo = profileContext(profile('syn-bravo'), null);
  assert.deepEqual(bravo, [
    'CoinGecko lists it as a meme coin. Such tokens are usually driven by attention rather than revenue.',
    '96% below its all-time high. This shows past volatility; it does not mean it will or will not recover.',
  ]);
  for (const line of [...alpha, ...outside, ...bravo]) assert.doesNotMatch(line, BAD_PHRASES, line);
  assert.deepEqual(profileContext(null, null), []);
  assert.deepEqual(CONTEXT_RULES, { unissuedSharePct: 20, rankAbove: 250, belowAthPct: 80, turnoverBelowPct: 1 });
});

// ---- 2030 forecasts: data, calculations, labels -------------------------------------------------------

test('the curated forecasts are valid, sourced, dated, linked and limited to BTC, ETH and SOL', () => {
  assert.deepEqual(FORECASTS.map((f) => [f.coinId, f.publisher, f.published]), [['bitcoin', 'ARK Invest', '2025-04-24'], ['ethereum', 'VanEck', '2024-06-05'], ['solana', 'VanEck', '2023-10-27']]);
  for (const f of FORECASTS) {
    assert.deepEqual(forecastProblems(f, NOW), [], f.coinId);
    assert.match(f.url, /^https:\/\/www\.(ark-invest|vaneck)\.com\//);
    assert.ok(f.growthFactors.length <= 3);
  }
  assert.deepEqual(forecastsFor('dogecoin', NOW), []);
  assert.equal(forecastsFor('bitcoin', NOW).length, 1);
});

test('ARK figures are kept exactly, marked approximate as published, with ARK\'s own wording', () => {
  const ark = forecastsFor('bitcoin', NOW)[0]!;
  assert.deepEqual(ark.cases, { bear: 300_000, base: 710_000, bull: 1_500_000 });
  assert.equal(ark.approximate, true);
  assert.match(ark.assumptions, /six sources of capital accrual/);
  assert.doesNotMatch(ark.assumptions, /six markets/);
  assert.match(ark.assumptions, /ARK states the targets may not be reached if these assumptions fail\./);
  assert.deepEqual([ark.url, ark.published], ['https://www.ark-invest.com/articles/valuation-models/arks-bitcoin-price-target-2030', '2025-04-24']);
  assert.ok(FORECASTS.filter((f) => f.coinId !== 'bitcoin').every((f) => f.approximate === undefined)); // VanEck publishes exact figures
  const app = readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
  assert.match(app, /\$\{e\.approximate \? '~' : ''\}\$\$\{x\.value\.toLocaleString\(\)\}/); // "~$300,000"
  assert.match(app, /e\.approximate \? el\('span', \{ class: 'sym' \}, ' Approximate, as published\.'\) : null/);
  assert.match(app, /`% change vs \$\$\{o\.reference\.price\.toLocaleString\(\)\}, the CoinGecko USD price/); // "% change vs $4,000"
});

test('invalid entries are rejected, never repaired', () => {
  const ok = FORECASTS[0]!;
  const bad: [Partial<Forecast>, RegExp][] = [
    [{ url: 'http://example.com' }, /https/], [{ url: 'not a url' }, /valid URL/], [{ published: '2027-01-01' }, /future/],
    [{ published: '2025-13-40' }, /invalid/], [{ currency: 'EUR' as 'USD' }, /USD/], [{ targetYear: 2029 as 2030 }, /2030/],
    [{ cases: {} }, /no published figure/], [{ cases: { bear: 10, base: 5 } }, /increasing order/], [{ cases: { base: -1 } }, /positive/],
  ];
  for (const [over, re] of bad) {
    const f = { ...ok, ...over } as Forecast;
    assert.match(forecastProblems(f, NOW).join('; '), re, JSON.stringify(over));
    assert.deepEqual(forecastsFor(ok.coinId, NOW, [f]), []);
  }
});

test('implied change: (target - reference) / reference, against one stated USD reference price', () => {
  assert.equal(impliedChangePct(150, 100), 50);
  assert.equal(impliedChangePct(50, 100), -50);
  assert.ok(Math.abs(impliedChangePct(22_000, 3_745.5)! - 487.37) < 0.01);
  for (const ref of [0, -1, null, Number.NaN, undefined]) assert.equal(impliedChangePct(100, ref as number), null);
  const o = outlookView(forecastsFor('ethereum', NOW), 4000, '2026-10-27T11:59:00.000Z', NOW);
  assert.deepEqual(o.entries[0]!.figures.map((x: { case: string; impliedPct: number }) => [x.case, Math.round(x.impliedPct)]), [['bear', -91], ['base', 450], ['bull', 3750]]);
  assert.deepEqual(o.reference, { price: 4000, asOf: '2026-10-27T11:59:00.000Z' });
  // No current price: figures shown, no percentage invented.
  const noRef = outlookView(forecastsFor('ethereum', NOW), null, null, NOW);
  assert.equal(noRef.reference, null);
  assert.ok(noRef.entries[0]!.figures.every((x: { impliedPct: null }) => x.impliedPct === null));
});

test('labels: one source is "one source\'s estimate"; old sources are dated; no forecast says so plainly', () => {
  const one = outlookView(forecastsFor('solana', NOW), 150, null, NOW);
  assert.equal(one.status, 'one');
  assert.equal(one.message, 'One source\'s estimate, not a consensus.');
  assert.deepEqual([one.entries[0]!.dated, one.entries[0]!.ageMonths], [true, 36]); // October 2023
  const btc = outlookView(forecastsFor('bitcoin', NOW), 100_000, null, NOW);
  assert.deepEqual([btc.entries[0]!.dated, btc.entries[0]!.ageMonths], [false, 18]); // 18 months: at the limit, not yet dated
  const none = outlookView([], 100, null, NOW);
  assert.deepEqual([none.status, none.message, none.entries], ['none', 'No credible, comparable 2030 forecast is on file for this asset.', []]);
});

test('conflicting estimates are shown as disagreement, never averaged', () => {
  const a = { ...FORECASTS[0]!, publisher: 'Source A', cases: { base: 100_000 } };
  const b = { ...FORECASTS[0]!, publisher: 'Source B', cases: { base: 700_000 } };
  const o = outlookView([a, b], 100_000, null, NOW);
  assert.equal(o.status, 'several');
  assert.equal(o.message, '2 separate sources; not averaged.');
  assert.equal(o.disagreement, 'Sources disagree widely: base cases range from $100,000 to $700,000.');
  assert.deepEqual(o.entries.map((e: { publisher: string }) => e.publisher), ['Source A', 'Source B']); // each kept separate
  assert.doesNotMatch(JSON.stringify(o), /"(average|mean|consensus)[a-z]*"s*:/i); // no combined figure is computed
  assert.equal(outlookView([a, { ...b, cases: { base: 150_000 } }], 1, null, NOW).disagreement, null); // within 2x: no claim
});

// ---- service: confirmation, one request, cache, offline -----------------------------------------------

function provider(answer: (url: string) => { status: number; body?: unknown }) {
  const urls: string[] = [];
  const fn: FetchLike = async (url) => {
    urls.push(url);
    const a = answer(url);
    return { ok: a.status < 300, status: a.status, headers: { get: () => null }, text: async () => JSON.stringify(a.body ?? {}) };
  };
  return { fn, urls };
}

test('live profile: confirmation first, exactly one request with no tickers, then the day-long cache', async () => {
  let clock = NOW.getTime();
  const p = provider(() => ({ status: 200, body: { ...FIXTURE.profiles['syn-alpha'], id: 'bitcoin' } }));
  const svc = createCryptoSearchService({ env: { COINGECKO_DEMO_API_KEY: KEY }, fetch: p.fn, clock: () => new Date(clock), sleep: async () => {} }, { getLastCrypto: () => undefined, scanRunning: () => false });
  const first = await svc.profile('live', 'bitcoin', false, false);
  assert.deepEqual([first.status, first.data.needsConfirm], [428, true]);
  assert.equal(p.urls.length, 0);
  const r = await svc.profile('live', 'bitcoin', false, true);
  assert.equal(r.status, 200);
  assert.deepEqual(p.urls, ['https://api.coingecko.com/api/v3/coins/bitcoin?community_data=false&developer_data=false&localization=false&market_data=true&sparkline=false&tickers=false']);
  assert.equal((r.data.forecasts as Forecast[])[0]!.publisher, 'ARK Invest'); // curated data attached, no request
  assert.ok(!JSON.stringify(r.data).includes(KEY));
  clock += 6 * 3600_000;
  assert.deepEqual([(await svc.profile('live', 'bitcoin', false, false)).data.fromCache], [true]);
  clock += PROFILE_CACHE_TTL_MS;
  assert.equal((await svc.profile('live', 'bitcoin', false, false)).status, 428); // expired: ask again
  assert.equal(p.urls.length, 1);
  // A response for a different coin is refused, not shown.
  const wrong = provider(() => ({ status: 200, body: FIXTURE.profiles['syn-bravo'] }));
  const s2 = createCryptoSearchService({ env: { COINGECKO_DEMO_API_KEY: KEY }, fetch: wrong.fn, clock: () => NOW, sleep: async () => {} }, { getLastCrypto: () => undefined, scanRunning: () => false });
  const w = await s2.profile('live', 'syn-alpha', false, true);
  assert.equal(w.status, 502);
  assert.match(String(w.data.error), /different coin/);
});

test('blocked during a scan or without a key; offline uses the fixture with zero requests', async () => {
  const p = provider(() => ({ status: 200, body: {} }));
  const scanning = createCryptoSearchService({ env: { COINGECKO_DEMO_API_KEY: KEY }, fetch: p.fn, clock: () => NOW, sleep: async () => {} }, { getLastCrypto: () => undefined, scanRunning: () => true });
  assert.equal((await scanning.profile('live', 'bitcoin', false, true)).status, 409);
  const noKey = createCryptoSearchService({ env: {}, fetch: p.fn, clock: () => NOW, sleep: async () => {} }, { getLastCrypto: () => undefined, scanRunning: () => false });
  assert.equal((await noKey.profile('live', 'bitcoin', false, true)).status, 422);
  assert.equal(p.urls.length, 0);
  const off = await noKey.profile('offline', 'syn-alpha', false, false);
  assert.deepEqual([off.status, off.data.dataKind, off.data.requestsUsed, (off.data.profile as { genesisDate: string }).genesisDate, off.data.forecasts], [200, 'test_data', 0, '2019-05-14', []]);
  assert.equal((await noKey.profile('offline', 'syn-unknown', false, false)).data.profile, null);
});

test('API route: same guards and validation as the asset lookup', async () => {
  const svc = createScanService({ env: {}, fetch: async () => { throw new Error('no fetch'); }, clock: () => NOW, sleep: async () => {} }, 160);
  const H = { host: `${WEB_HOST}:4173`, 'content-type': 'application/json', 'x-market-scanner': '1' };
  const post = (body: unknown, headers: Record<string, string | undefined> = H) => handleRequest({ method: 'POST', url: '/api/crypto/profile', headers, body: JSON.stringify(body) }, svc, {}, 4173);
  assert.equal((await post({ mode: 'offline', id: 'syn-alpha' })).status, 200);
  assert.equal((await post({ mode: 'offline', id: '../etc' })).status, 400);
  assert.equal((await post({ mode: 'offline', id: 'syn-alpha' }, { ...H, 'x-market-scanner': undefined })).status, 403);
  assert.equal((await post({ mode: 'offline', id: 'syn-alpha' }, { ...H, origin: 'http://evil.example' })).status, 403);
  assert.equal(svc.running, false);
});

test('page: the profile loads only from its button, inside the asset details; text only', () => {
  const app = readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
  assert.equal((app.match(/\/api\/crypto\/profile/g) ?? []).length, 1);
  assert.equal((app.match(/loadProfile\(/g) ?? []).length, 2); // definition and the button's click handler
  assert.match(app, /pb\.addEventListener\('click', \(\) => loadProfile\(coin, d, profileBox, pb\)\);/);
  assert.match(app, /Project-provided text \(CoinGecko\), not verified\./);
  assert.match(app, /'2030 outlook '/);
  assert.match(app, /not a guarantee/);
  assert.doesNotMatch(app, /innerHTML|insertAdjacentHTML|eval\(|new Function/);
});
