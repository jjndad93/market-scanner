import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type FetchLike, HttpError, createHttpClient, parseRetryAfter } from '../src/providers/http.ts';

// Network guard: these tests use injected mock fetch functions only.
globalThis.fetch = (() => {
  throw new Error('Network access is not allowed in tests.');
}) as typeof fetch;

const KEY = 'TEST-KEY-not-real-1234567890';
type Reply = { status: number; body?: string; headers?: Record<string, string> };
const reply = (r: Reply) => ({
  ok: r.status >= 200 && r.status < 300,
  status: r.status,
  headers: { get: (n: string) => r.headers?.[n.toLowerCase()] ?? null },
  text: async () => r.body ?? '',
});

/** A mock fetch that answers from a script and records every call. */
function mockFetch(script: (Reply | 'throw' | 'hang')[]) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fn: FetchLike = (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} });
    const next = script[calls.length - 1] ?? { status: 500 };
    if (next === 'throw') return Promise.reject(new TypeError(`fetch failed for ${url} with ${KEY}`));
    if (next === 'hang') {
      return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    }
    return Promise.resolve(reply(next));
  };
  return { fn, calls };
}
const client = (fetch: FetchLike, extra: Partial<Parameters<typeof createHttpClient>[0]> = {}) =>
  createHttpClient({ fetch, baseUrl: 'https://api.example.test/v3', apiKeyHeader: 'x-cg-demo-api-key', apiKey: KEY, maxCalls: 5, sleep: async () => {}, ...extra });
const expectError = async (p: Promise<unknown>, kind: string) => {
  const err = await p.then(() => null, (e: unknown) => e);
  assert.ok(err instanceof HttpError, `expected HttpError, got ${String(err)}`);
  assert.equal(err.kind, kind);
  assert.ok(!err.message.includes(KEY), 'the key must never appear in an error');
  return err;
};

test('sends the key only in the header, never in the URL; params are sorted and encoded', async () => {
  const m = mockFetch([{ status: 200, body: '{"ok":true}' }]);
  assert.deepEqual(await client(m.fn).getJson('/coins/markets', { vs_currency: 'usd', b: 'x y' }), { ok: true });
  assert.equal(m.calls[0]!.url, 'https://api.example.test/v3/coins/markets?b=x+y&vs_currency=usd');
  assert.equal(m.calls[0]!.headers['x-cg-demo-api-key'], KEY);
  assert.ok(!m.calls[0]!.url.includes(KEY));
});

test('HTTP errors, invalid JSON and network failures produce clear errors without the key', async () => {
  await expectError(client(mockFetch([{ status: 500 }]).fn).getJson('/p'), 'http');
  const e401 = await expectError(client(mockFetch([{ status: 401 }]).fn).getJson('/p'), 'http');
  assert.equal(e401.status, 401);
  await expectError(client(mockFetch([{ status: 200, body: '<html>' }]).fn).getJson('/p'), 'invalid_json');
  await expectError(client(mockFetch(['throw']).fn).getJson('/p'), 'network');
});

test('a hanging request times out', async () => {
  await expectError(client(mockFetch(['hang']).fn, { timeoutMs: 20 }).getJson('/slow'), 'timeout');
});

test('429 with Retry-After is retried exactly once, after the stated wait', async () => {
  const waits: number[] = [];
  const m = mockFetch([{ status: 429, headers: { 'retry-after': '2' } }, { status: 200, body: '[1]' }]);
  assert.deepEqual(await client(m.fn, { sleep: async (ms) => { waits.push(ms); } }).getJson('/p'), [1]);
  assert.deepEqual(waits, [2000]);
  assert.equal(m.calls.length, 2);
});

test('429 twice, or 429 without a usable Retry-After, fails without further retries', async () => {
  const twice = mockFetch([{ status: 429, headers: { 'retry-after': '1' } }, { status: 429, headers: { 'retry-after': '1' } }, { status: 200, body: '[]' }]);
  await expectError(client(twice.fn).getJson('/p'), 'rate_limited');
  assert.equal(twice.calls.length, 2);
  const none = mockFetch([{ status: 429 }, { status: 200, body: '[]' }]);
  await expectError(client(none.fn).getJson('/p'), 'rate_limited');
  assert.equal(none.calls.length, 1);
  const tooLong = mockFetch([{ status: 429, headers: { 'retry-after': '3600' } }]);
  await expectError(client(tooLong.fn).getJson('/p'), 'rate_limited');
  assert.equal(tooLong.calls.length, 1);
});

test('the call budget counts retries and stops requests before they are made', async () => {
  const m = mockFetch([{ status: 429, headers: { 'retry-after': '0' } }, { status: 200, body: '1' }, { status: 200, body: '2' }]);
  const c = client(m.fn, { maxCalls: 2 });
  assert.equal(await c.getJson('/a'), 1);
  await expectError(c.getJson('/b'), 'budget');
  assert.equal(m.calls.length, 2);
  assert.equal(c.callsMade, 2);
});

test('Retry-After accepts seconds or an HTTP date', () => {
  assert.equal(parseRetryAfter('5'), 5000);
  assert.equal(parseRetryAfter('Wed, 21 Oct 2026 12:00:10 GMT', Date.parse('2026-10-21T12:00:00Z')), 10_000);
  assert.equal(parseRetryAfter('soon'), null);
  assert.equal(parseRetryAfter(null), null);
});

test('a client cannot be created without a key', () => {
  assert.throws(() => client(mockFetch([]).fn, { apiKey: '' }), /API key is required/);
});
