import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DAY_MS } from '../src/core/time.ts';
import { type FetchLike, createHttpClient } from '../src/providers/http.ts';
import { fetchMarketMovers, parseGroupedDaily } from '../src/providers/massive.ts';
import { runStockScanCommand } from '../src/stocks/command.ts';

globalThis.fetch = (() => {
  throw new Error('Network access is not allowed in tests.');
}) as typeof fetch;

const KEY = 'TEST-MOVERS-KEY-not-real-5150';
// Saturday 2026-10-24, 10:00 New York: the latest sessions are Fri 10-23 and Thu 10-22.
const NOW = new Date('2026-10-24T14:00:00Z');
const bar = (T: string, c: number, v: number, extra: Record<string, unknown> = {}) => ({ T, c, v, o: c, h: c, l: c, t: 0, ...extra });

// SYNTHETIC market: prices on Thu 10-22 and Fri 10-23 (Wed 10-21 is a pretend holiday: no results).
const DAYS: Record<string, unknown[]> = {
  '2026-10-22': [bar('UPBIG', 10, 9e6), bar('UPSM', 20, 2e6), bar('DOWN', 30, 2e6), bar('PRICEY', 100, 1e6), bar('THIN', 8, 1e5), bar('WARRW', 1, 1e8), bar('OTCX', 9, 9e6, { otc: true })],
  '2026-10-23': [bar('UPBIG', 12, 9e6), bar('UPSM', 21, 2e6), bar('DOWN', 27, 2e6), bar('PRICEY', 130, 1e6), bar('THIN', 12, 1e5), bar('WARRW', 2, 1e8), bar('OTCX', 18, 9e6, { otc: true })],
};

function mock(days: Record<string, unknown[]> = DAYS) {
  const urls: string[] = [];
  const fn: FetchLike = async (url) => {
    urls.push(url);
    const grouped = /\/grouped\/locale\/us\/market\/stocks\/(\d{4}-\d{2}-\d{2})/.exec(url);
    const body = grouped
      ? { status: 'OK', results: days[grouped[1]!] ?? [] }
      : { status: 'OK', results: Array.from({ length: 30 }, (_, i) => ({ t: Date.parse('2026-10-23T04:00:00Z') - (29 - i) * DAY_MS, c: 10 + i * 0.05, v: 5e6 })) };
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };
  return { fn, urls };
}

test('parseGroupedDaily keeps plain listed stocks with a usable close and volume; OTC is skipped', () => {
  const m = parseGroupedDaily({ results: [bar('AAA', 5, 10), bar('BBB', -1, 10), bar('CCC', 5, 10, { otc: true }), { T: 'DDD' }] });
  assert.deepEqual([...m.keys()], ['AAA']);
  assert.throws(() => parseGroupedDaily({ results: 'x' }));
});

test('movers: skips the weekend without a request, finds two sessions, filters by price, dollar volume and ticker shape, gainers first', async () => {
  const f = mock();
  const client = createHttpClient({ fetch: f.fn, baseUrl: 'https://api.example.test', apiKeyHeader: 'authorization', apiKey: `Bearer ${KEY}`, maxCalls: 10, sleep: async () => {} });
  const r = await fetchMarketMovers({ client, clock: () => NOW, maxCalls: 10, sleep: async () => {} });
  assert.deepEqual(f.urls.map((u) => /stocks\/([\d-]+)/.exec(u)?.[1]), ['2026-10-23', '2026-10-22']); // Saturday not requested
  assert.deepEqual(r.sessions, ['2026-10-23', '2026-10-22']);
  // UPBIG +20%, UPSM +5%; DOWN fell; PRICEY > $50; THIN < $20M traded; WARRW is not a plain ticker; OTCX is OTC.
  assert.deepEqual(r.tickers, ['UPBIG', 'UPSM']);
  assert.match(r.notes[0]!, /3 were priced \$5-\$50 with at least \$20M traded; the 2 biggest gainers were evaluated/);
  assert.ok(f.urls.every((u) => !u.includes(KEY)));
});

test('movers: a holiday with no results is skipped and the next session is used', async () => {
  const f = mock({ '2026-10-23': DAYS['2026-10-23']!, '2026-10-21': DAYS['2026-10-22']! });
  const client = createHttpClient({ fetch: f.fn, baseUrl: 'https://api.example.test', apiKeyHeader: 'authorization', apiKey: `Bearer ${KEY}`, maxCalls: 10, sleep: async () => {} });
  const r = await fetchMarketMovers({ client, clock: () => NOW, maxCalls: 10, sleep: async () => {} });
  assert.deepEqual(r.sessions, ['2026-10-23', '2026-10-21']);
  assert.equal(r.requestsUsed, 3);
});

test('scan stocks --live --movers evaluates the gainers end to end; --movers needs --live', async () => {
  const f = mock();
  const out: string[] = [], err: string[] = [];
  const deps = { env: { POLYGON_API_KEY: KEY }, fetch: f.fn, clock: () => NOW, sleep: async () => {}, out: (t: string) => out.push(t), err: (t: string) => err.push(t) };
  assert.equal(await runStockScanCommand(['--live', '--movers', '--json'], deps), 0, err.join('\n'));
  const result = JSON.parse(out.join('\n'));
  assert.equal(result.universe, 2);
  assert.match(result.dataset.label, /market-wide movers/);
  assert.ok(result.dataset.notes[0].startsWith('Market-wide movers:'));
  assert.equal(f.urls.length, 4); // 2 market summaries + 2 gainers
  assert.ok(!out.join('').includes(KEY));
  const e2: string[] = [];
  assert.equal(await runStockScanCommand(['--movers'], { ...deps, err: (t: string) => e2.push(t) }), 1);
  assert.match(e2.join(''), /--movers is only for live scans/);
});
