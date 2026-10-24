import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DAY_MS } from '../src/core/time.ts';
import type { FetchLike } from '../src/providers/http.ts';
import { WEB_HOST, createScanService, handleRequest } from '../src/web/server.ts';
import { parseTickers } from '../src/web/where-to-buy.ts';

globalThis.fetch = (() => {
  throw new Error('Network access is not allowed in tests.');
}) as typeof fetch;

const PORT = 4173;
const KEY = 'TEST-WTB-KEY-not-real-7777';
const NOW = new Date('2026-10-21T12:00:00Z');
const HEADERS = { host: `${WEB_HOST}:${PORT}`, 'content-type': 'application/json', 'x-market-scanner': '1' };
const post = (url: string, body: unknown) => ({ method: 'POST', url, headers: HEADERS, body: JSON.stringify(body) });

function counting(answer?: (url: string) => { status: number; body?: unknown }) {
  const urls: string[] = [];
  const fn: FetchLike = async (url, init) => {
    urls.push(url);
    if (!answer) throw new Error('fetch must not be called');
    assert.equal(init?.headers?.['x-cg-demo-api-key'], KEY); // key in a header, never the URL
    const a = answer(url);
    return { ok: a.status < 300, status: a.status, headers: { get: () => null }, text: async () => JSON.stringify(a.body ?? {}) };
  };
  return { fn, urls };
}

const REAL_SHAPE = {
  tickers: [
    { base: 'AKE', target: 'USDT', market: { name: 'Gate', identifier: 'gate' }, converted_volume: { usd: 16e6 }, trust_score: 'green', trade_url: 'https://www.gate.io/trade/AKE_USDT' },
    { base: 'AKE', target: 'USD', market: { name: 'Kraken', identifier: 'kraken' }, converted_volume: { usd: 2.3e6 }, trust_score: 'green', trade_url: 'https://pro.kraken.com/app/trade/ake-usd' },
    { base: 'AKE', target: 'USDT', market: { name: 'Mystery Exchange', identifier: 'mystery' }, converted_volume: { usd: 9e6 }, trust_score: 'yellow' },
    { base: '0x2c3a8Ee94dDD97244a93Bc48298f97d2C412F7Db', target: '0x55d398326f99059fF775485246999027B3197955', market: { name: 'PancakeSwap v3 (BSC)', identifier: 'pancakeswap-v3-bsc' }, converted_volume: { usd: 3e6 }, trust_score: 'green' },
    { base: 'AKE', target: 'USDT', market: { name: 'Fake Volume Ex', identifier: 'fakevol' }, converted_volume: { usd: 9e9 }, is_anomaly: true },
  ],
};

test('parseTickers: US-friendly exchanges first, DEX separated with the contract, anomalies dropped', () => {
  const w = parseTickers(REAL_SHAPE, 'ake');
  assert.deepEqual(w.cex.map((v) => v.exchange), ['Kraken', 'Mystery Exchange', 'Gate']);
  assert.deepEqual(w.cex.map((v) => v.usAccess), ['serves_us', 'unknown', 'restricts_us']);
  assert.deepEqual(w.dex.map((v) => v.exchange), ['PancakeSwap v3 (BSC)']);
  assert.deepEqual(w.dex[0]!.pairs, ['AKE/token']);
  assert.deepEqual(w.contracts, ['0x2c3a8Ee94dDD97244a93Bc48298f97d2C412F7Db']);
  assert.equal(w.dropped, 1);
});

test('parseTickers rejects a response without a tickers list', () => {
  assert.throws(() => parseTickers({ error: 'x' }, 'X'));
});

test('offline: where-to-buy uses the TEST DATA fixture, makes zero requests, and drops unsafe links', async () => {
  const f = counting();
  const env = { COINGECKO_DEMO_API_KEY: KEY };
  const svc = createScanService({ env, fetch: f.fn, clock: () => NOW, sleep: async () => {} }, 160);
  await handleRequest(post('/api/scan/crypto', { mode: 'offline' }), svc, env, PORT);
  const scan = JSON.parse((await handleRequest(post('/api/scan/crypto', { mode: 'offline' }), svc, env, PORT)).body);
  const key = scan.rows[0].key;
  const r = await handleRequest(post('/api/where-to-buy/crypto', { key }), svc, env, PORT);
  assert.equal(r.status, 200, r.body);
  const d = JSON.parse(r.body);
  assert.equal(d.dataKind, 'test_data');
  assert.equal(d.requestsUsed, 0);
  assert.equal(f.urls.length, 0);
  assert.ok(!d.result.cex.some((v: { exchange: string }) => v.exchange === 'Example Stale Exchange'));
  assert.equal(d.result.cex.find((v: { identifier: string }) => v.identifier === 'example_small').tradeUrl, null);
});

test('live: needs confirmation, then exactly one CoinGecko request; the second open is served from cache', async () => {
  // A live scan needs a market list and histories; give the mock a tiny universe.
  const coin = { id: 'akedo', symbol: 'ake', name: 'Akedo', current_price: 0.03, market_cap: 6e8, total_volume: 2e7, price_change_percentage_24h: 1, price_change_percentage_7d_in_currency: 2, last_updated: '2026-10-21T11:57:00.000Z' };
  const chart = { total_volumes: Array.from({ length: 91 }, (_, i) => [Date.UTC(2026, 9, 21) - (91 - i) * DAY_MS, 20e6]) };
  const f = counting((url) => ({ status: 200, body: url.includes('/coins/markets') ? [coin] : url.includes('/tickers') ? REAL_SHAPE : chart }));
  const env = { COINGECKO_DEMO_API_KEY: KEY };
  const svc = createScanService({ env, fetch: f.fn, clock: () => NOW, sleep: async () => {} }, 160, {}, {}, {}, { minIntervalMs: 0 });
  const scan = await handleRequest(post('/api/scan/crypto', { mode: 'live', maxRequests: 2, confirmLive: true }), svc, env, PORT);
  assert.equal(scan.status, 200, scan.body);
  const before = f.urls.length;
  const unconfirmed = await handleRequest(post('/api/where-to-buy/crypto', { key: 'crypto:akedo' }), svc, env, PORT);
  assert.equal(unconfirmed.status, 428);
  assert.equal(f.urls.length, before);
  const r = await handleRequest(post('/api/where-to-buy/crypto', { key: 'crypto:akedo', confirmLive: true }), svc, env, PORT);
  assert.equal(r.status, 200, r.body);
  assert.equal(f.urls.length, before + 1);
  assert.match(f.urls.at(-1)!, /\/coins\/akedo\/tickers\?/);
  assert.ok(!f.urls.at(-1)!.includes(KEY));
  const d = JSON.parse(r.body);
  assert.equal(d.result.cex[0].exchange, 'Kraken');
  assert.equal(d.coingeckoPage, 'https://www.coingecko.com/en/coins/akedo');
  const again = JSON.parse((await handleRequest(post('/api/where-to-buy/crypto', { key: 'crypto:akedo' }), svc, env, PORT)).body);
  assert.equal(again.fromCache, true);
  assert.equal(f.urls.length, before + 1);
});

test('stocks: no request, and a key from another market is refused', async () => {
  const f = counting();
  const env = {};
  const svc = createScanService({ env, fetch: f.fn, clock: () => NOW, sleep: async () => {} }, 160);
  const scan = JSON.parse((await handleRequest(post('/api/scan/stocks', { mode: 'offline' }), svc, env, PORT)).body);
  const key = scan.rows[0].key;
  const r = JSON.parse((await handleRequest(post('/api/where-to-buy/stocks', { key }), svc, env, PORT)).body);
  assert.equal(r.ok, true);
  assert.equal(r.requestsUsed, 0);
  assert.equal(f.urls.length, 0);
  const wrong = await handleRequest(post('/api/where-to-buy/crypto', { key }), svc, env, PORT);
  assert.equal(wrong.status, 400);
});
