import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.fetch = (() => {
  throw new Error('Network access is not allowed in tests.');
}) as typeof fetch;

test('top 500: marketPages 2 requests page 2, merges new coins and skips duplicates; a page-2 failure keeps page 1 with a note', async () => {
  const { createHttpClient } = await import('../src/providers/http.ts');
  const { fetchLiveDataset } = await import('../src/providers/coingecko.ts');
  const row = (id: string) => ({ id, symbol: id.slice(0, 4), name: `Coin ${id}`, current_price: 1, market_cap: 1e9, total_volume: 1e8, price_change_percentage_24h: 1, price_change_percentage_7d_in_currency: 1, last_updated: '2026-10-21T11:59:00Z' });
  const run = async (page2: 'ok' | 'fail') => {
    const urls: string[] = [];
    const fetch = async (url: string) => {
      urls.push(url);
      const p2 = /[?&]page=2(&|$)/.test(url);
      if (p2 && page2 === 'fail') return { ok: false, status: 500, headers: { get: () => null }, text: async () => '{}' };
      const body = url.includes('/coins/markets') ? (p2 ? [row('dup-one'), row('page-two')] : [row('dup-one')]) : { total_volumes: [] };
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
    };
    const client = createHttpClient({ fetch, baseUrl: 'https://api.example.test/api/v3', apiKeyHeader: 'x-cg-demo-api-key', apiKey: 'TEST-KEY-not-real', maxCalls: 2, sleep: async () => {} });
    const data = await fetchLiveDataset({ client, clock: () => new Date('2026-10-21T12:00:00Z'), maxCalls: 2, sleep: async () => {}, marketPages: 2 });
    return { urls, data };
  };
  const ok = await run('ok');
  assert.deepEqual(ok.data.assets.map((a: { id: string }) => a.id), ['dup-one', 'page-two']);
  assert.match(ok.urls[1]!, /[?&]page=2(&|$)/);
  const bad = await run('fail');
  assert.deepEqual(bad.data.assets.map((a: { id: string }) => a.id), ['dup-one']);
  assert.ok(bad.data.dataset.notes.some((n: string) => /^Market page 2 \(coins ranked 251-500\) could not be used \(HTTP 500\)/.test(n)));
});
