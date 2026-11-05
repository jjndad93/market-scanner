import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { type FetchLike, createHttpClient } from '../src/providers/http.ts';
import { fetchMarketMovers } from '../src/providers/massive.ts';
import {
  REFERENCE_MAX_AGE_MS, classifyTicker, gearing, loadTickerReference, parseTickerPage, readCachedReference, writeCachedReference, type TickerReference,
} from '../src/providers/massive-tickers.ts';
import { runStockScanCommand } from '../src/stocks/command.ts';
import { DAY_MS } from '../src/core/time.ts';

globalThis.fetch = (() => {
  throw new Error('Network access is not allowed in tests.');
}) as typeof fetch;

// SYNTHETIC reference data in the documented /v3/reference/tickers shape. Invented tickers and names.
const KEY = 'TEST-TICKERS-KEY-not-real-6060';
const NOW = new Date('2026-10-24T14:00:00Z'); // Saturday; latest sessions Fri 10-23 and Thu 10-22
const ref = (rows: [string, string, string][], complete = true): TickerReference => ({ fetchedAt: NOW.toISOString(), complete, tickers: new Map(rows.map(([t, n, ty]) => [t, { name: n, type: ty }])) });

test('gearing: leveraged and inverse funds are recognised by name; ordinary and short-term bond funds are not', () => {
  for (const n of ['Direxion Daily Semiconductor Bull 3X Shares', 'ProShares UltraPro QQQ', 'Tradr 2X Long NVDA Daily ETF', 'ProShares Ultra Bloomberg Crude Oil', 'GraniteShares 1.5x Long COIN Daily ETF']) assert.equal(gearing(n), 'leveraged', n);
  for (const n of ['Direxion Daily Semiconductor Bear 3X Shares', 'ProShares Short QQQ', 'T-Rex 2X Inverse TSLA Daily Target ETF', 'ProShares UltraShort Bitcoin ETF']) assert.equal(gearing(n), 'inverse', n);
  for (const n of ['SPDR S&P 500 ETF Trust', 'Invesco QQQ Trust', 'Vanguard Short-Term Bond ETF', 'iShares Short Treasury Bond ETF', 'Example Short Duration Income Fund']) assert.equal(gearing(n), null, n);
});

test('classifyTicker: common stock and ADRs kept; ETFs kept and labelled; leveraged/inverse ETFs, warrants and units left out', () => {
  const r = ref([['AAA', 'Alpha Corp', 'CS'], ['BBB', 'Beta ADR', 'ADRC'], ['IDX', 'Example Index ETF', 'ETF'], ['LEV', 'Example Daily Bull 3X Shares', 'ETF'],
    ['INV', 'Example Inverse Fund', 'ETN'], ['AAAW', 'Alpha Corp Warrant', 'WARRANT'], ['SPCU', 'Example Acquisition Unit', 'UNIT'], ['PRF', 'Alpha Pref', 'PFD']]);
  assert.deepEqual([classifyTicker('AAA', r).keep, classifyTicker('AAA', r).security.label, classifyTicker('AAA', r).name], [true, 'Common stock', 'Alpha Corp']);
  assert.equal(classifyTicker('BBB', r).security.kind, 'adr');
  assert.deepEqual([classifyTicker('IDX', r).keep, classifyTicker('IDX', r).security.label], [true, 'ETF']);
  assert.deepEqual([classifyTicker('LEV', r).keep, classifyTicker('LEV', r).reason], [false, 'leveraged ETF/ETN']);
  assert.deepEqual([classifyTicker('INV', r).keep, classifyTicker('INV', r).reason], [false, 'inverse ETF/ETN']);
  assert.deepEqual([classifyTicker('AAAW', r).keep, classifyTicker('AAAW', r).reason], [false, 'warrant']);
  assert.deepEqual([classifyTicker('SPCU', r).keep, classifyTicker('SPCU', r).reason], [false, 'unit']);
  assert.equal(classifyTicker('PRF', r).keep, false);
  assert.deepEqual([classifyTicker('ZZZ', r).keep, classifyTicker('ZZZ', r).security.label], [true, 'Type unknown']); // not in the list: kept, labelled
  assert.deepEqual([classifyTicker('AAA', null).keep, classifyTicker('AAA', null).security.label], [true, 'Type not checked']);
});

test('parseTickerPage: follows only Massive\'s own next_url, takes just the cursor, skips malformed rows', () => {
  const ok = parseTickerPage({ results: [{ ticker: 'AAA', name: 'Alpha\u0007 Corp', type: 'CS' }, { ticker: 'bad ticker', type: 'CS' }, { ticker: 'BBB' }], next_url: 'https://api.massive.com/v3/reference/tickers?cursor=abc123&apiKey=SHOULD-NOT-BE-USED' });
  assert.deepEqual(ok.entries, [['AAA', { name: 'Alpha Corp', type: 'CS' }]]);
  assert.equal(ok.cursor, 'abc123');
  assert.equal(parseTickerPage({ results: [], next_url: 'https://evil.example.com/v3/reference/tickers?cursor=x' }).cursor, null);
  assert.equal(parseTickerPage({ results: [], next_url: 'https://api.massive.com/v2/other?cursor=x' }).cursor, null);
  assert.throws(() => parseTickerPage({ results: 'x' }));
});

test('reference cache: written only when complete, reused for 7 days, then stale; corrupt files are a miss', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tickers-cache-'));
  try {
    assert.equal(writeCachedReference(dir, ref([['AAA', 'Alpha', 'CS']], false)), false);
    assert.equal(readCachedReference(dir, NOW), null);
    assert.equal(writeCachedReference(dir, ref([['AAA', 'Alpha', 'CS']])), true);
    assert.equal(readCachedReference(dir, new Date(NOW.getTime() + DAY_MS))?.tickers.get('AAA')?.type, 'CS');
    assert.equal(readCachedReference(dir, new Date(NOW.getTime() + REFERENCE_MAX_AGE_MS + 1)), null);
    const [file] = readdirSync(dir);
    assert.ok(!file!.includes('AAA'));
    writeFileSync(join(dir, file!), '{not json');
    assert.equal(readCachedReference(dir, NOW), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function client(answer: (url: string) => { status: number; body: unknown }, maxCalls = 50) {
  const urls: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    urls.push(url);
    assert.equal(init?.headers?.authorization, `Bearer ${KEY}`); // key in a header only
    const a = answer(url);
    return { ok: a.status < 300, status: a.status, headers: { get: () => null }, text: async () => JSON.stringify(a.body) };
  };
  return { urls, c: createHttpClient({ fetch, baseUrl: 'https://api.massive.com', apiKeyHeader: 'authorization', apiKey: `Bearer ${KEY}`, maxCalls, sleep: async () => {} }) };
}

test('loadTickerReference: pages through next_url, caches a complete list, and reuses it without a request', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tickers-load-'));
  try {
    const pages = [
      { results: [{ ticker: 'AAA', name: 'Alpha', type: 'CS' }], next_url: 'https://api.massive.com/v3/reference/tickers?cursor=p2' },
      { results: [{ ticker: 'LEV', name: 'Example Daily Bull 2X Shares', type: 'ETF' }] },
    ];
    let i = 0;
    const a = client(() => ({ status: 200, body: pages[i++] }));
    const r = await loadTickerReference({ client: a.c, clock: () => NOW, maxCalls: 50, reserve: 18, cacheDir: dir, minIntervalMs: 0, sleep: async () => {} });
    assert.equal(r.requestsUsed, 2);
    assert.equal(r.ref?.tickers.size, 2);
    assert.match(a.urls[1]!, /cursor=p2/);
    assert.ok(a.urls.every((u) => !u.includes(KEY)));
    assert.match(r.note, /refreshed \(2 active tickers, 2 request\(s\)\); cached for 7 days/);
    const b = client(() => { throw new Error('must not request'); });
    const again = await loadTickerReference({ client: b.c, clock: () => NOW, maxCalls: 50, reserve: 18, cacheDir: dir, minIntervalMs: 0, sleep: async () => {} });
    assert.equal(again.requestsUsed, 0);
    assert.match(again.note, /cached, refreshed weekly; no request made/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadTickerReference: no room in the request limit, or a failure, leaves types unchecked and the scan going', async () => {
  const tight = client(() => { throw new Error('must not request'); }, 19);
  const r1 = await loadTickerReference({ client: tight.c, clock: () => NOW, maxCalls: 19, reserve: 18, cacheDir: null, minIntervalMs: 0, sleep: async () => {} });
  assert.equal(r1.ref, null);
  assert.match(r1.note, /not checked: the request limit leaves no room/);
  const failing = client(() => ({ status: 500, body: {} }));
  const r2 = await loadTickerReference({ client: failing.c, clock: () => NOW, maxCalls: 50, reserve: 18, cacheDir: null, minIntervalMs: 0, sleep: async () => {} });
  assert.equal(r2.ref, null);
  assert.match(r2.note, /request failed \(HTTP 500\)/);
});

const bar = (T: string, c: number, v: number) => ({ T, c, v, o: c, h: c, l: c, t: 0 });
const DAYS: Record<string, unknown[]> = {
  // SYNTHETIC: LIQ traded $20M+ on both days; SPIKE only on the latest; LEVX is a leveraged ETF; WRNTW a warrant.
  '2026-10-22': [bar('LIQ', 10, 3e6), bar('SPIKE', 10, 1e5), bar('LEVX', 20, 2e6), bar('WRNTW', 10, 5e6), bar('ETFA', 40, 1e6)],
  '2026-10-23': [bar('LIQ', 11, 3e6), bar('SPIKE', 15, 4e6), bar('LEVX', 30, 2e6), bar('WRNTW', 14, 5e6), bar('ETFA', 41, 1e6)],
};
const REF = { results: [
  { ticker: 'LIQ', name: 'Liquid Example Inc', type: 'CS' }, { ticker: 'SPIKE', name: 'Spike Example Inc', type: 'CS' },
  { ticker: 'LEVX', name: 'Example Daily Bull 3X Shares', type: 'ETF' }, { ticker: 'WRNTW', name: 'Example Warrant', type: 'WARRANT' }, { ticker: 'ETFA', name: 'Example Broad Market ETF', type: 'ETF' },
] };

test('movers: previous-day liquidity first, then one-day spikes; excluded security types never take a slot', async () => {
  const a = client((url) => ({ status: 200, body: { results: DAYS[/stocks\/([\d-]+)/.exec(url)![1]!] ?? [] } }));
  const r = ref(REF.results.map((x) => [x.ticker, x.name, x.type] as [string, string, string]));
  const m = await fetchMarketMovers({ client: a.c, clock: () => NOW, maxCalls: 10, sleep: async () => {}, limits: { count: 3 },
    securityFilter: (t) => { const c = classifyTicker(t, r); return c.keep ? null : c.reason; } });
  // SPIKE gained most (+50%) but traded under $20M the day before, so LIQ (+10%) and the ordinary ETF
  // ETFA (+2.5%), both liquid the day before, take the first slots; SPIKE fills the last one.
  assert.deepEqual(m.tickers, ['LIQ', 'ETFA', 'SPIKE']);
  assert.match(m.notes[1]!, /picked first \(2 of 3\); 1 one-day spike\(s\) filled the remaining slots/);
  assert.match(m.notes[2]!, /Left out before evaluation: .*leveraged ETF\/ETN: 1 \(LEVX\).*warrant: 1 \(WRNTW\)|Left out before evaluation: .*warrant: 1 \(WRNTW\).*leveraged ETF\/ETN: 1 \(LEVX\)/);
});

test('scan stocks --live --movers: names and security types reach the result; scores are untouched', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tickers-e2e-'));
  try {
    const hist = { results: Array.from({ length: 30 }, (_, i) => ({ t: Date.parse('2026-10-23T04:00:00Z') - (29 - i) * DAY_MS, c: 10 + i * 0.05, v: 5e6, o: 10, h: 12, l: 9 })) };
    const urls: string[] = [];
    const fetch: FetchLike = async (url) => {
      urls.push(url);
      const body = url.includes('/v3/reference/tickers') ? REF : url.includes('/grouped/') ? { results: DAYS[/stocks\/([\d-]+)/.exec(url)![1]!] ?? [] } : hist;
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
    };
    const out: string[] = [], err: string[] = [];
    const deps = { env: { POLYGON_API_KEY: KEY, LOCALAPPDATA: dir }, fetch, clock: () => NOW, sleep: async () => {}, out: (t: string) => out.push(t), err: (t: string) => err.push(t) };
    assert.equal(await runStockScanCommand(['--live', '--movers', '--json'], deps), 0, err.join('\n'));
    const result = JSON.parse(out.join('\n'));
    const all = [...result.movers, ...result.watchlist, ...result.belowThreshold].map((c: { stock: { symbol: string; name: string; security: { label: string } } }) => c.stock)
      .concat(result.noPattern.map((x: { stock: unknown }) => x.stock));
    const bySym = Object.fromEntries(all.map((s: { symbol: string }) => [s.symbol, s]));
    assert.equal(bySym.LIQ?.name, 'Liquid Example Inc');
    assert.equal(bySym.LIQ?.security.label, 'Common stock');
    assert.ok(!('LEVX' in bySym) && !('WRNTW' in bySym));
    assert.ok(urls.every((u) => !u.includes(KEY)));
    assert.ok(!out.join('').includes(KEY));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
