import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createFileHistoryCache, historyCacheDir, isFreshHistory } from '../src/providers/history-cache.ts';

// Network guard: the cache is purely local.
globalThis.fetch = (() => {
  throw new Error('Network access is not allowed in tests.');
}) as typeof fetch;

// SYNTHETIC volume points; the cache stores them unchanged.
const NOW = new Date('2026-10-21T12:00:00Z');
const POINTS = [[Date.UTC(2026, 9, 19), 1e6], [Date.UTC(2026, 9, 20), 2e6]];

function withDir(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'history-cache-test-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('cache hit: a history stored earlier this UTC day is returned unchanged; a missing one is a miss', () => {
  withDir((dir) => {
    const cache = createFileHistoryCache(join(dir, 'nested', 'cache')); // created on first write
    assert.equal(cache.get('syn-a', 91, NOW), null);
    assert.equal(cache.set('syn-a', 91, new Date('2026-10-21T08:00:00Z'), POINTS), true);
    assert.deepEqual(cache.get('syn-a', 91, NOW), { fetchedAt: '2026-10-21T08:00:00.000Z', totalVolumes: POINTS });
    assert.equal(cache.get('syn-b', 91, NOW), null);
  });
});

test('expiration: entries from an earlier UTC day, just after midnight, or in the future are never reused', () => {
  assert.equal(isFreshHistory(new Date('2026-10-21T00:15:00Z'), NOW), true); // first reusable moment
  assert.equal(isFreshHistory(new Date('2026-10-21T00:14:59Z'), NOW), false); // may lack yesterday's point
  assert.equal(isFreshHistory(new Date('2026-10-20T23:59:59Z'), NOW), false); // previous UTC day
  assert.equal(isFreshHistory(new Date('2026-10-21T12:00:01Z'), NOW), false); // after "now"
  assert.equal(isFreshHistory(new Date('not a date'), NOW), false);
  withDir((dir) => {
    const cache = createFileHistoryCache(dir);
    cache.set('syn-a', 91, new Date('2026-10-21T08:00:00Z'), POINTS);
    assert.notEqual(cache.get('syn-a', 91, NOW), null);
    assert.equal(cache.get('syn-a', 91, new Date('2026-10-22T08:00:00Z')), null); // next UTC day: stale
  });
});

test('mismatched, corrupt or foreign entries are misses, never errors', () => {
  withDir((dir) => {
    const cache = createFileHistoryCache(dir);
    cache.set('syn-a', 91, new Date('2026-10-21T08:00:00Z'), POINTS);
    assert.equal(cache.get('syn-a', 120, NOW), null); // different request length
    const [file] = readdirSync(dir);
    for (const body of ['{not json', JSON.stringify({ version: 2 }), JSON.stringify({ version: 1, id: 'syn-other', days: 91, fetchedAt: '2026-10-21T08:00:00Z', totalVolumes: [] }), JSON.stringify({ version: 1, id: 'syn-a', days: 91, fetchedAt: '2026-10-21T08:00:00Z', totalVolumes: 'x' })]) {
      writeFileSync(join(dir, file!), body);
      assert.equal(cache.get('syn-a', 91, NOW), null, body);
    }
  });
});

test('ids never become paths, and a write failure is reported, not thrown', () => {
  withDir((dir) => {
    const cache = createFileHistoryCache(dir);
    assert.equal(cache.set('../../escape\u0000id', 91, new Date('2026-10-21T08:00:00Z'), POINTS), true);
    assert.deepEqual(readdirSync(dir).map((f) => /^[0-9a-f]{32}\.json$/.test(f)), [true]);
    assert.notEqual(cache.get('../../escape\u0000id', 91, NOW), null);
    // The cache "directory" is a file: writing fails cleanly.
    const blocked = join(dir, 'blocked');
    writeFileSync(blocked, 'x');
    assert.equal(createFileHistoryCache(blocked).set('syn-a', 91, new Date('2026-10-21T08:00:00Z'), POINTS), false);
  });
});

test('the cache directory is local and outside the project; with no known location the cache is off', () => {
  assert.equal(historyCacheDir({ LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }), join('C:\\Users\\x\\AppData\\Local', 'market-scanner', 'coingecko-history'));
  assert.equal(historyCacheDir({ HOME: '/home/x' }), join('/home/x', '.cache', 'market-scanner', 'coingecko-history'));
  assert.equal(historyCacheDir({}), null);
});
