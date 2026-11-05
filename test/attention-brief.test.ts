import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FetchLike } from '../src/providers/http.ts';
import { parseTrending } from '../src/providers/coingecko-search.ts';
import { rowBrief } from '../src/web/brief.ts';
import type { DashboardRow } from '../src/web/rows.ts';
import { WEB_HOST, createScanService, handleRequest } from '../src/web/server.ts';

globalThis.fetch = (() => {
  throw new Error('Network access is not allowed in tests.');
}) as typeof fetch;

const KEY = 'TEST-TREND-KEY-not-real-7070';
const PORT = 4173;
const NOW = new Date('2026-10-21T12:00:00Z');
const H = { host: `${WEB_HOST}:${PORT}`, 'content-type': 'application/json', 'x-market-scanner': '1' };
const post = (path: string, body: unknown) => ({ method: 'POST', url: path, headers: H, body: JSON.stringify(body) });

// SYNTHETIC trending payload in the documented shape.
const TRENDING = { coins: [{ item: { id: 'syn-a', name: 'Syn A', symbol: 'sa', market_cap_rank: 12 } }, { item: { id: 'syn-b', name: 'Syn B', symbol: 'sb' } }, { nope: 1 }], nfts: [], categories: [] };

test('parseTrending keeps CoinGecko order as the trend rank; malformed entries are skipped and counted', () => {
  const r = parseTrending(TRENDING);
  assert.deepEqual(r.coins.map((c) => [c.id, c.symbol, c.trendRank, c.marketCapRank]), [['syn-a', 'SA', 1, 12], ['syn-b', 'SB', 2, null]]);
  assert.equal(r.skipped, 1);
  assert.throws(() => parseTrending({ coins: 'x' }));
});

test('attention check: offline uses the fixture with no request; live needs confirmation, sends 1 request, then is cached', async () => {
  const urls: string[] = [];
  const fetch: FetchLike = async (url) => { urls.push(url); return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(TRENDING) }; };
  const env = { COINGECKO_DEMO_API_KEY: KEY };
  const svc = createScanService({ env, fetch, clock: () => NOW, sleep: async () => {} }, 160);
  const off = JSON.parse((await handleRequest(post('/api/crypto/trending', { mode: 'offline' }), svc, env, PORT)).body);
  assert.equal(off.dataKind, 'test_data');
  assert.deepEqual(off.coins.map((c: { id: string }) => c.id), ['syn-echo', 'syn-outside', 'syn-alpha', 'syn-newcomer']);
  assert.match(off.meaning, /not social-media coverage, not sentiment and not evidence of buying/);
  assert.equal(urls.length, 0);
  const ask = await handleRequest(post('/api/crypto/trending', { mode: 'live' }), svc, env, PORT);
  assert.equal(ask.status, 428);
  assert.equal(urls.length, 0);
  const live = await handleRequest(post('/api/crypto/trending', { mode: 'live', confirmLive: true }), svc, env, PORT);
  assert.equal(live.status, 200, live.body);
  assert.deepEqual(urls, ['https://api.coingecko.com/api/v3/search/trending']);
  assert.ok(!live.body.includes(KEY) && !urls[0]!.includes(KEY));
  const cached = JSON.parse((await handleRequest(post('/api/crypto/trending', { mode: 'live' }), svc, env, PORT)).body);
  assert.equal(cached.fromCache, true);
  assert.equal(urls.length, 1);
});

const base = (over: Partial<DashboardRow>): DashboardRow => ({
  key: 'stocks:SYN', market: 'stocks', name: 'SYN', symbol: 'SYN', id: 'SYN', unitPrice: 10, priceAsOf: '2026-10-20', priceBasis: '', dataKind: 'verified_market_data',
  signal: { status: 'qualified', category: 'Mover', score: 6, maxScore: 8, order: 0 }, volumeMultiple: 3, volumeUsd: 1e8,
  change: { short: { label: '1d', value: 9 }, long: { label: '20d', value: 12 } }, classification: null,
  risk: { flags: ['Closed 12.0% below the day\'s high: much of the session\'s gain faded.'] } as DashboardRow['risk'],
  warnings: [], why: [], security: { label: 'Common stock', basis: 'Massive ticker reference', kind: 'common' }, move: null, ...over,
});

test('row brief: separate evidence quality, key risk and next step, from existing values only', () => {
  const s = rowBrief(base({}));
  assert.match(s.reason!, /moved \+9\.0% in the last session.*about 3\.0× its usual level/);
  assert.equal(s.evidence.level, 'single_source');
  assert.match(s.evidence.text, /one source, not independently confirmed/);
  assert.match(s.keyRisk!, /below the day's high/);
  assert.match(s.next, /news for a catalyst/);
  assert.equal(rowBrief(base({ security: undefined })).evidence.level, 'limited');
  assert.equal(rowBrief(base({ dataKind: 'test_data' })).evidence.level, 'test_data');
  const crypto = rowBrief(base({ market: 'crypto' }), { explanation: { reason: 'R', nextStep: null, warnings: [
    { code: 'stale_data', group: 'data_quality', text: 'Its market data is out of date.' }, { code: 'extreme_spike', group: 'volatility', text: 'Spike.' }] } });
  assert.deepEqual([crypto.reason, crypto.evidence.level, crypto.evidence.text, crypto.keyRisk], ['R', 'limited', 'Its market data is out of date.', 'Spike.']);
  const weak = rowBrief(base({ market: 'crypto', risk: { flags: [] } as unknown as DashboardRow['risk'] }), { explanation: { reason: 'R', nextStep: null, warnings: [{ code: 'one_signal', group: 'evidence', text: 'Only trading activity stands out.' }] } });
  assert.equal(weak.keyRisk, 'Only trading activity stands out.');
  const none = rowBrief(base({ signal: { status: 'no_pattern', category: null, score: null, maxScore: null, order: 0 }, risk: { flags: [] } as unknown as DashboardRow['risk'] }));
  assert.deepEqual([none.reason, none.keyRisk], [null, null]);
});
