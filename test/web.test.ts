import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DAY_MS } from '../src/core/time.ts';
import type { FetchLike } from '../src/providers/http.ts';
import { type WebRequest, WEB_HOST, createScanService, handleRequest, parsePort, redactSecrets, validateScanRequest } from '../src/web/server.ts';

// Network guard: the handler is exercised directly (no sockets); live scans use a mock fetch only.
globalThis.fetch = (() => {
  throw new Error('Network access is not allowed in tests.');
}) as typeof fetch;

const PORT = 4173;
const KEY = 'TEST-WEB-KEY-not-real-4242';
const NOW = new Date('2026-10-21T12:00:00Z');
const HOST = { host: `${WEB_HOST}:${PORT}` };
const POST_HEADERS = { ...HOST, 'content-type': 'application/json', 'x-market-scanner': '1' };

function counting(answer?: (url: string) => { status: number; body?: unknown; headers?: Record<string, string> }) {
  const urls: string[] = [];
  const fn: FetchLike = async (url) => {
    urls.push(url);
    if (!answer) throw new Error('fetch must not be called');
    const a = answer(url);
    return { ok: a.status < 300, status: a.status, headers: { get: (h: string) => a.headers?.[h.toLowerCase()] ?? null }, text: async () => JSON.stringify(a.body ?? {}) };
  };
  return { fn, urls };
}
const service = (fetch: FetchLike, env: Record<string, string> = {}, cap = 160) => ({ svc: createScanService({ env, fetch, clock: () => NOW, sleep: async () => {} }, cap), env });
const req = (method: string, url: string, headers: Record<string, string | undefined> = HOST, body = ''): WebRequest => ({ method, url, headers, body });
const post = (body: unknown, headers: Record<string, string | undefined> = POST_HEADERS) => req('POST', '/api/scan/crypto', headers, typeof body === 'string' ? body : JSON.stringify(body));
const parse = (r: { body: string }) => JSON.parse(r.body);

test('offline scan through the web API returns the real scanner result, labelled as test data, with zero requests', async () => {
  const f = counting();
  const { svc, env } = service(f.fn, { COINGECKO_DEMO_API_KEY: KEY });
  const r = await handleRequest(post({ mode: 'offline' }), svc, env, PORT);
  assert.equal(r.status, 200);
  assert.equal(f.urls.length, 0);
  const data = parse(r);
  assert.equal(data.ok, true);
  assert.equal(data.result.dataset.kind, 'synthetic');
  assert.deepEqual(data.result.scan.qualifiedNames, ['SALP', 'SBRV', 'SECH', 'SDLT']); // the scanner's own output, not a hardcoded list
  assert.equal(data.result.scan.status, 'complete');
  assert.match(data.result.scan.freshness, /^synthetic test data/);
  assert.equal(data.exclusionLabels.insufficient_history, 'too little history'); // the CLI report's own wording
  assert.ok(!r.body.includes(KEY));
});

test('live scan: the request budget is validated server-side and enforced by the existing client (retries included)', async () => {
  // Mock provider: three eligible coins with steady 91-day histories.
  const coin = (id: string) => ({ id, symbol: id.slice(4), name: `Synthetic ${id}`, current_price: 5, market_cap: 1e9, total_volume: 50e6, price_change_percentage_24h: 0.5, price_change_percentage_7d_in_currency: 1, last_updated: '2026-10-21T11:57:00.000Z' });
  const chart = { total_volumes: Array.from({ length: 91 }, (_, i) => [Date.UTC(2026, 9, 21) - (91 - i) * DAY_MS, 20e6]) };
  const f = counting((url) => ({ status: 200, body: url.includes('/coins/markets') ? ['syn-a', 'syn-b', 'syn-c'].map(coin) : chart }));
  const { svc, env } = service(f.fn, { COINGECKO_DEMO_API_KEY: KEY });
  const r = await handleRequest(post({ mode: 'live', maxRequests: 2, confirmLive: true }), svc, env, PORT);
  assert.equal(r.status, 200, r.body);
  assert.equal(f.urls.length, 2); // 1 market list + 1 history: the budget held
  const data = parse(r);
  assert.equal(data.result.dataset.coverage.requestsUsed, 2);
  assert.equal(data.result.scan.status, 'partial');
  assert.match(data.result.scan.nextStep, /larger --max-requests/);
  assert.ok(!r.body.includes(KEY));

  // A 429 retry counts toward the same budget: with a budget of 1 the retry is refused and the scan fails.
  const limited = counting(() => ({ status: 429, headers: { 'retry-after': '0' } }));
  const one = service(limited.fn, { COINGECKO_DEMO_API_KEY: KEY });
  const rl = await handleRequest(post({ mode: 'live', maxRequests: 1, confirmLive: true }), one.svc, one.env, PORT);
  assert.equal(limited.urls.length, 1);
  assert.equal(rl.status, 422);
  assert.match(parse(rl).error, /Live scan failed.*the retry was not sent because the call budget of 1 requests was reached/s);
});

test('invalid requests are rejected before any provider request', async () => {
  const f = counting();
  const { svc, env } = service(f.fn, { COINGECKO_DEMO_API_KEY: KEY }, 50);
  const bad: [unknown, RegExp][] = [
    [{ mode: 'live', maxRequests: 5 }, /must be confirmed/],
    [{ mode: 'live', maxRequests: 0, confirmLive: true }, /whole number from 1 to 50/],
    [{ mode: 'live', maxRequests: 51, confirmLive: true }, /whole number from 1 to 50/], // the server cap, not the browser's value
    [{ mode: 'live', maxRequests: 2.5, confirmLive: true }, /whole number/],
    [{ mode: 'live', maxRequests: '5; rm -rf /', confirmLive: true }, /whole number/], // strings never reach the arguments
    [{ mode: 'shell' }, /mode must be/],
    ['not json', /must be JSON/],
    ['x'.repeat(2000), /too large/],
  ];
  for (const [body, expect] of bad) {
    const r = await handleRequest(post(body), svc, env, PORT);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 60));
    assert.match(parse(r).error, expect);
  }
  assert.equal(f.urls.length, 0);
  assert.deepEqual(validateScanRequest(JSON.stringify({ mode: 'live', maxRequests: 7, confirmLive: true, extra: 'ignored' }), 160), { mode: 'live', maxRequests: 7 });
});

test('cross-site and rebinding protection: wrong host, missing header, foreign origin, wrong method', async () => {
  const f = counting();
  const { svc, env } = service(f.fn, { COINGECKO_DEMO_API_KEY: KEY });
  const cases: [WebRequest, number][] = [
    [post({ mode: 'offline' }, { ...POST_HEADERS, host: 'evil.example:4173' }), 403],
    [post({ mode: 'offline' }, { ...POST_HEADERS, 'x-market-scanner': undefined }), 403],
    [post({ mode: 'offline' }, { ...POST_HEADERS, 'content-type': 'text/plain' }), 403],
    [post({ mode: 'offline' }, { ...POST_HEADERS, origin: 'http://evil.example' }), 403],
    [req('GET', '/api/scan/crypto'), 405],
    [req('GET', '/', { host: 'attacker.test' }), 403],
  ];
  for (const [r, status] of cases) assert.equal((await handleRequest(r, svc, env, PORT)).status, status, `${r.method} ${r.url} ${JSON.stringify(r.headers)}`);
  assert.equal((await handleRequest(post({ mode: 'offline' }, { ...POST_HEADERS, origin: `http://localhost:${PORT}`, host: `localhost:${PORT}` }), svc, env, PORT)).status, 200);
  assert.equal(f.urls.length, 0);
});

test('only the fixed static files are served; no path reaches the disk; security headers are set', async () => {
  const { svc, env } = service(counting().fn);
  for (const path of ['/', '/index.html', '/app.js', '/styles.css', '/budget.js', '/simple-view.js']) {
    const r = await handleRequest(req('GET', path), svc, env, PORT);
    assert.equal(r.status, 200, path);
    assert.match(r.headers['content-security-policy']!, /default-src 'self'; script-src 'self'/);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
  }
  for (const path of ['/../package.json', '/src/web/server.ts', '/%2e%2e/README.md', '/public/app.js', '/.env', '/api/run?cmd=dir']) {
    assert.equal((await handleRequest(req('GET', path), svc, env, PORT)).status, 404, path);
  }
});

test('one scan at a time: an overlapping request is refused while the first runs', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const coin = { id: 'syn-a', symbol: 'a', name: 'Synthetic a', current_price: 5, market_cap: 1e9, total_volume: 50e6, price_change_percentage_24h: 0.5, price_change_percentage_7d_in_currency: 1, last_updated: '2026-10-21T11:57:00.000Z' };
  let calls = 0;
  const slow: FetchLike = async () => {
    calls++;
    await gate; // hold the first scan open
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify([coin]) };
  };
  const { svc, env } = service(slow, { COINGECKO_DEMO_API_KEY: KEY });
  const first = handleRequest(post({ mode: 'live', maxRequests: 1, confirmLive: true }), svc, env, PORT);
  await new Promise((r) => setImmediate(r));
  assert.equal(svc.running, true);
  const second = await handleRequest(post({ mode: 'offline' }), svc, env, PORT);
  assert.equal(second.status, 409);
  assert.match(parse(second).error, /already running/);
  const status = parse(await handleRequest(req('GET', '/api/status'), svc, env, PORT));
  assert.equal(status.running, true);
  release();
  assert.equal((await first).status, 200);
  assert.equal(svc.running, false);
  assert.equal(calls, 1); // the refused scan made no request
});

test('missing key and provider errors come back as actionable messages, never with the key', async () => {
  const none = service(counting().fn, {});
  const r = await handleRequest(post({ mode: 'live', maxRequests: 5, confirmLive: true }), none.svc, none.env, PORT);
  assert.equal(r.status, 422);
  assert.match(parse(r).error, /COINGECKO_DEMO_API_KEY.*No request was made\.\nNext step: set it once/s);
  const rejected = counting(() => ({ status: 401 }));
  const s = service(rejected.fn, { COINGECKO_DEMO_API_KEY: KEY });
  const r401 = await handleRequest(post({ mode: 'live', maxRequests: 5, confirmLive: true }), s.svc, s.env, PORT);
  assert.equal(rejected.urls.length, 1);
  assert.match(parse(r401).error, /Next step: CoinGecko rejected the API key \(HTTP 401\)/);
  assert.ok(!r401.body.includes(KEY));
  assert.equal(redactSecrets(`a ${KEY} b`, { COINGECKO_DEMO_API_KEY: KEY }), 'a [REDACTED] b');
});

test('status reports key presence only; frontend assets never contain or request secrets', async () => {
  const { svc, env } = service(counting().fn, { COINGECKO_DEMO_API_KEY: KEY });
  const st = await handleRequest(req('GET', '/api/status'), svc, env, PORT);
  assert.deepEqual(parse(st), { ok: true, running: false, maxRequestsCap: 160, defaultMaxRequests: 5, cryptoKeyConfigured: true, stocksKeyConfigured: false, newsDefaultLimit: 5, newsMaxLimit: 20, cmcKeyConfigured: false });
  assert.ok(!st.body.includes(KEY));
  for (const file of ['index.html', 'app.js', 'styles.css', 'budget.js', 'simple-view.js']) {
    const text = readFileSync(new URL(`../src/web/public/${file}`, import.meta.url), 'utf8');
    // The page may NAME the variable (to tell the user to set it) but never sends provider credentials.
    assert.doesNotMatch(text, /x-cg-demo-api-key|authorization|Bearer /i, file);
    assert.ok(!text.includes(KEY), file);
    const real = process.env.COINGECKO_DEMO_API_KEY?.trim();
    if (real) assert.ok(!text.includes(real), `${file} must not contain a real key`);
    assert.doesNotMatch(text, /innerHTML|eval\(|new Function/, `${file}: no HTML injection or dynamic code`);
  }
  assert.deepEqual([parsePort([]), parsePort(['--port', '5000']), parsePort(['--port', '80']), parsePort(['--port', 'x'])], [4173, 5000, null, null]);
});
